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
    suggestion: z.string().optional(),
    is_new_issue: z.boolean().optional(),
    is_fixed: z.boolean().optional()
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
  }).optional(),
  final_assessment: z.object({
    overall_assessment: z.string(),
    summary: z.string(),
    key_issues: z.string(),
    recommendations: z.string(),
    confidence: z.number()
  }).optional(),
  external_context: z.array(z.string()).default([])
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
  private verbose: boolean = true;
  private apiVersion: string;
  private useResponsesApi: boolean;

  constructor(
    azureOpenAIEndpoint: string,
    azureOpenAIKey: string,
    deploymentName: string,
    maxLLMCalls: number = 100,
    reviewThreshold: number = 0.7,
    apiVersion: string = '2024-02-15-preview',
    useResponsesApi: boolean = false
  ) {
    this.azureOpenAIEndpoint = azureOpenAIEndpoint;
    this.azureOpenAIKey = azureOpenAIKey;
    this.deploymentName = deploymentName;
    this.maxLLMCalls = maxLLMCalls;
    this.reviewThreshold = reviewThreshold;
    this.apiVersion = apiVersion;
    this.useResponsesApi = useResponsesApi;
    // Verbose logging: default enabled unless explicitly disabled by ADVPR_VERBOSE=0
    try {
      const envVal = tl.getVariable('ADVPR_VERBOSE');
      this.verbose = !(envVal === '0' || process.env['ADVPR_VERBOSE'] === '0');
    } catch (e) {
      this.verbose = true;
    }
  }

  public async runReview(
    fileContent: string,
    fileDiff: string,
    fileName: string,
    prContext: any,
    lineMapping?: Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext?: boolean }>,
    externalContext: string[] = []
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
      pr_context: prContext,
      external_context: externalContext || []
    };

    try {
      // Run the review process sequentially
      let state = await this.analyzeContext(initialState);
      state = await this.reviewFile(state, lineMapping);
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

    const preferResponsesApi = this.useResponsesApi;

    if (preferResponsesApi) {
      try {
        return await this.performAzureOpenAIRequest(prompt, 'responsesDeployment', 'primary');
      } catch (error) {
        if (this.shouldTryGlobalResponsesEndpoint(error)) {
          const status = (error as { status?: number })?.status;
          const message = (error as Error)?.message || '';
          console.warn(`⚠️ Responses deployment endpoint returned 404${status ? ` (${status})` : ''}. Retrying via the global responses path.`);
          if (this.verbose && message) {
            console.warn(`   ↳ Original error: ${message}`);
          }

          try {
            return await this.tryGlobalResponsesEndpoints(prompt);
          } catch (globalError) {
            if (this.shouldFallbackToChatCompletions(globalError)) {
              const fallbackStatus = (globalError as { status?: number })?.status;
              const fallbackMessage = (globalError as Error)?.message || '';
              console.warn(`⚠️ Global responses endpoint unavailable${fallbackStatus ? ` (${fallbackStatus})` : ''}. Attempting legacy chat/completions fallback.`);
              if (this.verbose && fallbackMessage) {
                console.warn(`   ↳ Original error: ${fallbackMessage}`);
              }

              try {
                const chatResult = await this.performAzureOpenAIRequest(prompt, 'chatCompletions', 'fallback');
                this.useResponsesApi = false;
                return chatResult;
              } catch (chatError) {
                if (this.isOperationNotSupportedForChat(chatError)) {
                  const message = [
                    'Chat Completions fallback is not supported for this deployment.',
                    'Ensure the Azure deployment (gpt-5-codex) is configured for the Responses API and uses a supported api-version.',
                    'You may need to set the task input `azure_openai_api_version` to a supported preview (e.g., 2024-08-01-preview) or disable the Responses API fallback.'
                  ].join(' ');
                  throw new Error(`${message}\nOriginal error: ${chatError instanceof Error ? chatError.message : String(chatError)}`);
                }
                throw chatError;
              }
            }

            console.error("Error calling Azure OpenAI via global responses endpoint:", globalError);
            throw globalError;
          }
        }

        if (this.shouldFallbackToChatCompletions(error)) {
          const status = (error as { status?: number })?.status;
          const message = (error as Error)?.message || '';
          console.warn(`⚠️ Responses API call failed${status ? ` (${status})` : ''}. Falling back to the legacy chat/completions endpoint.`);
          if (this.verbose && message) {
            console.warn(`   ↳ Original error: ${message}`);
          }

          try {
            const chatResult = await this.performAzureOpenAIRequest(prompt, 'chatCompletions', 'fallback');
            this.useResponsesApi = false;
            return chatResult;
          } catch (chatError) {
            if (this.isOperationNotSupportedForChat(chatError)) {
              const guidance = [
                'The deployment does not support chat completions.',
                'Update the Azure OpenAI API version input to a supported Responses API preview (e.g., 2024-08-01-preview) or disable the Responses API option.',
                'Verify the deployment is configured for the Responses or Chat Completions API.'
              ].join(' ');
              throw new Error(`${guidance}\nOriginal error: ${chatError instanceof Error ? chatError.message : String(chatError)}`);
            }
            throw chatError;
          }
        }

        console.error("Error calling Azure OpenAI via responses endpoint:", error);
        throw error;
      }
    }

    try {
      return await this.performAzureOpenAIRequest(prompt, 'chatCompletions', 'primary');
    } catch (error) {
      console.error("Error calling Azure OpenAI:", error);
      throw error;
    }
  }

  private async performAzureOpenAIRequest(
    prompt: string,
    mode: 'responsesDeployment' | 'responsesGlobal' | 'chatCompletions',
    attempt: 'primary' | 'fallback',
    apiVersionOverride?: string
  ): Promise<string> {
    const isResponsesMode = mode !== 'chatCompletions';
    const deploymentBaseUrl = `${this.azureOpenAIEndpoint}/openai/deployments/${this.deploymentName}`;
    const apiVersion = apiVersionOverride ?? this.apiVersion;

    let url: string;
    switch (mode) {
      case 'responsesDeployment':
        url = `${deploymentBaseUrl}/responses?api-version=${apiVersion}`;
        break;
      case 'responsesGlobal':
        url = `${this.azureOpenAIEndpoint}/openai/v1/responses?api-version=${apiVersion}`;
        break;
      case 'chatCompletions':
      default:
        url = `${deploymentBaseUrl}/chat/completions?api-version=${apiVersion}`;
        break;
    }

    type ResponsesPayload = {
      input: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      response_format: { type: string };
      temperature: number;
      max_output_tokens: number;
      model?: string;
    };

    type ChatPayload = {
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      response_format: { type: string };
      max_tokens?: number;
      max_completion_tokens?: number;
    };

    const temperature = this.shouldForceDefaultTemperature(isResponsesMode) ? 1 : 0.1;

    const payload: ResponsesPayload | ChatPayload = isResponsesMode
      ? (() => {
          const responsesPayload: ResponsesPayload = {
            input: [
              {
                role: "system",
                content: [
                  {
                    type: "text",
                    text: "You are an expert code reviewer. You MUST respond with valid JSON only. Do not include any text before or after the JSON. Do not use markdown formatting. Return only the JSON object as requested."
                  }
                ]
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: prompt
                  }
                ]
              }
            ],
            response_format: { type: "json_object" },
            temperature,
            max_output_tokens: 4000
          };

          if (mode === 'responsesGlobal') {
            responsesPayload.model = this.deploymentName;
          }

          return responsesPayload;
        })()
      : (() => {
          const chatPayload: ChatPayload = {
            messages: [
              {
                role: "system",
                content: "You are an expert code reviewer. You MUST respond with valid JSON only. Do not include any text before or after the JSON. Do not use markdown formatting. Return only the JSON object as requested."
              },
              {
                role: "user",
                content: prompt
              }
            ],
            temperature,
            response_format: { type: "json_object" }
          };

          if (this.shouldUseMaxCompletionTokens(isResponsesMode)) {
            chatPayload.max_completion_tokens = 4000;
          } else {
            chatPayload.max_tokens = 4000;
          }

          return chatPayload;
        })();

    // Safe debug logging (do not print secrets)
    try {
      if (this.verbose) {
        const userMsg = 'input' in payload
          ? (payload.input.find((m) => m.role === 'user')?.content?.[0]?.text || '')
          : (payload.messages.find((m) => m.role === 'user')?.content || '');
        console.log('🔎 OpenAI request summary:');
        console.log(`  - URL: ${url}`);
        console.log(`  - Deployment: ${this.deploymentName}`);
        console.log(`  - Endpoint Mode: ${mode}${attempt === 'fallback' ? ' (fallback)' : ''}`);
        console.log(`  - API Version: ${apiVersion}`);
        const messageCount = 'input' in payload ? payload.input.length : payload.messages.length;
        console.log(`  - Messages: ${messageCount}`);
        console.log(`  - Prompt length: ${userMsg.length} chars`);
        console.log(`  - Prompt preview (first 600 chars):\n${userMsg.substring(0, 600)}`);
        if (userMsg.length > 600) console.log(`  - Prompt tail preview (last 200 chars):\n${userMsg.substring(userMsg.length - 200)}`);
      }
    } catch (logErr) {
      console.log('⚠️ Failed to log OpenAI request summary', logErr);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.azureOpenAIKey
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch (readErr) {
        errorBody = `<failed to read error body: ${readErr}>`;
      }
      const enrichedError = new Error(`Azure OpenAI API error: ${response.status} ${response.statusText} - ${errorBody}`) as Error & {
        status?: number;
        body?: string;
        endpointMode?: 'responsesDeployment' | 'responsesGlobal' | 'chatCompletions';
        apiVersion?: string;
      };
      enrichedError.status = response.status;
      enrichedError.body = errorBody;
      enrichedError.endpointMode = mode;
      enrichedError.apiVersion = apiVersion;
      throw enrichedError;
    }

    const data = await response.json() as any;
    this.llmCalls++;
    let content = '';

    if (isResponsesMode) {
      content =
        data.output_text ||
        (Array.isArray(data.output)
          ? (data.output
              .flatMap((item: any) => item.content || [])
              .find((part: any) => part.type === 'text')?.text || '')
          : '');
    } else {
      content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    }

    try {
      if (this.verbose) {
        console.log('🔍 OpenAI response summary:');
        console.log(`  - HTTP status: ${response.status}`);
        console.log(`  - Endpoint Mode: ${mode}`);
        console.log(`  - API Version: ${apiVersion}`);
        if (isResponsesMode) {
          const outputCount = Array.isArray(data.output) ? data.output.length : 0;
          console.log(`  - Output items: ${outputCount}`);
        } else {
          const choicesCount = Array.isArray(data.choices) ? data.choices.length : 0;
          console.log(`  - Choices: ${choicesCount}`);
        }
        console.log(`  - Response length: ${content ? content.length : 0} chars`);
        if (content) console.log(`  - Response preview (first 600 chars):\n${content.substring(0, 600)}`);
        if (content && content.length > 600) console.log(`  - Response tail preview (last 200 chars):\n${content.substring(content.length - 200)}`);
      }
    } catch (logErr) {
      console.log('⚠️ Failed to log OpenAI response summary', logErr);
    }

    return content;
  }

  private async tryGlobalResponsesEndpoints(prompt: string): Promise<string> {
    const versionsToTry = this.getResponsesApiVersionFallbacks();
    let lastError: unknown = null;

    for (let index = 0; index < versionsToTry.length; index++) {
      const version = versionsToTry[index];
      const attemptLabel: 'primary' | 'fallback' = index === 0 ? 'fallback' : 'fallback';

      try {
        if (index > 0) {
          console.warn(`⚠️ Retrying responses API with fallback api-version "${version}"`);
        }
        return await this.performAzureOpenAIRequest(prompt, 'responsesGlobal', attemptLabel, version);
      } catch (error) {
        lastError = error;
        if (this.isUnsupportedApiVersionError(error)) {
          console.warn(`⚠️ API version "${version}" is not supported for the responses endpoint. Trying next fallback version...`);
          continue;
        }

        throw error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Failed to call Azure OpenAI responses endpoint with any available api-version.');
  }

  private getResponsesApiVersionFallbacks(): string[] {
    const configuredVersion = this.apiVersion?.trim();
    const fallbacks = [
      '2025-04-01-preview',
      '2024-12-01-preview',
      '2024-10-01-preview',
      '2024-08-01-preview',
      '2024-02-15-preview'
    ];

    const merged = [
      ...(configuredVersion ? [configuredVersion] : []),
      ...fallbacks
    ];

    return Array.from(new Set(merged.filter(Boolean)));
  }

  private shouldTryGlobalResponsesEndpoint(error: unknown): boolean {
    if (!this.isNotFoundError(error) && !this.isUnsupportedApiVersionError(error)) {
      return false;
    }

    const mode = (error as { endpointMode?: string }).endpointMode;
    return mode === 'responsesDeployment';
  }

  private shouldFallbackToChatCompletions(error: unknown): boolean {
    if (!this.isNotFoundError(error) && !this.isUnsupportedApiVersionError(error)) {
      return false;
    }

    const mode = (error as { endpointMode?: string }).endpointMode;
    return mode === 'responsesDeployment' || mode === 'responsesGlobal';
  }

  private isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { status?: number; body?: string; message?: string };
    if (candidate.status !== 404) {
      return false;
    }

    const bodyText = candidate.body || candidate.message || '';
    return /resource not found/i.test(bodyText) || /deployment/i.test(bodyText) || /model/i.test(bodyText);
  }

  private isUnsupportedApiVersionError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { status?: number; body?: string; message?: string };
    if (candidate.status !== 400) {
      return false;
    }

    const bodyText = candidate.body || candidate.message || '';
    return /api version not supported/i.test(bodyText) || /unsupported api version/i.test(bodyText);
  }

  private isOperationNotSupportedForChat(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { status?: number; body?: string; message?: string; endpointMode?: string };
    if (candidate.endpointMode !== 'chatCompletions') {
      return false;
    }

    const bodyText = candidate.body || candidate.message || '';
    return /operationnotsupported/i.test(bodyText) || /does not work with the specified model/i.test(bodyText);
  }

  private shouldUseMaxCompletionTokens(useResponsesEndpoint: boolean = this.useResponsesApi): boolean {
    if (useResponsesEndpoint) {
      return false;
    }

    const match = this.apiVersion.match(/(\d{4})-(\d{2})/);
    if (!match) {
      return false;
    }

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);

    if (Number.isNaN(year) || Number.isNaN(month)) {
      return false;
    }

    if (year > 2024) {
      return true;
    }

    return year === 2024 && month >= 7;
  }

  private shouldForceDefaultTemperature(useResponsesEndpoint: boolean = this.useResponsesApi): boolean {
    if (useResponsesEndpoint) {
      return true;
    }

    const match = this.apiVersion.match(/(\d{4})-(\d{2})/);
    if (!match) {
      return false;
    }

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);

    if (Number.isNaN(year) || Number.isNaN(month)) {
      return false;
    }

    if (year > 2024) {
      return true;
    }

    return year === 2024 && month >= 7;
  }

  private safeJsonParse(jsonString: string, fallback: any): any {
    try {
      // Clean the response first
      let cleanedResponse = jsonString.trim();
      
      // Remove any markdown code blocks
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      
      // Try to parse the JSON string
      return JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.log(`⚠️ JSON parsing failed:`, parseError instanceof Error ? parseError.message : String(parseError));
      console.log(`🔍 Raw response:`, jsonString.substring(0, 200));
      
      // Try multiple extraction strategies
      const extractionStrategies = [
        // Strategy 1: Look for JSON object
        () => {
          const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            console.log(`🔄 Strategy 1: Extracting JSON object...`);
            return JSON.parse(jsonMatch[0]);
          }
          return null;
        },
        // Strategy 2: Look for JSON array
        () => {
          const jsonMatch = jsonString.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            console.log(`🔄 Strategy 2: Extracting JSON array...`);
            return JSON.parse(jsonMatch[0]);
          }
          return null;
        },
        // Strategy 3: Try to find JSON after "```json"
        () => {
          const jsonMatch = jsonString.match(/```json\s*(\{[\s\S]*?\})\s*```/);
          if (jsonMatch) {
            console.log(`🔄 Strategy 3: Extracting from markdown code block...`);
            return JSON.parse(jsonMatch[1]);
          }
          return null;
        },
        // Strategy 4: Try to find JSON after "```"
        () => {
          const jsonMatch = jsonString.match(/```\s*(\{[\s\S]*?\})\s*```/);
          if (jsonMatch) {
            console.log(`🔄 Strategy 4: Extracting from code block...`);
            return JSON.parse(jsonMatch[1]);
          }
          return null;
        }
      ];
      
      for (const strategy of extractionStrategies) {
        try {
          const result = strategy();
          if (result) {
            console.log(`✅ JSON extraction successful`);
            return result;
          }
        } catch (extractError) {
          console.log(`⚠️ Strategy failed:`, extractError instanceof Error ? extractError.message : String(extractError));
        }
      }
      
      // Return fallback if all parsing attempts fail
      console.log(`🔄 All JSON extraction strategies failed, using fallback response structure`);
      return fallback;
    }
  }

  private async analyzeContext(state: PRReviewStateType): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    const contextExternalContext = this.buildExternalContextSection(
      state.external_context,
      {
        heading: 'Additional Context From MCP Servers',
        instruction: 'Consider this context when assessing review priority.'
      }
    );

    const contextPrompt = `You are an expert code reviewer. Analyze the following PR context and determine if a detailed review is needed.

PR Title: ${state.pr_context?.title || 'N/A'}
PR Description: ${state.pr_context?.description || 'N/A'}
Changed Files: ${state.pr_context?.changed_files?.join(', ') || 'N/A'}
${contextExternalContext}

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

      this.llmCalls++;
      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error analyzing context:", error);
      return state;
    }
  }

  private async reviewFile(state: PRReviewStateType, lineMapping?: Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext?: boolean }>): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls || !state.file_content || !state.file_diff) {
      return state;
    }

    // Parse the diff to extract line numbers and changes
    let diffAnalysis = this.analyzeDiff(state.file_diff || '');
    const fileLines = (state.file_content || '').split('\n');

    // If analyzeDiff found no changed lines but a lineMapping was provided by the orchestrator,
    // use that mapping to construct changedContent and addedLines as a fallback so we can still
    // produce focused changed-line context for the LLM.
    if ((diffAnalysis.changedContent.length === 0 || diffAnalysis.addedLines.length === 0) && lineMapping && lineMapping.size > 0) {
      try {
        console.log(`🔄 Fallback: building changedContent from provided lineMapping (entries: ${lineMapping.size})`);
        const addedLines: number[] = [];
        const changedContent: string[] = [];

        // lineMapping keys are diff-line numbers; values have modifiedLine indicating target file line
        for (const [, mapping] of Array.from(lineMapping.entries())) {
          if (mapping.isAdded) {
            const targetLine = mapping.modifiedLine;
            // mapping.modifiedLine is 1-based from parseDiffLineNumbers
            const content = fileLines[targetLine - 1] || '';
            addedLines.push(targetLine);
            changedContent.push(content);
          }
        }

        if (addedLines.length > 0) {
          diffAnalysis = { addedLines, removedLines: [], modifiedLines: [], changedContent };
          console.log(`✅ Built fallback changedContent with ${addedLines.length} added lines from lineMapping`);
        }
      } catch (fbErr) {
        console.log(`⚠️ Failed fallback lineMapping processing:`, fbErr instanceof Error ? fbErr.message : String(fbErr));
      }
    }
    
    // First, check for obvious syntax errors in the changed content
    const syntaxErrors = this.detectSyntaxErrors(diffAnalysis.changedContent, diffAnalysis.addedLines, state.current_file || 'unknown', fileLines);
    if (syntaxErrors.length > 0) {
      console.log(`🚨 Detected ${syntaxErrors.length} syntax errors in changed content`);
      const groupedSyntax = new Map<number, Array<{lineNumber: number, message: string, suggestion: string}>>();

      for (const error of syntaxErrors) {
        if (!groupedSyntax.has(error.lineNumber)) {
          groupedSyntax.set(error.lineNumber, []);
        }
        groupedSyntax.get(error.lineNumber)!.push(error);
      }

      for (const [lineNumber, issues] of groupedSyntax.entries()) {
        const formattedIssues = issues.map(issue => ({
          type: 'bug',
          severity: 'critical',
          description: issue.message,
          suggestion: issue.suggestion,
          confidence: 1.0
        }));

        const commentBody = this.combineIssuesForComment(formattedIssues, fileLines[lineNumber - 1] || '', lineNumber);

        state.review_comments.push({
          file: state.current_file || "unknown",
          line: lineNumber,
          comment: commentBody,
          type: "bug",
          confidence: 1.0,
          is_new_issue: true
        });
      }
    }
    
    const changedLineBlocks = this.buildChangedLineBlocks(diffAnalysis.addedLines, fileLines);
    const changedLinesContext = this.renderBlocksForPrompt(changedLineBlocks);

    console.log(`🔍 Prepared ${changedLineBlocks.length} changed-line blocks for AI context`);

    // If no changed lines, skip the review
    if (diffAnalysis.changedContent.length === 0) {
      console.log(`⏭️ No changed lines found in diff, skipping review for ${state.current_file}`);
      return state;
    }

    const externalContextSection = this.buildExternalContextSection(state.external_context);

    const reviewPrompt = `You are an expert code reviewer. Analyze ONLY the following changed lines from a Pull Request.

