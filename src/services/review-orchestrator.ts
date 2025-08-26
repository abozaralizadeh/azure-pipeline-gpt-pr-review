import * as tl from "azure-pipelines-task-lib/task";
import { Agent } from 'node:https';
import { AdvancedPRReviewAgent, PRReviewStateType } from '../agents/pr-review-agent';
import { AzureDevOpsService, PRDetails, FileContent } from './azure-devops-service';
import { getTargetBranchName } from '../utils';

export interface ReviewResult {
  success: boolean;
  totalFilesReviewed: number;
  totalComments: number;
  llmCallsUsed: number;
  maxLLMCalls: number;
  reviewSummary: string;
  requiresChanges: boolean;
  canApprove: boolean;
}

export class ReviewOrchestrator {
  private azureDevOpsService: AzureDevOpsService;
  private reviewAgent: AdvancedPRReviewAgent;
  private httpsAgent: Agent;
  private maxLLMCalls: number;
  private reviewThreshold: number;
  private enableCodeSuggestions: boolean;
  private enableSecurityScanning: boolean;

  constructor(
    httpsAgent: Agent,
    azureOpenAIEndpoint: string,
    azureOpenAIKey: string,
    deploymentName: string,
    maxLLMCalls: number = 100,
    reviewThreshold: number = 0.7,
    enableCodeSuggestions: boolean = true,
    enableSecurityScanning: boolean = true
  ) {
    this.httpsAgent = httpsAgent;
    this.azureDevOpsService = new AzureDevOpsService(httpsAgent);
    this.reviewAgent = new AdvancedPRReviewAgent(
      azureOpenAIEndpoint,
      azureOpenAIKey,
      deploymentName,
      maxLLMCalls,
      reviewThreshold
    );
    this.maxLLMCalls = maxLLMCalls;
    this.reviewThreshold = reviewThreshold;
    this.enableCodeSuggestions = enableCodeSuggestions;
    this.enableSecurityScanning = enableSecurityScanning;
  }

  public async runFullReview(): Promise<ReviewResult> {
    try {
      console.log("🚀 Starting Advanced PR Review Process...");
      
      // Step 1: Validate PR context
      if (tl.getVariable('Build.Reason') !== 'PullRequest') {
        throw new Error("This task should only run when triggered from a Pull Request.");
      }

      // Step 2: Test API connectivity first
      await this.azureDevOpsService.testCorrectedUrlStructure();
      await this.azureDevOpsService.testBaseUrlConnectivity();
      await this.azureDevOpsService.testApiConnectivity();
      
      // Step 3: Get PR details and context
      const prDetails = await this.azureDevOpsService.getPullRequestDetails();
      console.log(`📋 Reviewing PR: ${prDetails.title}`);
      console.log(`👤 Author: ${prDetails.createdBy.displayName}`);
      console.log(`🔄 Source: ${prDetails.sourceRefName} → Target: ${prDetails.targetRefName}`);

      // Step 4: Get target branch
      const targetBranch = getTargetBranchName();
      if (!targetBranch) {
        throw new Error("No target branch found!");
      }

      // Step 5: Clean up existing comments
      await this.azureDevOpsService.deleteExistingComments();

      // Step 6: Get changed files
      const changedFiles = await this.azureDevOpsService.getChangedFiles();
      console.log(`📁 Found ${changedFiles.length} changed files`);

      if (changedFiles.length === 0) {
        console.log("✅ No files to review");
        return this.createEmptyReviewResult();
      }

      // Step 7: Review each file
      const reviewResults = await this.reviewFiles(changedFiles, targetBranch, prDetails);

      // Step 8: Generate final summary
      const finalSummary = await this.generateFinalSummary(reviewResults, prDetails);

      // Step 9: Post results to Azure DevOps
      await this.postReviewResults(reviewResults, finalSummary);

      // Step 10: Return comprehensive result
      return this.createReviewResult(reviewResults, finalSummary);

    } catch (error: any) {
      console.error("❌ Review process failed:", error.message);
      throw error;
    }
  }

