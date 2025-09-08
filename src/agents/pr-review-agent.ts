import { z } from "zod";
import * as tl from "azure-pipelines-task-lib/task";
import fetch from 'node-fetch';

// Define the state schema for the PR review agent
export const PRReviewState = z.object({
  messages: z.array(z.any()),
  current_file: z.string().optional(),
  file_content: z.string().optional(),
  file_diff: z.string().optional(),
  review_comments: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    comment: z.string(),
    type: z.enum(["bug", "improvement", "security", "style", "test"]),
    confidence: z.number(),
    suggestion: z.string().optional()
  })).default([]),
  llm_calls: z.number().default(0),
  max_llm_calls: z.number(),
  review_threshold: z.number(),
  enable_code_suggestions: z.boolean(),
  enable_security_scanning: z.boolean(),
  pr_context: z.object({
    title: z.string(),
    description: z.string(),
    author: z.string(),
    target_branch: z.string(),
    source_branch: z.string(),
    changed_files: z.array(z.string())
  }).optional()
});

export type PRReviewStateType = z.infer<typeof PRReviewState>;

// Define the review analysis schema
const ReviewAnalysisSchema = z.object({
  has_issues: z.boolean(),
  issues: z.array(z.object({
    type: z.enum(["bug", "improvement", "security", "style", "test"]),
    severity: z.enum(["low", "medium", "high", "critical"]),
    description: z.string(),
    line_number: z.number().optional(),
    suggestion: z.string().optional(),
    confidence: z.number()
  })),
  overall_quality: z.enum(["excellent", "good", "acceptable", "needs_improvement", "poor"]),
  summary: z.string(),
  should_approve: z.boolean(),
  requires_changes: z.boolean()
});

export class AdvancedPRReviewAgent {
  private azureOpenAIEndpoint: string;
  private azureOpenAIKey: string;
  private deploymentName: string;
  private maxLLMCalls: number;
  private reviewThreshold: number;
  private llmCalls: number = 0;

  constructor(
    azureOpenAIEndpoint: string,
    azureOpenAIKey: string,
    deploymentName: string,
    maxLLMCalls: number = 100,
    reviewThreshold: number = 0.7
  ) {
    this.azureOpenAIEndpoint = azureOpenAIEndpoint;
    this.azureOpenAIKey = azureOpenAIKey;
    this.deploymentName = deploymentName;
    this.maxLLMCalls = maxLLMCalls;
    this.reviewThreshold = reviewThreshold;
  }

  public async runReview(
    fileContent: string,
    fileDiff: string,
    fileName: string,
    prContext: any
  ): Promise<PRReviewStateType> {
    const initialState: PRReviewStateType = {
      messages: [],
      current_file: fileName,
      file_content: fileContent,
      file_diff: fileDiff,
      review_comments: [],
      llm_calls: 0,
      max_llm_calls: this.maxLLMCalls,
      review_threshold: this.reviewThreshold,
      enable_code_suggestions: true,
      enable_security_scanning: true,
      pr_context: prContext
    };

    try {
      // Run the review process sequentially
      let state = await this.analyzeContext(initialState);
      state = await this.reviewFile(state);
      state = await this.securityScan(state);
      state = await this.generateSuggestions(state);
      state = await this.finalizeReview(state);

      return state;
    } catch (error) {
      console.error("Error running review:", error);
      return initialState;
    }
  }

  private async callAzureOpenAI(prompt: string): Promise<string> {
    if (this.llmCalls >= this.maxLLMCalls) {
      throw new Error("Maximum LLM calls reached");
    }

    try {
      const response = await fetch(`${this.azureOpenAIEndpoint}/openai/deployments/${this.deploymentName}/chat/completions?api-version=2024-02-15-preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.azureOpenAIKey
        },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          max_tokens: 4000,
          temperature: 0.1
        })
      });

      if (!response.ok) {
        throw new Error(`Azure OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      this.llmCalls++;
      return data.choices[0].message.content;
    } catch (error) {
      console.error("Error calling Azure OpenAI:", error);
      throw error;
    }
  }

  private safeJsonParse(jsonString: string, fallback: any): any {
    try {
      // Try to parse the JSON string
      return JSON.parse(jsonString);
    } catch (parseError) {
      console.log(`⚠️ JSON parsing failed:`, parseError instanceof Error ? parseError.message : String(parseError));
      console.log(`🔍 Raw response:`, jsonString.substring(0, 200));
      
      // Try to extract JSON from the response if it's embedded in text
      try {
        const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          console.log(`🔄 Attempting to extract JSON from response...`);
          return JSON.parse(jsonMatch[0]);
        }
      } catch (extractError) {
        console.log(`⚠️ JSON extraction also failed:`, extractError instanceof Error ? extractError.message : String(extractError));
      }
      
      // Return fallback if all parsing attempts fail
      console.log(`🔄 Using fallback response structure`);
      return fallback;
    }
  }

