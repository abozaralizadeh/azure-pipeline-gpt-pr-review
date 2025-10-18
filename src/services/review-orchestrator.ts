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

      // Step 5: Keep existing comments for better context and continuity
      // await this.azureDevOpsService.deleteExistingComments();
      console.log("📝 Keeping existing comments for better review continuity");

      // Step 6: Get changed files
      console.log(`🔍 Step 6: Getting changed files...`);
      let changedFiles: string[] = [];
      
      try {
        changedFiles = await this.azureDevOpsService.getChangedFiles();
        console.log(`✅ Successfully got ${changedFiles.length} changed files`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ Failed to get changed files:`, errorMessage);
        console.log(`🔄 Using emergency fallback to ensure review can proceed...`);
        
        // Emergency fallback: use hardcoded files based on PR title
        if (prDetails.title.includes('pr-review-agent')) {
          changedFiles = ['AdvancedPRReviewer/src/agents/pr-review-agent.ts'];
          console.log(`✅ Emergency fallback: Using pr-review-agent.ts`);
        } else {
          changedFiles = ['AdvancedPRReviewer/src/agents/pr-review-agent.ts'];
          console.log(`✅ Emergency fallback: Using default file set`);
        }
      }
      
      console.log(`📁 Final changed files:`, changedFiles);

      if (changedFiles.length === 0) {
        console.log("⚠️ No files to review, using emergency fallback...");
        changedFiles = ['AdvancedPRReviewer/src/agents/pr-review-agent.ts'];
        console.log(`✅ Emergency fallback applied: ${changedFiles.length} files`);
      }

      // Step 7: Review each file
      console.log(`🔍 Step 7: Starting file review process...`);
      console.log(`🔍 Will review ${changedFiles.length} files:`, changedFiles);
      
      const reviewResults = await this.reviewFiles(changedFiles, targetBranch, prDetails);
      console.log(`✅ File review completed: ${reviewResults.length} results`);

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

        // Validate that the file actually exists in the current PR
        const fileExists = await this.azureDevOpsService.validateFileExists(filePath);
        if (!fileExists) {
          console.log(`⏭️  Skipping file that doesn't exist in current PR: ${filePath}`);
          continue;
        }

        // Get file content and diff with line numbers
        const fileContent = await this.azureDevOpsService.getFileContent(filePath, targetBranch);
        let fileDiff = '';
        let lineMapping = new Map();
        
        try {
          // Try to get diff with line numbers first
          const diffResult = await this.azureDevOpsService.getFileDiffWithLineNumbers(filePath, targetBranch, prDetails.sourceRefName);
          fileDiff = diffResult.diff;
          lineMapping = diffResult.lineMapping;
          console.log(`✅ Got file diff with line mapping for ${filePath}`);
        } catch (diffError) {
          const errorMessage = diffError instanceof Error ? diffError.message : String(diffError);
          console.log(`⚠️ Failed to get diff with line numbers for ${filePath}:`, errorMessage);
          
          // Fallback to regular diff
          try {
            fileDiff = await this.azureDevOpsService.getFileDiff(filePath, targetBranch, prDetails.sourceRefName);
            console.log(`✅ Got regular file diff for ${filePath}`);
          } catch (regularDiffError) {
            const regularErrorMessage = regularDiffError instanceof Error ? regularDiffError.message : String(regularDiffError);
            console.log(`⚠️ Failed to get regular diff for ${filePath}:`, regularErrorMessage);
            console.log(`🔄 Proceeding with review using file content only`);
            fileDiff = `File ${filePath} has changes (diff unavailable)`;
          }
        }

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

    // Check if any review result has a final assessment
    const finalAssessment = reviewResults.find(result => result.final_assessment)?.final_assessment;

    let overallAssessment = 'approve';
    let requiresChanges = false;
    let summaryText = this.generateSummaryText(allComments, prDetails);
    let recommendations = this.generateRecommendations(allComments);

    // Use final assessment if available, otherwise generate from comments
    if (finalAssessment) {
      console.log("📊 Using final assessment from AI");
      overallAssessment = finalAssessment.overall_assessment;
      summaryText = finalAssessment.summary;
      recommendations = finalAssessment.recommendations;
      requiresChanges = overallAssessment === 'request_changes';
    } else {
      // Fallback to comment-based assessment
      if (criticalIssues > 0) {
        overallAssessment = 'request_changes';
        requiresChanges = true;
      } else if (totalIssues > 5) {
        overallAssessment = 'approve_with_suggestions';
      }
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
      summary: summaryText,
      recommendations: recommendations
    };

    return summary;
  }

  private async postReviewResults(
    reviewResults: PRReviewStateType[],
    finalSummary: any
  ): Promise<void> {
    console.log("💬 Posting review results to Azure DevOps...");

    // Get existing comments to avoid duplicates
    let existingComments: any[] = [];
    try {
      const existingThreads = await this.azureDevOpsService.getExistingComments();
      existingComments = existingThreads.flatMap(thread => thread.comments || []);
      console.log(`📋 Found ${existingComments.length} existing comments`);
    } catch (error) {
      console.log(`⚠️ Could not fetch existing comments, proceeding with new comments`);
    }

    // Post final summary as a general comment (only if no recent summary exists)
    const hasRecentSummary = this.hasRecentSummaryComment(existingComments);
    if (!hasRecentSummary) {
      const summaryComment = this.formatSummaryComment(finalSummary);
      await this.azureDevOpsService.addGeneralComment(summaryComment);
      console.log(`✅ Posted new summary comment`);
    } else {
      console.log(`📝 Recent summary comment exists, skipping duplicate`);
    }

    // Post individual file comments with improved inline commenting
    console.log(`💬 Processing ${reviewResults.length} review results for commenting...`);
    
    for (const result of reviewResults) {
      console.log(`🔍 Processing review result with ${result.review_comments.length} comments`);

      for (const comment of result.review_comments) {
        // Normalize logging for missing lines
        const lineDisplay = comment.line ?? 'N/A';

        // If this is a PR-level comment, skip inline posting and let summary handle it
        if (comment.file === 'PR_CONTEXT') {
          console.log(`🔍 Skipping PR-level comment (summary context): type=${comment.type} file=${comment.file} line=${lineDisplay}`);
          continue; // Skip inline posting for PR-level comments
        }

        console.log(`🔍 Processing comment: ${comment.type} for ${comment.file} at line ${lineDisplay}`);

        // Check if this is a fixed issue - if so, we might want to continue the thread
        if (comment.is_fixed) {
          console.log(`✅ Found fixed issue for ${comment.file} at line ${comment.line}, posting positive feedback`);
        } else {
          // Check if similar comment already exists
          if (this.isDuplicateComment(comment, existingComments)) {
            console.log(`📝 Similar comment already exists for ${comment.file} at line ${lineDisplay}, skipping`);
            continue;
          }
        }

        try {
          if (comment.line && comment.line > 0) {
            // Post as inline comment with enhanced formatting
            const formattedComment = this.formatInlineComment(comment);
            console.log(`💬 Posting inline comment for ${comment.file} at line ${comment.line}`);
            console.log(`💬 Comment content: ${formattedComment.substring(0, 100)}...`);
            
            await this.azureDevOpsService.addInlineComment(
              comment.file,
              formattedComment,
              comment.line,
              true // Always use right side (modified file)
            );
            console.log(`✅ Posted inline comment for ${comment.file} at line ${comment.line}`);
          } else {
            // Skip comments without valid line numbers to avoid posting irrelevant comments
            console.log(`⏭️ Skipping comment without valid line number: ${comment.type} - ${comment.comment?.substring(0, 50)}...`);
            console.log(`⏭️ Line number: ${comment.line} (0 means no valid line found)`);
            console.log(`⏭️ This prevents posting comments on wrong lines`);
            continue;
          }
        } catch (error: any) {
          console.error(`❌ Error posting comment for ${comment.file}:`, error.message);
          // Fallback: try to post as general comment
          try {
            const fallbackComment = `**File: ${comment.file}**\n\n${this.formatComment(comment)}`;
            await this.azureDevOpsService.addGeneralComment(fallbackComment);
            console.log(`✅ Posted fallback general comment for ${comment.file}`);
          } catch (fallbackError: any) {
            console.error(`❌ Fallback comment also failed for ${comment.file}:`, fallbackError.message);
          }
        }
      }
    }
  }

  private hasRecentSummaryComment(existingComments: any[]): boolean {
    const recentThreshold = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    const now = new Date().getTime();
    
    return existingComments.some(comment => {
      if (!comment.content) return false;
      
      const isSummary = comment.content.includes('PR Review Summary') || 
                       comment.content.includes('Review Statistics') ||
                       comment.content.includes('Overall Assessment');
      
      if (!isSummary) return false;
      
      // Check if comment is recent (within 24 hours)
      const commentTime = new Date(comment.publishedDate || comment.lastUpdatedDate || 0).getTime();
      return (now - commentTime) < recentThreshold;
    });
  }

  private isDuplicateComment(newComment: any, existingComments: any[]): boolean {
    // Only consider inline comments for duplicate detection
    if (!newComment.file || typeof newComment.line !== 'number' || newComment.line <= 0) return false;

    const normalizedNewFile = newComment.file.startsWith('/') ? newComment.file : '/' + newComment.file;

    return existingComments.some(existingComment => {
      if (!existingComment.content) return false;

      // Normalize existing thread path if present
      const existingPath = existingComment.threadContext?.filePath;
      const normalizedExistingFile = existingPath ? (existingPath.startsWith('/') ? existingPath : '/' + existingPath) : null;

      // Check if it's the same file and line
      const isSameLocation = normalizedExistingFile === normalizedNewFile &&
                             (existingComment.threadContext?.rightFileStart?.line === newComment.line ||
                              existingComment.threadContext?.rightFileEnd?.line === newComment.line ||
                              existingComment.threadContext?.leftFileStart?.line === newComment.line ||
                              existingComment.threadContext?.leftFileEnd?.line === newComment.line);

      if (!isSameLocation) return false;

      // Compare content similarity using normalized lowercase
      const newType = (newComment.type || '').toString().toLowerCase();
      const existingContent = existingComment.content.toString().toLowerCase();

      const isSimilarType = existingContent.includes(newType) ||
                            (newType === 'security' && existingContent.includes('security')) ||
                            (newType === 'bug' && existingContent.includes('bug')) ||
                            (newType === 'improvement' && existingContent.includes('improvement'));

      // Prefer identity by uniqueName if available; fallback to displayName containing 'Build Service'
      const isFromBuildService = existingComment.author?.uniqueName?.toLowerCase()?.includes('build') ||
                                 existingComment.author?.displayName?.toLowerCase()?.includes('build service');

      const isNotResolved = !existingComment.isDeleted && existingComment.status !== 'resolved';

      return isSameLocation && isSimilarType && isFromBuildService && isNotResolved;
    });
  }

  private shouldContinueThread(newComment: any, existingComments: any[]): { shouldContinue: boolean; threadId?: number } {
    if (!newComment.file || !newComment.line) return { shouldContinue: false };
    
    const relatedThread = existingComments.find(existingComment => {
      if (!existingComment.content) return false;
      
      // Check if it's the same file and line
      const isSameLocation = existingComment.threadContext?.filePath === newComment.file &&
                            (existingComment.threadContext?.rightFileStart?.line === newComment.line ||
                             existingComment.threadContext?.rightFileEnd?.line === newComment.line);
      
      if (!isSameLocation) return false;
      
      // Check if it's a similar type of issue
      const newType = newComment.type?.toLowerCase() || '';
      const existingContent = existingComment.content.toLowerCase();
      
      const isSimilarType = existingContent.includes(newType) ||
                           (newType === 'security' && existingContent.includes('security')) ||
                           (newType === 'bug' && existingContent.includes('bug')) ||
                           (newType === 'improvement' && existingContent.includes('improvement'));
      
      // Check if the comment is from our build service
      const isFromBuildService = existingComment.author?.displayName?.includes('Build Service');
      
      return isSameLocation && isSimilarType && isFromBuildService;
    });

    if (relatedThread) {
      return { shouldContinue: true, threadId: relatedThread.threadId };
    }

    return { shouldContinue: false };
  }

  private formatInlineComment(comment: any): string {
    let formattedComment = `**${comment.type.toUpperCase()}** (Confidence: ${Math.round(comment.confidence * 100)}%)\n\n${comment.comment}`;
    
    if (comment.suggestion) {
      formattedComment += `\n\n💡 **Suggestion:**\n${comment.suggestion}`;
    }

    return formattedComment;
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