File: ${state.current_file}

CHANGED LINE BLOCKS (lines prefixed with "+" were modified in this PR; lines with " " are nearby context for reference):
${changedLinesContext}${externalContextSection}

IMPORTANT: Only comment on lines prefixed with "+". Context lines are for understanding only.

CRITICAL RULES - READ CAREFULLY:
1. YOU CAN ONLY COMMENT ON THE LINES LISTED ABOVE - these are the ONLY lines that were changed
2. DO NOT comment on any other lines in the file, even if they have issues
3. If the changed lines don't have any issues, return an empty issues array
4. Focus ONLY on problems in the actual changes made
5. Use the EXACT line numbers provided above

CRITICAL: Look for these OBVIOUS problems in the CHANGED LINES ONLY:
1. SYNTAX ERRORS - broken code, missing brackets, invalid syntax
2. GIBBERISH TEXT - random characters, nonsensical code  
3. BROKEN STRUCTURE - incomplete objects, missing properties
4. TYPO ERRORS - obvious typos in code
5. LOGIC ERRORS - code that doesn't make sense

IMPORTANT INSTRUCTIONS:
1. ONLY comment on code that was actually CHANGED in this PR (the lines shown above)
2. Use the EXACT line numbers from the changed lines list
3. Focus on the specific changes made, not the entire file
4. Provide relevant suggestions that match the actual code being changed
5. PRIORITIZE obvious syntax errors and broken code over minor style issues
6. If no issues are found in the changed lines, return empty issues array