  private async reviewFiles(
    changedFiles: string[],
    targetBranch: string,
    prDetails: PRDetails
  ): Promise<PRReviewStateType[]> {
    const reviewResults: PRReviewStateType[] = [];
    let totalLLMCalls = 0;

    for (const filePath of changedFiles) {
      try {
        console.log(`🔍 Reviewing file: ${filePath}`);

        // Skip binary files
        if (this.isBinaryFile(filePath)) {
          console.log(`⏭️  Skipping binary file: ${filePath}`);
          continue;
        }

        // Get file content and diff
        const fileContent = await this.azureDevOpsService.getFileContent(filePath, targetBranch);
        const fileDiff = await this.azureDevOpsService.getFileDiff(filePath, targetBranch, prDetails.sourceRefName);

        if (fileContent.isBinary) {
          console.log(`⏭️  Skipping binary file content: ${filePath}`);
          continue;
        }

        // Check if we've exceeded LLM call limit
        if (totalLLMCalls >= this.maxLLMCalls) {
          console.log(`⚠️  Maximum LLM calls (${this.maxLLMCalls}) reached. Stopping review.`);
          break;
        }

        // Create PR context for the agent
        const prContext = {
          title: prDetails.title,
          description: prDetails.description,
          author: prDetails.createdBy.displayName,
          target_branch: prDetails.targetRefName,
          source_branch: prDetails.sourceRefName,
          changed_files: changedFiles
        };

        // Run the review agent
        const reviewResult = await this.reviewAgent.runReview(
          fileContent.content,
          fileDiff,
          filePath,
          prContext
        );

        reviewResults.push(reviewResult);
        totalLLMCalls += reviewResult.llm_calls;

        console.log(`✅ File ${filePath} reviewed. LLM calls used: ${reviewResult.llm_calls}`);

      } catch (error: any) {
        console.error(`❌ Error reviewing file ${filePath}:`, error.message);
        // Continue with other files
      }
    }

    return reviewResults;
  }

  private async generateFinalSummary(
    reviewResults: PRReviewStateType[],
    prDetails: PRDetails
  ): Promise<any> {
    console.log("📊 Generating final review summary...");

    const allComments = reviewResults.flatMap(result => result.review_comments);
    const totalIssues = allComments.length;
    const criticalIssues = allComments.filter(comment => 
      comment.type === 'security' || comment.type === 'bug'
    ).length;

    let overallAssessment = 'approve';
    let requiresChanges = false;

    if (criticalIssues > 0) {
      overallAssessment = 'request_changes';
      requiresChanges = true;
    } else if (totalIssues > 5) {
      overallAssessment = 'approve_with_suggestions';
    }

    const summary = {
      overall_assessment: overallAssessment,
      total_files_reviewed: reviewResults.length,
      total_issues_found: totalIssues,
      critical_issues: criticalIssues,
      security_issues: allComments.filter(c => c.type === 'security').length,
      bug_issues: allComments.filter(c => c.type === 'bug').length,
      improvement_issues: allComments.filter(c => c.type === 'improvement').length,
      style_issues: allComments.filter(c => c.type === 'style').length,
      test_issues: allComments.filter(c => c.type === 'test').length,
      requires_changes: requiresChanges,
      can_approve: !requiresChanges,
      summary: this.generateSummaryText(allComments, prDetails),
      recommendations: this.generateRecommendations(allComments)
    };

    return summary;
  }

  private async postReviewResults(
    reviewResults: PRReviewStateType[],
    finalSummary: any
  ): Promise<void> {
    console.log("💬 Posting review results to Azure DevOps...");

    // Post final summary as a general comment
    const summaryComment = this.formatSummaryComment(finalSummary);
    await this.azureDevOpsService.addGeneralComment(summaryComment);

    // Post individual file comments
    for (const result of reviewResults) {
      for (const comment of result.review_comments) {
        if (comment.file === 'PR_CONTEXT' || comment.file === 'FINAL_ASSESSMENT') {
          continue; // Skip context and final assessment comments
        }

        try {
          if (comment.line && comment.line > 0) {
            // Post as inline comment
            await this.azureDevOpsService.addInlineComment(
              comment.file,
              this.formatComment(comment),
              comment.line
            );
          } else {
            // Post as general comment for the file
            const fileComment = `**File: ${comment.file}**\n\n${this.formatComment(comment)}`;
            await this.azureDevOpsService.addGeneralComment(fileComment);
          }
        } catch (error: any) {
          console.error(`❌ Error posting comment for ${comment.file}:`, error.message);
        }
      }
    }
  }

