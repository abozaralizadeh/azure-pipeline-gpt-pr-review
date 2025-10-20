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
  private fileLineMappings: Map<string, Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext: boolean }>> = new Map();
  private fallbackGeneralCommentFiles: Set<string> = new Set();

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
    this.fileLineMappings.clear();

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

        // Detect and skip folder-like responses (Azure DevOps returns a JSON tree for folders)
        const rawContentPreview = (fileContent.content || '').substring(0, 200);
        if (rawContentPreview.includes('"gitObjectType"') && rawContentPreview.includes('"tree"')) {
          console.log(`⏭️  Skipping folder/non-file path: ${filePath} (returned tree metadata)`);
          continue;
        }
        let fileDiff = '';
        let lineMapping: Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext: boolean }> = new Map();
        
        try {
          // Normalize source branch name (strip refs/heads/) for API calls
          const cleanSource = prDetails.sourceRefName ? prDetails.sourceRefName.replace('refs/heads/', '') : prDetails.sourceRefName;

          // Try to get diff with line numbers first
          const diffResult = await this.azureDevOpsService.getFileDiffWithLineNumbers(filePath, targetBranch, cleanSource);
          fileDiff = diffResult.diff;
          lineMapping = diffResult.lineMapping;
          console.log(`✅ Got file diff with line mapping for ${filePath}`);
        } catch (diffError) {
          const errorMessage = diffError instanceof Error ? diffError.message : String(diffError);
          console.log(`⚠️ Failed to get diff with line numbers for ${filePath}:`, errorMessage);
          
          // Fallback to regular diff
          try {
            // Try again with normalized source branch
            const cleanSource = prDetails.sourceRefName ? prDetails.sourceRefName.replace('refs/heads/', '') : prDetails.sourceRefName;
            fileDiff = await this.azureDevOpsService.getFileDiff(filePath, targetBranch, cleanSource);
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

        // If diff is empty or no lineMapping entries, build a best-effort unified diff from file contents
        if ((!fileDiff || fileDiff.length === 0) || (lineMapping && (lineMapping.size === 0))) {
          try {
            const cleanSource = prDetails.sourceRefName ? prDetails.sourceRefName.replace('refs/heads/', '') : prDetails.sourceRefName;
            const sourceContent = await this.azureDevOpsService.getFileContent(filePath, cleanSource);
            const targetContent = await this.azureDevOpsService.getFileContent(filePath, targetBranch);

            const sourceLines = (sourceContent.content || '').split('\n');
            const targetLines = (targetContent.content || '').split('\n');
            const maxLines = Math.max(sourceLines.length, targetLines.length);

            // Build a single hunk unified-style diff so the agent can parse changed lines
            const diffLines: string[] = [];
            diffLines.push(`@@ -1,${targetLines.length} +1,${sourceLines.length} @@`);
            for (let i = 0; i < maxLines; i++) {
              const t = targetLines[i];
              const s = sourceLines[i];
              if (t === s) {
                diffLines.push(` ${t === undefined ? '' : t}`);
              } else {
                if (t !== undefined) diffLines.push(`- ${t}`);
                if (s !== undefined) diffLines.push(`+ ${s}`);
              }
            }

            const fallbackDiff = diffLines.join('\n');
            // Replace fileDiff and allow the agent to compute added lines from it
            fileDiff = fallbackDiff;
            try {
              lineMapping = this.azureDevOpsService.createLineMappingFromDiff(fileDiff);
            } catch (mappingErr) {
              console.log(`⚠️ Failed to build line mapping from fallback diff for ${filePath}:`, mappingErr instanceof Error ? mappingErr.message : String(mappingErr));
            }
            console.log(`🔧 Built fallback unified diff for ${filePath} (size: ${fileDiff.length} chars)`);
          } catch (fallbackErr) {
            console.log(`⚠️ Failed to build fallback diff for ${filePath}:`, fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
          }
        }

        // Additionally: if the diff exists but doesn't look like a unified diff (no hunks or +/- lines),
        // build a fallback unified diff to ensure the agent can extract changed lines.
        try {
          const hasHunk = fileDiff && /@@ -\d+,?\d* \+\d+,?\d* @@/m.test(fileDiff);
          // Only consider explicit unified-diff markers (+ or - at start of a line).
          // Previously we treated lines starting with a space as a sign of unified diff which
          // produced false positives when raw file content had leading spaces. Ensure we only
          // treat plus/minus prefixes as diff indicators so the fallback builder runs when
          // fileDiff is actually raw file content.
          const hasPlusMinus = fileDiff && /^(\+|\-)/m.test(fileDiff);
          if (fileDiff && !(hasHunk || hasPlusMinus)) {
            console.log(`🔍 Diff for ${filePath} doesn't contain unified hunks or +/-, building fallback unified diff`);
            const cleanSource = prDetails.sourceRefName ? prDetails.sourceRefName.replace('refs/heads/', '') : prDetails.sourceRefName;
            const sourceContent = await this.azureDevOpsService.getFileContent(filePath, cleanSource);
            const targetContent = await this.azureDevOpsService.getFileContent(filePath, targetBranch);

            const sourceLines = (sourceContent.content || '').split('\n');
            const targetLines = (targetContent.content || '').split('\n');
            const maxLines = Math.max(sourceLines.length, targetLines.length);

            const diffLines: string[] = [];
            diffLines.push(`@@ -1,${targetLines.length} +1,${sourceLines.length} @@`);
            for (let i = 0; i < maxLines; i++) {
              const t = targetLines[i];
              const s = sourceLines[i];
              if (t === s) {
                diffLines.push(` ${t === undefined ? '' : t}`);
              } else {
                if (t !== undefined) diffLines.push(`- ${t}`);
                if (s !== undefined) diffLines.push(`+ ${s}`);
              }
            }

            fileDiff = diffLines.join('\n');
            try {
              lineMapping = this.azureDevOpsService.createLineMappingFromDiff(fileDiff);
            } catch (mappingErr) {
              console.log(`⚠️ Failed to rebuild line mapping after fallback diff for ${filePath}:`, mappingErr instanceof Error ? mappingErr.message : String(mappingErr));
            }
            console.log(`🔧 Replaced fileDiff with fallback unified diff for ${filePath} (size: ${fileDiff.length} chars)`);
          }
        } catch (err) {
          console.log(`⚠️ Error while checking/building fallback diff for ${filePath}:`, err instanceof Error ? err.message : String(err));
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
        const normalizedFilePath = filePath.startsWith('/') ? filePath : '/' + filePath;
        this.fileLineMappings.set(normalizedFilePath, lineMapping);
        // Debug logging: file sizes and diff info before LLM call
        try {
          console.log(`🔎 Preparing to call review agent for ${filePath}`);
          console.log(`  - File content size: ${fileContent.content?.length || 0} chars`);
          console.log(`  - File diff size: ${fileDiff?.length || 0} chars`);
          console.log(`  - Line mapping entries: ${lineMapping ? (lineMapping.size || 0) : 0}`);
        } catch (dbgErr) {
          console.log('⚠️ Failed to log debug info before LLM call', dbgErr);
        }

        const reviewResult = await this.reviewAgent.runReview(
          fileContent.content,
          fileDiff,
          filePath,
          prContext,
          lineMapping // pass mapping so agent can fall back to it when diff parsing fails
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
    this.fallbackGeneralCommentFiles.clear();

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
    
    // Collect inline comments per file so we can coalesce contiguous lines into ranges
    const inlineCommentsByFile: Map<string, any[]> = new Map();

    for (const result of reviewResults) {
      for (const comment of result.review_comments) {
        if (!comment || comment.file === 'PR_CONTEXT') continue;
        if (!comment.line || typeof comment.line !== 'number' || comment.line <= 0) continue;

        const normalizedFilePath = comment.file.startsWith('/') ? comment.file : '/' + comment.file;
        comment.file = normalizedFilePath;

        const lineMapping = this.fileLineMappings.get(normalizedFilePath);
        if (lineMapping && lineMapping.size > 0) {
          const lineInfo = lineMapping.get(comment.line);
          if (!lineInfo || !lineInfo.isAdded) {
            console.log(`⏭️  Skipping comment on unchanged line ${comment.line} in ${normalizedFilePath}`);
            continue;
          }
        }

        // Skip duplicates early
        if (this.isDuplicateComment(comment, existingComments)) continue;

        if (!inlineCommentsByFile.has(normalizedFilePath)) {
          inlineCommentsByFile.set(normalizedFilePath, []);
        }
        inlineCommentsByFile.get(normalizedFilePath)!.push(comment);
      }
    }

    // For each file, sort comments and coalesce contiguous line numbers into ranges
    for (const [filePath, comments] of inlineCommentsByFile.entries()) {
      // Sort by line ascending
      comments.sort((a: any, b: any) => (a.line || 0) - (b.line || 0));

      // Build ranges: each range is { startLine, endLine, comments: [...] }
      const ranges: Array<{ startLine: number; endLine: number; comments: any[] }> = [];

      for (const comment of comments) {
        const ln = comment.line as number;
        if (ranges.length === 0) {
          ranges.push({ startLine: ln, endLine: ln, comments: [comment] });
          continue;
        }

        const last = ranges[ranges.length - 1];
        if (ln <= last.endLine + 1) {
          // contiguous or overlapping - extend range and push comment
          last.endLine = Math.max(last.endLine, ln);
          last.comments.push(comment);
        } else {
          // start new range
          ranges.push({ startLine: ln, endLine: ln, comments: [comment] });
        }
      }

      // Post each range as either single-line inline comments or a ranged inline comment
      for (const range of ranges) {
        try {
          if (range.startLine === range.endLine) {
            // Single-line range: post the single comment (if multiple comments on same line, combine them)
            const commentsOnLine = range.comments;
            const mergedText = commentsOnLine.map((c: any) => this.formatInlineComment(c)).join('\n\n---\n\n');
            console.log(`💬 Posting inline comment for ${filePath} at line ${range.startLine}`);
            await this.azureDevOpsService.addInlineComment(filePath, mergedText, range.startLine, true);
            console.log(`✅ Posted inline comment for ${filePath} at line ${range.startLine}`);
          } else {
            // Multi-line contiguous range: use ranged inline comment for better anchoring
            const mergedText = range.comments.map((c: any) => this.formatInlineComment(c)).join('\n\n---\n\n');
            console.log(`💬 Posting ranged inline comment for ${filePath} lines ${range.startLine}-${range.endLine}`);
            await this.azureDevOpsService.addInlineCommentWithRange(filePath, mergedText, range.startLine, range.endLine, true);
            console.log(`✅ Posted ranged inline comment for ${filePath} lines ${range.startLine}-${range.endLine}`);
          }
        } catch (error: any) {
          console.error(`❌ Error posting inline comment for ${filePath} lines ${range.startLine}-${range.endLine}:`, error.message);
          const fallbackKey = filePath;
          if (!this.fallbackGeneralCommentFiles.has(fallbackKey)) {
            try {
              const fallbackComment = `**File: ${filePath}**\n\n${range.comments.map((c: any) => this.formatComment(c)).join('\n\n')}`;
              await this.azureDevOpsService.addGeneralComment(fallbackComment);
              this.fallbackGeneralCommentFiles.add(fallbackKey);
              console.log(`✅ Posted fallback general comment for ${filePath}`);
            } catch (fallbackError: any) {
              console.error(`❌ Fallback comment also failed for ${filePath}:`, fallbackError.message);
            }
          } else {
            console.log(`⚠️ Skipping additional fallback general comment for ${filePath} (already posted)`);
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