  private async analyzeContext(state: PRReviewStateType): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    const contextPrompt = `You are an expert code reviewer. Analyze the following PR context and determine if a detailed review is needed.

PR Title: ${state.pr_context?.title || 'N/A'}
PR Description: ${state.pr_context?.description || 'N/A'}
Changed Files: ${state.pr_context?.changed_files?.join(', ') || 'N/A'}

Determine if this PR requires a detailed code review based on:
1. Complexity of changes
2. Risk level
3. Impact on the codebase
4. Quality of the PR description

Respond with JSON:
{
  "requires_review": boolean,
  "reasoning": string,
  "priority": "low" | "medium" | "high"
}`;

    try {
      const response = await this.callAzureOpenAI(contextPrompt);
      const analysis = this.safeJsonParse(response, {
        requires_review: true,
        reasoning: "Default review required",
        priority: "medium"
      });
      
      if (!analysis.requires_review) {
        state.review_comments.push({
          file: "PR_CONTEXT",
          comment: `No detailed review needed: ${analysis.reasoning}`,
          type: "improvement",
          confidence: 0.9
        });
      }

      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error analyzing context:", error);
      return state;
    }
  }

  private async reviewFile(state: PRReviewStateType): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls || !state.file_content || !state.file_diff) {
      return state;
    }

    // Parse the diff to extract line numbers and changes
    const diffAnalysis = this.analyzeDiff(state.file_diff || '');
    
    const reviewPrompt = `You are an expert code reviewer. Analyze the following file changes and provide detailed feedback.

File: ${state.current_file}
File Content: ${state.file_content}
File Diff: ${state.file_diff}

IMPORTANT: When providing line numbers, use the line numbers from the MODIFIED file (right side of diff). 
The diff shows changes with + for additions and - for deletions. Focus on the actual line numbers in the modified file.

Review the code for:
1. Correctness and logic errors
2. Code quality and readability
3. Performance issues
4. Maintainability concerns
5. Adherence to coding standards
6. Test coverage needs

For each issue, provide the EXACT line number from the modified file where the issue occurs.

Use the following JSON schema for your response:
{
  "issues": [
    {
      "type": "bug" | "improvement" | "security" | "style" | "test",
      "severity": "low" | "medium" | "high" | "critical",
      "description": "Detailed description of the issue",
      "line_number": number (EXACT line number from modified file),
      "suggestion": "Specific suggestion for improvement",
      "confidence": number (0.0-1.0),
      "code_snippet": "The actual code line that has the issue"
    }
  ],
  "overall_quality": "excellent" | "good" | "acceptable" | "needs_improvement" | "poor",
  "summary": "Brief summary of the review"
}`;

    try {
      const response = await this.callAzureOpenAI(reviewPrompt);
      const review = this.safeJsonParse(response, {
        issues: [],
        overall_quality: "acceptable",
        summary: "Review completed with fallback parsing"
      });
      
      // Add review comments to state with improved line number detection
      if (review.issues && Array.isArray(review.issues)) {
        review.issues.forEach((issue: any) => {
          if (issue.confidence >= this.reviewThreshold) {
            // Try to find the best line number for this issue
            const bestLineNumber = this.findBestLineNumber(issue, diffAnalysis, state.file_content || '');
            
            state.review_comments.push({
              file: state.current_file || "unknown",
              line: bestLineNumber,
              comment: issue.description,
              type: issue.type,
              confidence: issue.confidence,
              suggestion: issue.suggestion
            });
          }
        });
      }

      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error reviewing file:", error);
      return state;
    }
  }

  private analyzeDiff(diff: string): { addedLines: number[]; removedLines: number[]; modifiedLines: number[] } {
    const addedLines: number[] = [];
    const removedLines: number[] = [];
    const modifiedLines: number[] = [];
    
    if (!diff) {
      return { addedLines, removedLines, modifiedLines };
    }

    const lines = diff.split('\n');
    let currentLine = 0;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        // Parse hunk header to get starting line numbers
        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (match) {
          currentLine = parseInt(match[3]) - 1; // Start of modified lines
        }
      } else if (line.startsWith('+')) {
        // Added line
        currentLine++;
        addedLines.push(currentLine);
      } else if (line.startsWith('-')) {
        // Removed line - don't increment current line
        // removedLines.push(currentLine);
      } else if (line.startsWith(' ')) {
        // Context line
        currentLine++;
      }
    }

    return { addedLines, removedLines, modifiedLines };
  }

  private findBestLineNumber(issue: any, diffAnalysis: any, fileContent: string): number {
    // If the issue already has a line number, use it
    if (issue.line_number && issue.line_number > 0) {
      return issue.line_number;
    }

    // Try to find the line by searching for the code snippet
    if (issue.code_snippet) {
      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(issue.code_snippet.trim())) {
          return i + 1; // Convert to 1-based line number
        }
      }
    }

    // If we have added lines, use the first one as a fallback
    if (diffAnalysis.addedLines.length > 0) {
      return diffAnalysis.addedLines[0];
    }

    // Default fallback
    return 1;
  }

  private async securityScan(state: PRReviewStateType): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    if (!state.file_content) {
      return state;
    }

    // Parse the diff to extract line numbers and changes
    const diffAnalysis = this.analyzeDiff(state.file_diff || '');

    const securityPrompt = `Perform a security analysis of the following code:

File: ${state.current_file}
Code: ${state.file_content}
File Diff: ${state.file_diff}

IMPORTANT: When providing line numbers, use the line numbers from the MODIFIED file (right side of diff). 
Focus on the actual line numbers in the modified file where security issues occur.

Look for security vulnerabilities including:
1. SQL injection
2. XSS vulnerabilities
3. Hardcoded secrets
4. Insecure authentication
5. Input validation issues
6. Authorization bypasses
7. Insecure dependencies
8. Logging of sensitive information
9. Prompt injection vulnerabilities
10. Input sanitization issues

For each security issue, provide the EXACT line number from the modified file where the vulnerability occurs.

Respond with JSON:
{
  "security_issues": [
    {
      "vulnerability_type": string,
      "severity": "low" | "medium" | "high" | "critical",
      "description": string,
      "line_number": number (EXACT line number from modified file),
      "recommendation": string,
      "confidence": number,
      "code_snippet": "The actual code line that has the security issue"
    }
  ],
  "overall_security_score": "A" | "B" | "C" | "D" | "F"
}`;

    try {
      const response = await this.callAzureOpenAI(securityPrompt);
      const securityAnalysis = this.safeJsonParse(response, {
        security_issues: [],
        overall_security_score: "B"
      });
      
      if (securityAnalysis.security_issues && Array.isArray(securityAnalysis.security_issues)) {
        securityAnalysis.security_issues.forEach((issue: any) => {
          if (issue.confidence >= this.reviewThreshold) {
            // Try to find the best line number for this security issue
            const bestLineNumber = this.findBestLineNumber(issue, diffAnalysis, state.file_content || '');
            
            state.review_comments.push({
              file: state.current_file || "unknown",
              line: bestLineNumber,
              comment: `SECURITY: ${issue.description}`,
              type: "security",
              confidence: issue.confidence,
              suggestion: issue.recommendation
            });
          }
        });
      }

      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error in security scan:", error);
      return state;
    }
  }

  private async generateSuggestions(state: PRReviewStateType): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    if (state.review_comments.length === 0) {
      return state;
    }

    const suggestionsPrompt = `Based on the following review comments, generate specific code improvement suggestions:

Review Comments: ${JSON.stringify(state.review_comments, null, 2)}

For each comment that has a suggestion, provide:
1. The exact code change needed
2. Before/after examples
3. Explanation of why this improves the code
4. Any additional considerations

Format as JSON:
{
  "suggestions": [
    {
      "comment_id": number,
      "code_change": {
        "before": string,
        "after": string
      },
      "explanation": string,
      "considerations": string[]
    }
  ]
}`;

    try {
      const response = await this.callAzureOpenAI(suggestionsPrompt);
      const suggestions = this.safeJsonParse(response, {
        suggestions: []
      });
      
      // Update review comments with suggestions
      if (suggestions.suggestions && Array.isArray(suggestions.suggestions)) {
        suggestions.suggestions.forEach((suggestion: any) => {
          const commentIndex = suggestion.comment_id;
          if (state.review_comments[commentIndex]) {
            state.review_comments[commentIndex].suggestion = 
              `Code Change:\nBefore: ${suggestion.code_change.before}\nAfter: ${suggestion.code_change.after}\n\nExplanation: ${suggestion.explanation}`;
          }
        });
      }

      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error generating suggestions:", error);
      return state;
    }
  }

  private async finalizeReview(state: PRReviewStateType): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    const finalizationPrompt = `Based on all the review comments and analysis, provide a final summary and recommendation:

Review Summary: ${JSON.stringify(state.review_comments, null, 2)}
Total Issues Found: ${state.review_comments.length}
LLM Calls Used: ${this.llmCalls}/${this.maxLLMCalls}

Provide a final recommendation in JSON format:
{
  "overall_assessment": "approve" | "approve_with_suggestions" | "request_changes",
  "summary": "Overall summary of the review",
  "key_issues": "List of the most important issues found",
  "recommendations": "Specific recommendations for the PR author",
  "confidence": number (0.0-1.0)
}`;

    try {
      const response = await this.callAzureOpenAI(finalizationPrompt);
      const finalAssessment = this.safeJsonParse(response, {
        overall_assessment: "approve_with_suggestions",
        summary: "Review completed with fallback parsing",
        key_issues: "Issues found during review",
        recommendations: "Consider the review comments provided",
        confidence: 0.7
      });
      
      // Add final assessment to state
      state.review_comments.push({
        file: "FINAL_ASSESSMENT",
        comment: `Final Assessment: ${finalAssessment.overall_assessment}\n\n${finalAssessment.summary}\n\nKey Issues: ${finalAssessment.key_issues}\n\nRecommendations: ${finalAssessment.recommendations}`,
        type: "improvement",
        confidence: finalAssessment.confidence
      });

      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error finalizing review:", error);
      return state;
    }
  }

  public getLLMCallCount(): number {
    return this.llmCalls;
  }
}