  private formatComment(comment: any): string {
    let formattedComment = `**${comment.type.toUpperCase()}** (Confidence: ${Math.round(comment.confidence * 100)}%)\n\n${comment.comment}`;
    
    if (comment.suggestion) {
      formattedComment += `\n\n💡 **Suggestion:**\n${comment.suggestion}`;
    }

    return formattedComment;
  }

  private formatSummaryComment(summary: any): string {
    return `## 🔍 PR Review Summary

**Overall Assessment:** ${summary.overall_assessment.toUpperCase()}
**Status:** ${summary.requires_changes ? '❌ Changes Required' : '✅ Ready for Review'}

### 📊 Review Statistics
- **Files Reviewed:** ${summary.total_files_reviewed}
- **Total Issues Found:** ${summary.total_issues_found}
- **Critical Issues:** ${summary.critical_issues}
- **Security Issues:** ${summary.security_issues}
- **Bug Issues:** ${summary.bug_issues}
- **Improvement Issues:** ${summary.improvement_issues}
- **Style Issues:** ${summary.style_issues}
- **Test Issues:** ${summary.test_issues}

### 📝 Summary
${summary.summary}

### 💡 Recommendations
${summary.recommendations}

---
*This review was performed by Advanced PR Reviewer using Azure OpenAI and LangGraph*`;
  }

  private generateSummaryText(comments: any[], prDetails: PRDetails): string {
    if (comments.length === 0) {
      return "No issues found. The code appears to be well-written and follows best practices.";
    }

    const criticalIssues = comments.filter(c => c.type === 'security' || c.type === 'bug');
    const improvementIssues = comments.filter(c => c.type === 'improvement' || c.type === 'style');

    let summary = `Found ${comments.length} issues that need attention. `;

    if (criticalIssues.length > 0) {
      summary += `There are ${criticalIssues.length} critical issues that must be addressed before approval. `;
    }

    if (improvementIssues.length > 0) {
      summary += `There are ${improvementIssues.length} improvement suggestions to enhance code quality. `;
    }

    summary += `Overall, the PR ${criticalIssues.length > 0 ? 'requires changes' : 'can be approved with suggestions'}.`;

    return summary;
  }

  private generateRecommendations(comments: any[]): string {
    if (comments.length === 0) {
      return "No specific recommendations at this time.";
    }

    const recommendations = [];

    const securityIssues = comments.filter(c => c.type === 'security');
    if (securityIssues.length > 0) {
      recommendations.push(`🔒 Address ${securityIssues.length} security vulnerabilities before merging`);
    }

    const bugIssues = comments.filter(c => c.type === 'bug');
    if (bugIssues.length > 0) {
      recommendations.push(`🐛 Fix ${bugIssues.length} identified bugs to ensure functionality`);
    }

    const testIssues = comments.filter(c => c.type === 'test');
    if (testIssues.length > 0) {
      recommendations.push(`🧪 Add or improve tests for better code coverage`);
    }

    const styleIssues = comments.filter(c => c.type === 'style');
    if (styleIssues.length > 0) {
      recommendations.push(`🎨 Consider code style improvements for better readability`);
    }

    return recommendations.join('\n');
  }

  private isBinaryFile(filePath: string): boolean {
    const binaryExtensions = [
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.rar', '.7z', '.tar', '.gz',
      '.exe', '.dll', '.so', '.dylib', '.jar', '.war',
      '.mp3', '.mp4', '.avi', '.mov', '.wav'
    ];

    return binaryExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
  }

  private createEmptyReviewResult(): ReviewResult {
    return {
      success: true,
      totalFilesReviewed: 0,
      totalComments: 0,
      llmCallsUsed: 0,
      maxLLMCalls: this.maxLLMCalls,
      reviewSummary: "No files to review",
      requiresChanges: false,
      canApprove: true
    };
  }

  private createReviewResult(
    reviewResults: PRReviewStateType[],
    finalSummary: any
  ): ReviewResult {
    const totalComments = reviewResults.flatMap(result => result.review_comments).length;
    const totalLLMCalls = reviewResults.reduce((sum, result) => sum + result.llm_calls, 0);

    return {
      success: true,
      totalFilesReviewed: reviewResults.length,
      totalComments: totalComments,
      llmCallsUsed: totalLLMCalls,
      maxLLMCalls: this.maxLLMCalls,
      reviewSummary: finalSummary.summary,
      requiresChanges: finalSummary.requires_changes,
      canApprove: finalSummary.can_approve
    };
  }
}