Review the CHANGED code for:
1. SYNTAX ERRORS and broken code (HIGHEST PRIORITY)
2. Logic errors and correctness
3. Code quality and readability
4. Performance issues
5. Security vulnerabilities
6. Maintainability concerns

For each issue, provide the EXACT line number from the changed lines list where the issue occurs.

CRITICAL: You MUST respond with ONLY valid JSON. No markdown, no explanations, no text before or after the JSON. Just the JSON object.

Use the following JSON schema for your response:
{
  "issues": [
    {
      "type": "bug",
      "severity": "high",
      "description": "Detailed description of the issue",
      "line_number": 15,
      "suggestion": "Specific suggestion for improvement",
      "confidence": 0.9,
      "code_snippet": "const example = 'bad code';",
      "is_new_issue": true
    }
  ],
  "fixed_issues": [
    {
      "description": "Description of the issue that was fixed",
      "line_number": 10,
      "fix_description": "How the issue was addressed"
    }
  ],
  "overall_quality": "needs_improvement",
  "summary": "Brief summary of the review"
}

CRITICAL REQUIREMENTS:
1. For each issue, you MUST provide the EXACT line_number from the modified file
2. You MUST include the code_snippet that contains the issue - this should be the EXACT code from that line
3. The line_number must correspond to the actual line in the modified file where the issue occurs
4. The code_snippet must match the actual code on that line (whitespace differences are OK)
5. If you cannot find a specific line, do NOT make up a line number - set line_number to null
6. Focus on the ACTUAL CHANGED CODE - only comment on lines that were modified in this PR
7. Be language-agnostic - this works for any programming language (Python, Java, C#, JavaScript, etc.)`;

    try {
      const response = await this.callAzureOpenAI(reviewPrompt);
      const review = this.safeJsonParse(response, {
        issues: [],
        fixed_issues: [],
        overall_quality: "acceptable",
        summary: "Review completed with fallback parsing"
      });
      
      // Add review comments to state with STRICT validation for changed lines only
      if (review.issues && Array.isArray(review.issues)) {
        const groupedIssues = new Map<number, any[]>();

        review.issues.forEach((issue: any) => {
          if (issue.confidence >= this.reviewThreshold) {
            let chosenLine = 0;

            // If the issue already contains a valid changed-line number, prefer it
            if (issue.line_number && diffAnalysis.addedLines.includes(issue.line_number)) {
              chosenLine = issue.line_number;
              console.log(`✅ Issue line ${issue.line_number} is in changed lines - using provided line`);
            } else {
              // Try to heuristically find the best matching line (using code_snippet, description, keywords)
              try {
                const mapped = this.findBestLineNumber(issue, diffAnalysis, state.file_content || '');
                if (mapped && mapped > 0) {
                  chosenLine = mapped;
                  console.log(`🔧 Mapped issue to best line ${chosenLine} using heuristics`);
                } else {
                  console.log(`⚠️ Could not map issue to a changed line using heuristics (issue.line: ${issue.line_number})`);
                }
              } catch (mapErr) {
                console.log(`⚠️ Error while mapping issue to line:`, mapErr instanceof Error ? mapErr.message : String(mapErr));
              }
            }

            if (chosenLine && chosenLine > 0) {
              if (!groupedIssues.has(chosenLine)) {
                groupedIssues.set(chosenLine, []);
              }
              groupedIssues.get(chosenLine)!.push(issue);
            } else {
              // Fall back to PR-level comment so the reviewer still sees the issue
              console.log(`⚠️ Issue missing or outside changed lines: creating PR-level summary (issue line: ${issue.line_number})`);

              state.review_comments.push({
                file: "PR_CONTEXT",
                // leave line undefined for PR-level comments
                comment: `ISSUE (no valid changed-line): ${issue.description}`,
                type: issue.type,
                confidence: issue.confidence,
                suggestion: issue.suggestion,
                is_new_issue: issue.is_new_issue !== false
              });
            }
          }
        });

        if (groupedIssues.size > 0) {
          for (const [lineNumber, issues] of groupedIssues.entries()) {
            const commentBody = this.combineIssuesForComment(issues, fileLines[lineNumber - 1] || '', lineNumber);
            const primaryIssue = issues[0];

            state.review_comments.push({
              file: state.current_file || "unknown",
          line: lineNumber,
          comment: commentBody,
          type: primaryIssue.type,
          confidence: Math.max(...issues.map((issue: any) => issue.confidence ?? this.reviewThreshold)),
          is_new_issue: issues.every((issue: any) => issue.is_new_issue !== false)
        });
      }
    }
      }

      // Add fixed issues as positive feedback
      if (review.fixed_issues && Array.isArray(review.fixed_issues)) {
        review.fixed_issues.forEach((fixedIssue: any) => {
          if (fixedIssue.line_number && diffAnalysis.addedLines.includes(fixedIssue.line_number)) {
            state.review_comments.push({
              file: state.current_file || "unknown",
              line: fixedIssue.line_number,
              comment: `✅ FIXED: ${fixedIssue.description}\n\n${fixedIssue.fix_description}`,
              type: "improvement",
              confidence: 0.9,
              is_fixed: true
            });
          } else {
            // Create PR-level positive feedback if no valid inline location
            state.review_comments.push({
              file: "PR_CONTEXT",
              comment: `✅ FIXED (PR-level): ${fixedIssue.description} - ${fixedIssue.fix_description}`,
              type: "improvement",
              confidence: 0.9,
              is_fixed: true
            });
          }
        });
      }

      this.llmCalls++;
      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error reviewing file:", error);
      return state;
    }
  }

  private analyzeDiff(diff: string): { addedLines: number[]; removedLines: number[]; modifiedLines: number[]; changedContent: string[] } {
    const addedLines: number[] = [];
    const removedLines: number[] = [];
    const modifiedLines: number[] = [];
    const changedContent: string[] = [];
    
    if (!diff) {
      return { addedLines, removedLines, modifiedLines, changedContent };
    }

    console.log(`🔍 Analyzing diff (${diff.length} chars):`);
    console.log(`📝 Diff preview: ${diff.substring(0, 200)}...`);

    const lines = diff.split('\n');
    let rightLineNumber = 0;
    let leftLineNumber = 0;
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        // Parse hunk header: @@ -leftStart,leftCount +rightStart,rightCount @@
        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (match) {
          leftLineNumber = parseInt(match[1]) - 1; // Convert to 0-based
          rightLineNumber = parseInt(match[3]) - 1; // Convert to 0-based
          inHunk = true;
          console.log(`🔍 Hunk: left starts at ${leftLineNumber + 1}, right starts at ${rightLineNumber + 1}`);
        }
      } else if (inHunk) {
        if (line.startsWith('+')) {
          // Added line in the modified file
          rightLineNumber++;
          addedLines.push(rightLineNumber);
          changedContent.push(line.substring(1)); // Remove the + prefix
          console.log(`➕ Added line ${rightLineNumber}: ${line.substring(1).substring(0, 50)}...`);
        } else if (line.startsWith('-')) {
          // Removed line from the original file
          leftLineNumber++;
          removedLines.push(leftLineNumber);
          console.log(`➖ Removed line ${leftLineNumber}: ${line.substring(1).substring(0, 50)}...`);
        } else if (line.startsWith(' ')) {
          // Context line (unchanged)
          leftLineNumber++;
          rightLineNumber++;
        } else if (line.trim() === '') {
          // Empty line
          rightLineNumber++;
        }
      }
    }

    console.log(`✅ Diff analysis complete: ${addedLines.length} added, ${removedLines.length} removed, ${changedContent.length} changed content lines`);
    console.log(`📝 Added lines: ${addedLines.join(', ')}`);
    console.log(`📝 Changed content: ${changedContent.map((line, i) => `Line ${addedLines[i]}: ${line}`).join('\n')}`);
    return { addedLines, removedLines, modifiedLines, changedContent };
  }

  private detectSyntaxErrors(changedContent: string[], addedLines: number[], fileName: string, fileLines: string[]): Array<{lineNumber: number, message: string, suggestion: string}> {
    const errors: Array<{lineNumber: number, message: string, suggestion: string}> = [];
    
    if (!changedContent || changedContent.length === 0 || !addedLines || addedLines.length === 0) {
      return errors;
    }
    
    console.log(`🔍 Detecting syntax errors in ${changedContent.length} changed lines`);
    
    for (let i = 0; i < changedContent.length; i++) {
      const line = changedContent[i];
      const lineNumber = addedLines[i] || (i + 1); // Use actual line number from diff
      
      // Check for obvious gibberish or random characters
      if (this.isGibberish(line)) {
        errors.push({
          lineNumber: lineNumber,
          message: `Line contains gibberish or random characters: "${line.substring(0, 50)}..."`,
          suggestion: "Replace with valid code or remove if not needed"
        });
        console.log(`🚨 Gibberish detected at line ${lineNumber}: ${line.substring(0, 30)}...`);
        continue;
      }
      
      // Check for obvious syntax errors
      if (this.hasObviousSyntaxError(line)) {
        errors.push({
          lineNumber: lineNumber,
          message: `Obvious syntax error: "${line}"`,
          suggestion: "Fix the syntax error or remove the line"
        });
        console.log(`🚨 Syntax error detected at line ${lineNumber}: ${line.substring(0, 30)}...`);
        continue;
      }
      
      // Check for incomplete code structures
      if (this.isIncompleteStructure(line, lineNumber, fileLines)) {
        errors.push({
          lineNumber: lineNumber,
          message: `Incomplete code structure: "${line}"`,
          suggestion: "Complete the code structure or remove if not needed"
        });
        console.log(`🚨 Incomplete structure detected at line ${lineNumber}: ${line.substring(0, 30)}...`);
        continue;
      }
    }
    
    console.log(`✅ Syntax error detection complete: ${errors.length} errors found`);
    return errors;
  }

  private buildChangedLineBlocks(addedLines: number[], fileLines: string[], contextWindow: number = 2): Array<{ start: number; end: number; lines: Array<{ number: number; text: string; changed: boolean }> }> {
    if (!addedLines || addedLines.length === 0) {
      return [];
    }

    const sorted = Array.from(new Set(addedLines)).sort((a, b) => a - b);
    const changedSet = new Set(sorted);
    const blocks: Array<{ start: number; end: number; lines: Array<{ number: number; text: string; changed: boolean }> }> = [];
    let blockStart = sorted[0];
    let blockEnd = sorted[0];

    const pushBlock = (start: number, end: number) => {
      const startWithContext = Math.max(1, start - contextWindow);
      const endWithContext = Math.min(fileLines.length, end + contextWindow);
      const lines: Array<{ number: number; text: string; changed: boolean }> = [];
      for (let line = startWithContext; line <= endWithContext; line++) {
        lines.push({
          number: line,
          text: fileLines[line - 1] ?? '',
          changed: changedSet.has(line)
        });
      }
      blocks.push({ start: startWithContext, end: endWithContext, lines });
    };

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      if (current <= blockEnd + 1) {
        blockEnd = current;
      } else {
        pushBlock(blockStart, blockEnd);
        blockStart = current;
        blockEnd = current;
      }
    }

    pushBlock(blockStart, blockEnd);
    return blocks;
  }

  private renderBlocksForPrompt(blocks: Array<{ start: number; end: number; lines: Array<{ number: number; text: string; changed: boolean }> }>): string {
    if (!blocks || blocks.length === 0) {
      return '';
    }

    return blocks.map(block => {
      const header = `Lines ${block.start}-${block.end}`;
      const code = block.lines.map(line => {
        const prefix = line.changed ? '+' : ' ';
        return `${prefix}${line.number.toString().padStart(5, ' ')} | ${line.text}`;
      }).join('\n');
      return `${header}\n\`\`\`diff\n${code}\n\`\`\``;
    }).join('\n\n');
  }

  private combineIssuesForComment(issues: any[], lineContent: string, lineNumber: number): string {
    if (!issues || issues.length === 0) {
      return '';
    }

    const parts = issues.map((issue: any, index: number) => {
      const kind = issue.type ? issue.type.toUpperCase() : 'ISSUE';
      const severity = issue.severity ? issue.severity.toUpperCase() : 'N/A';
      const description = issue.description || 'No description provided.';
      const suggestion = issue.suggestion ? `\n\n💡 ${issue.suggestion}` : '';
      return `**${index + 1}. ${kind} (${severity})**\n${description}${suggestion}`;
    });

    const snippet = `\`\`\`diff\n+ ${lineNumber}: ${lineContent}\n\`\`\``;
    return `${parts.join('\n\n')}\n\n${snippet}`;
  }

  private isGibberish(line: string): boolean {
    const trimmed = line.trim();
    
    if (!trimmed) return false;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return false;

    // If the line contains common code punctuation, treat it as legitimate code.
    if (/[.;(){}=]/.test(trimmed)) return false;

    const alphaOnly = trimmed.replace(/[_\d]/g, '');
    const longRandomLetters = /^[a-z]{12,}$/i.test(alphaOnly);
    const alphaNumericMix = /[a-z]{5,}\d{3,}/i.test(trimmed.replace(/_/g, ''));
    const spacedRandomWords = /^[a-z]{4,}\s+[a-z]{4,}\s+[a-z0-9]{4,}$/i.test(trimmed);

    return longRandomLetters || alphaNumericMix || spacedRandomWords;
  }
  
  private hasObviousSyntaxError(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;

    const hasInvalidNegation = trimmed.includes('?!');
    const hasDoubleQuestion = /\?\?/.test(trimmed);
    const usesInvalidTypeKeyword = /^\s*int\s+[A-Za-z_]/.test(trimmed);

    return hasInvalidNegation || hasDoubleQuestion || usesInvalidTypeKeyword;
  }
  
  private isIncompleteStructure(line: string, lineNumber: number, fileLines: string[]): boolean {
    const trimmed = line.trim();
    
    if (!trimmed) {
      return false;
    }

    if (trimmed.endsWith('{') && !trimmed.includes('}')) {
      return !this.hasMatchingClosingBrace(lineNumber, fileLines);
    }

    if (/^if\s*\([^)]*\)\s*$/.test(trimmed)) {
      const nextLineIndex = this.findNextNonEmptyLineIndex(lineNumber, fileLines);
      if (nextLineIndex > 0) {
        const nextLine = fileLines[nextLineIndex - 1].trim();
        if (nextLine.startsWith('{') || nextLine.startsWith('return') || nextLine.startsWith('throw')) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  private hasMatchingClosingBrace(lineNumber: number, fileLines: string[]): boolean {
    let depth = 0;
    let opened = false;
    for (let i = lineNumber - 1; i < fileLines.length; i++) {
      const line = fileLines[i];
      for (const char of line) {
        if (char === '{') {
          depth++;
          opened = true;
        } else if (char === '}' && opened) {
          depth--;
        }
      }
      if (opened && depth <= 0) {
        return true;
      }
    }
    return false;
  }

  private findNextNonEmptyLineIndex(currentLine: number, fileLines: string[]): number {
    for (let i = currentLine; i < fileLines.length; i++) {
      if ((fileLines[i] || '').trim().length > 0) {
        return i + 1;
      }
    }
    return -1;
  }

  private findBestLineNumber(issue: any, diffAnalysis: any, fileContent: string): number {
    console.log(`🔍 Finding best line number for issue:`, {
      type: issue.type,
      description: issue.description?.substring(0, 50),
      hasLineNumber: !!issue.line_number,
      hasCodeSnippet: !!issue.code_snippet,
      addedLines: diffAnalysis.addedLines?.length || 0,
      changedContent: diffAnalysis.changedContent?.length || 0
    });

    // Log the changed content for debugging
    if (diffAnalysis.changedContent && diffAnalysis.changedContent.length > 0) {
      console.log(`📝 Changed content lines:`);
      diffAnalysis.changedContent.forEach((line: string, index: number) => {
        console.log(`  Line ${diffAnalysis.addedLines[index]}: ${line.substring(0, 100)}...`);
      });
    }

    // If the issue already has a line number, validate it first
    if (issue.line_number && issue.line_number > 0) {
      console.log(`🔍 Validating provided line number: ${issue.line_number}`);
      
      // Check if the line number makes sense for the issue
      if (this.validateLineNumberForIssue(issue, issue.line_number, fileContent, diffAnalysis.addedLines)) {
        console.log(`✅ Using validated line number: ${issue.line_number}`);
        return issue.line_number;
      } else {
        console.log(`❌ Line number ${issue.line_number} doesn't match the issue, searching for better match...`);
      }
    }

    // Try to find the line by searching for the code snippet in the changed content first
    if (issue.code_snippet && diffAnalysis.changedContent) {
      const snippet = issue.code_snippet.trim();
      console.log(`🔍 Searching for code snippet: "${snippet}"`);
      for (let i = 0; i < diffAnalysis.changedContent.length; i++) {
        if (diffAnalysis.changedContent[i].includes(snippet)) {
          const lineNumber = diffAnalysis.addedLines[i];
          if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
            console.log(`✅ Found validated code snippet in changed content at line ${lineNumber}`);
            return lineNumber;
          }
        }
      }
      console.log(`❌ Code snippet not found in changed content or validation failed`);
    }

    // Try to find the line by searching for the code snippet in the full file
    if (issue.code_snippet) {
      const snippet = issue.code_snippet.trim();
      console.log(`🔍 Searching for code snippet in full file: "${snippet}"`);
      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(snippet)) {
          const lineNumber = i + 1;
          if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
            console.log(`✅ Found validated code snippet in full file at line ${lineNumber}`);
            return lineNumber;
          }
        }
      }
      console.log(`❌ Code snippet not found in full file or validation failed`);
    }

    // Try to find by searching for keywords in the changed content
    if (issue.description && diffAnalysis.changedContent) {
      const keywords = issue.description.toLowerCase().split(' ').filter((word: string) => word.length > 3);
      console.log(`🔍 Searching for keywords in changed content:`, keywords);
      for (let i = 0; i < diffAnalysis.changedContent.length; i++) {
        const line = diffAnalysis.changedContent[i].toLowerCase();
        const matchingKeywords = keywords.filter((keyword: string) => line.includes(keyword));
        if (matchingKeywords.length > 0) {
          const lineNumber = diffAnalysis.addedLines[i];
          if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
            console.log(`✅ Found validated keyword match in changed content at line ${lineNumber} (keywords: ${matchingKeywords.join(', ')})`);
            return lineNumber;
          }
        }
      }
      console.log(`❌ No validated keyword matches found in changed content`);
    }

    // Try to find by searching for keywords in the full file
    if (issue.description) {
      const keywords = issue.description.toLowerCase().split(' ').filter((word: string) => word.length > 3);
      console.log(`🔍 Searching for keywords in full file:`, keywords);
      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        const matchingKeywords = keywords.filter((keyword: string) => line.includes(keyword));
        if (matchingKeywords.length > 0) {
          const lineNumber = i + 1;
          if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
            console.log(`✅ Found validated keyword match in full file at line ${lineNumber} (keywords: ${matchingKeywords.join(', ')})`);
            return lineNumber;
          }
        }
      }
      console.log(`❌ No validated keyword matches found in full file`);
    }

    // Try to find the issue by searching for specific patterns in the full file
    if (issue.description) {
      const description = issue.description.toLowerCase();
      console.log(`🔍 Searching for issue patterns in full file: "${description}"`);
      
      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        
        // Look for specific patterns based on the issue type - language agnostic
        if (issue.type === 'security') {
          // Look for logging patterns in any language
          if (description.includes('log') && (
            line.includes('console.log') || // JavaScript/TypeScript
            line.includes('print(') || // Python
            line.includes('System.out.println') || // Java
            line.includes('Console.WriteLine') || // C#
            line.includes('printf') || // C/C++
            line.includes('logger.') || // Various logging frameworks
            line.includes('log.') // Various logging frameworks
          )) {
            const lineNumber = i + 1;
            if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
              console.log(`✅ Found validated logging line at ${lineNumber}: ${lines[i].substring(0, 50)}...`);
              return lineNumber;
            }
          }
          
          // Look for endpoint/URL patterns
          if (description.includes('endpoint') && (
            line.includes('endpoint') ||
            line.includes('url') ||
            line.includes('uri') ||
            line.includes('http') ||
            line.includes('https')
          )) {
            const lineNumber = i + 1;
            if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
              console.log(`✅ Found validated endpoint-related line at ${lineNumber}: ${lines[i].substring(0, 50)}...`);
              return lineNumber;
            }
          }
          
          // Look for API key patterns
          if (description.includes('api') && (
            line.includes('api') ||
            line.includes('key') ||
            line.includes('token') ||
            line.includes('secret') ||
            line.includes('password')
          )) {
            const lineNumber = i + 1;
            if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
              console.log(`✅ Found validated API key-related line at ${lineNumber}: ${lines[i].substring(0, 50)}...`);
              return lineNumber;
            }
          }
        }
        
        if (issue.type === 'bug') {
          // Look for syntax issues in any language
          if (description.includes('syntax') && (
            line.includes('{') || line.includes('}') || // Braces
            line.includes('(') || line.includes(')') || // Parentheses
            line.includes('[') || line.includes(']') || // Brackets
            line.includes(';') || // Semicolons
            line.includes('=') || // Assignments
            line.includes('def ') || // Python functions
            line.includes('function ') || // JavaScript functions
            line.includes('public ') || // Java/C# methods
            line.includes('private ') // Java/C# methods
          )) {
            const lineNumber = i + 1;
            if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
              console.log(`✅ Found validated syntax-related line at ${lineNumber}: ${lines[i].substring(0, 50)}...`);
              return lineNumber;
            }
          }
        }
      }
      console.log(`❌ No validated patterns found in full file`);
    }

    // If we can't find a valid line, return 0 to indicate no valid line found
    console.log(`❌ No valid line found for this issue - returning 0 to skip comment`);
    return 0;
  }

  private validateLineNumberForIssue(issue: any, lineNumber: number, fileContent: string, changedLines: number[]): boolean {
    if (!lineNumber || lineNumber <= 0) return false;
    
    const lines = fileContent.split('\n');
    if (lineNumber > lines.length) return false;
    
    // CRITICAL: Check if the line number is actually in the changed lines
    if (!changedLines.includes(lineNumber)) {
      console.log(`❌ Line ${lineNumber} is NOT in the changed lines. Changed lines: ${changedLines.join(', ')}`);
      return false;
    }
    
    const line = lines[lineNumber - 1];
    const description = issue.description?.toLowerCase() || '';
    const codeSnippet = issue.code_snippet?.toLowerCase() || '';
    
    console.log(`🔍 Validating line ${lineNumber} for issue (line is in changed lines):`, {
      type: issue.type,
      description: description.substring(0, 50),
      codeSnippet: codeSnippet.substring(0, 50),
      actualLine: line.substring(0, 100)
    });
    
    // If we have a code snippet, the line should contain that snippet
    if (codeSnippet && codeSnippet.trim()) {
      const normalizedLine = line.toLowerCase().trim();
      const normalizedSnippet = codeSnippet.trim();
      
      // Check if the line contains the code snippet (with some flexibility for whitespace)
      const snippetWords = normalizedSnippet.split(/\s+/).filter((word: string) => word.length > 0);
      const lineWords = normalizedLine.split(/\s+/).filter((word: string) => word.length > 0);
      
      // Check if most of the snippet words are present in the line
      const matchingWords = snippetWords.filter((snippetWord: string) => 
        lineWords.some((lineWord: string) => lineWord.includes(snippetWord) || snippetWord.includes(lineWord))
      );
      
      const matchRatio = matchingWords.length / snippetWords.length;
      
      if (matchRatio < 0.5) { // At least 50% of words should match
        console.log(`❌ Line ${lineNumber} doesn't contain the code snippet. Match ratio: ${matchRatio.toFixed(2)}`);
        console.log(`❌ Expected: "${codeSnippet}"`);
        console.log(`❌ Actual: "${line}"`);
        return false;
      }
      
      console.log(`✅ Line ${lineNumber} contains the code snippet. Match ratio: ${matchRatio.toFixed(2)}`);
      return true;
    }
    
    // If no code snippet, check if the line contains keywords from the description
    if (description) {
      const descriptionWords = description.split(/\s+/)
        .filter((word: string) => word.length > 3) // Only meaningful words
        .map((word: string) => word.toLowerCase());
      
      const lineWords = line.toLowerCase().split(/\s+/);
      
      // Check if any significant words from the description appear in the line
      const matchingKeywords = descriptionWords.filter((descWord: string) => 
        lineWords.some((lineWord: string) => lineWord.includes(descWord) || descWord.includes(lineWord))
      );
      
      if (matchingKeywords.length === 0) {
        console.log(`❌ Line ${lineNumber} doesn't contain any keywords from the issue description`);
        console.log(`❌ Description keywords: ${descriptionWords.join(', ')}`);
        console.log(`❌ Line content: "${line}"`);
        return false;
      }
      
      console.log(`✅ Line ${lineNumber} contains relevant keywords: ${matchingKeywords.join(', ')}`);
      return true;
    }
    
    // If no code snippet or description, we can't validate - return false to be safe
    console.log(`❌ No code snippet or description available for validation`);
    return false;
  }

  private async securityScan(state: PRReviewStateType, lineMapping?: Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext?: boolean }>): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    if (!state.file_content) {
      return state;
    }

    // Parse the diff to extract line numbers and changes
    let diffAnalysis = this.analyzeDiff(state.file_diff || '');

    // Fallback to provided lineMapping if no changed lines were found
    if ((diffAnalysis.changedContent.length === 0 || diffAnalysis.addedLines.length === 0) && lineMapping && lineMapping.size > 0) {
      try {
        const fileLines = (state.file_content || '').split('\n');
        const addedLines: number[] = [];
        const changedContent: string[] = [];
        for (const [, mapping] of Array.from(lineMapping.entries())) {
          if (mapping.isAdded) {
            const targetLine = mapping.modifiedLine;
            const content = fileLines[targetLine - 1] || '';
            addedLines.push(targetLine);
            changedContent.push(content);
          }
        }
        if (addedLines.length > 0) {
          diffAnalysis = { addedLines, removedLines: [], modifiedLines: [], changedContent };
          console.log(`✅ Security scan fallback: built changedContent from lineMapping with ${addedLines.length} lines`);
        }
      } catch (fbErr) {
        console.log(`⚠️ Security scan fallback failed:`, fbErr instanceof Error ? fbErr.message : String(fbErr));
      }
    }

    const securityFileLines = (state.file_content || '').split('\n');
    const securityBlocks = this.buildChangedLineBlocks(diffAnalysis.addedLines, securityFileLines);
    const changedLinesContext = this.renderBlocksForPrompt(securityBlocks);

    console.log(`🔍 Security scan - prepared ${securityBlocks.length} changed-line blocks for AI context`);

    // If no changed lines, skip the security scan
    if (diffAnalysis.changedContent.length === 0) {
      console.log(`⏭️ No changed lines found in diff, skipping security scan for ${state.current_file}`);
      return state;
    }

    const securityExternalContext = this.buildExternalContextSection(state.external_context);

    const securityPrompt = `Perform a security analysis of the modified code lines below.

File: ${state.current_file}

CHANGED LINE BLOCKS (lines prefixed with "+" were modified in this PR; lines with " " provide nearby context):
${changedLinesContext}${securityExternalContext}

IMPORTANT: ONLY analyze lines prefixed with "+". Context lines are for reference and must not be flagged unless they are also changed.

CRITICAL RULES - READ CAREFULLY:
1. Evaluate ONLY the modified lines (prefixed with "+")
2. Provide precise line numbers from the modified file
3. Recommend actionable remediations for each finding
4. If no security vulnerabilities exist in the modified lines, return an empty security_issues array

Assess the changed code for:
1. Hardcoded secrets and credentials
2. Logging of sensitive information
3. Input validation or sanitization gaps
4. SQL injection vulnerabilities
5. XSS vulnerabilities
6. Insecure authentication or authorization checks
7. Use of insecure dependencies or APIs
8. Prompt injection risks when interacting with LLMs

For each security issue, provide the EXACT line number from the changed lines list where the vulnerability occurs.

CRITICAL: You MUST respond with ONLY valid JSON. No markdown, no explanations, no text before or after the JSON. Just the JSON object.

Respond with JSON:
{
  "security_issues": [
    {
      "vulnerability_type": "SQL Injection",
      "severity": "high",
      "description": "User input is directly concatenated into SQL query",
      "line_number": 25,
      "recommendation": "Use parameterized queries",
      "confidence": 0.9,
      "code_snippet": "const query = 'SELECT * FROM users WHERE id = ' + userId;"
    }
  ],
  "overall_security_score": "C"
}

CRITICAL REQUIREMENTS:
1. For each security issue, you MUST provide the EXACT line_number from the modified file
2. You MUST include the code_snippet that contains the vulnerability - this should be the EXACT code from that line
3. The line_number must correspond to the actual line in the modified file where the vulnerability occurs
4. The code_snippet must match the actual code on that line (whitespace differences are OK)
5. If you cannot find a specific line, do NOT make up a line number - set line_number to null
6. Focus on the ACTUAL CHANGED CODE - only comment on lines that were modified in this PR
7. Be language-agnostic - this works for any programming language (Python, Java, C#, JavaScript, etc.)`;

    try {
      const response = await this.callAzureOpenAI(securityPrompt);
      const securityAnalysis = this.safeJsonParse(response, {
        security_issues: [],
        overall_security_score: "B"
      });
      
      if (securityAnalysis.security_issues && Array.isArray(securityAnalysis.security_issues)) {
        const groupedSecurityIssues = new Map<number, any[]>();

        securityAnalysis.security_issues.forEach((issue: any) => {
          if (issue.confidence >= this.reviewThreshold) {
            let chosenLine = 0;

            // Prefer provided line if valid
            if (issue.line_number && diffAnalysis.addedLines.includes(issue.line_number)) {
              chosenLine = issue.line_number;
              console.log(`✅ Security issue line ${issue.line_number} is in changed lines - using provided line`);
            } else {
              // Attempt heuristic mapping for security issues too
              try {
                const mapped = this.findBestLineNumber(issue, diffAnalysis, state.file_content || '');
                if (mapped && mapped > 0) {
                  chosenLine = mapped;
                  console.log(`🔧 Mapped security issue to best line ${chosenLine} using heuristics`);
                } else {
                  console.log(`❌ Security issue line ${issue.line_number} is NOT in changed lines (${diffAnalysis.addedLines.join(', ')}) - will skip inline posting`);
                }
              } catch (mapErr) {
                console.log(`⚠️ Error while mapping security issue to line:`, mapErr instanceof Error ? mapErr.message : String(mapErr));
              }
            }

            if (chosenLine && chosenLine > 0) {
              if (!groupedSecurityIssues.has(chosenLine)) {
                groupedSecurityIssues.set(chosenLine, []);
              }
              groupedSecurityIssues.get(chosenLine)!.push(issue);
            } else {
              console.log(`❌ Security issue could not be mapped to a changed line - SKIPPING inline comment`);
            }
          }
        });

        if (groupedSecurityIssues.size > 0) {
          for (const [lineNumber, issues] of groupedSecurityIssues.entries()) {
            const formatted = issues.map((issue: any) => ({
              type: 'security',
              severity: issue.severity || 'medium',
              description: issue.description,
              suggestion: issue.recommendation,
              confidence: issue.confidence ?? this.reviewThreshold
            }));

            const commentBody = this.combineIssuesForComment(formatted, securityFileLines[lineNumber - 1] || '', lineNumber);

            state.review_comments.push({
              file: state.current_file || "unknown",
              line: lineNumber,
              comment: commentBody,
              type: "security",
              confidence: Math.max(...formatted.map((item: any) => item.confidence)),
              is_new_issue: issues.every((issue: any) => issue.is_new_issue !== false)
            });
          }
        }
      }

      this.llmCalls++;
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

      this.llmCalls++;
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
      
      // Store final assessment in state for summary generation (not as a comment)
      state.final_assessment = {
        overall_assessment: finalAssessment.overall_assessment,
        summary: finalAssessment.summary,
        key_issues: finalAssessment.key_issues,
        recommendations: finalAssessment.recommendations,
        confidence: finalAssessment.confidence
      };

      this.llmCalls++;
      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error finalizing review:", error);
      return state;
    }
  }

  private buildExternalContextSection(
    contextItems?: string[],
    options?: {
      heading?: string;
      maxItems?: number;
      instruction?: string;
      includeInstruction?: boolean;
    }
  ): string {
    if (!contextItems || contextItems.length === 0) {
      return '';
    }

    const maxItems = Math.max(1, options?.maxItems ?? 5);
    const heading = options?.heading ?? 'ADDITIONAL CONTEXT FROM MCP SERVERS';
    const instruction = options?.instruction ?? 'Incorporate relevant details from this context when reviewing the changes.';
    const includeInstruction = options?.includeInstruction ?? true;

    const limitedItems = contextItems
      .slice(0, maxItems)
      .map(item => item?.trim())
      .filter((item): item is string => Boolean(item));

    if (limitedItems.length === 0) {
      return '';
    }

    const formattedItems = limitedItems
      .map((item, index) => `CONTEXT ${index + 1}:\n${item}`)
      .join('\n\n');

    const omittedCount = contextItems.length - limitedItems.length;
    const omissionNotice = omittedCount > 0
      ? `\n\nNote: ${omittedCount} additional context item(s) were omitted for brevity.`
      : '';

    const instructionText = includeInstruction ? `\n${instruction}` : '';
    return `\n${heading}:\n${formattedItems}${omissionNotice}${instructionText}\n`;
  }

  public getLLMCallCount(): number {
    return this.llmCalls;
  }
}
