export interface MCPServerConfig {
  name: string;
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  payloadTemplate?: string;
}

export interface MCPContextRequest {
  filePath: string;
  fileDiff: string;
  fileContent: string;
  prContext: any;
  metadata?: Record<string, any>;
}
