import fetch from 'node-fetch';
import { MCPServerConfig, MCPContextRequest } from '../types/mcp';

export class MCPService {
  constructor(private readonly servers: MCPServerConfig[] = []) {}

  public hasServers(): boolean {
    return Array.isArray(this.servers) && this.servers.length > 0;
  }

  public async fetchContext(request: MCPContextRequest): Promise<string[]> {
    if (!this.hasServers()) {
      return [];
    }

    const contexts: string[] = [];

    for (const server of this.servers) {
      try {
        const context = await this.invokeServer(server, request);
        if (context && context.length > 0) {
          contexts.push(...context);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`⚠️ MCP server "${server.name}" failed: ${message}`);
      }
    }

    return contexts;
  }

  private async invokeServer(server: MCPServerConfig, request: MCPContextRequest): Promise<string[]> {
    const method = (server.method || 'POST').toUpperCase();
    const controller = new AbortController();
    const timeout = typeof server.timeoutMs === 'number' ? server.timeoutMs : 10000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const body = this.buildPayload(server, request);

    const response = await fetch(server.endpoint, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(server.headers || {})
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: controller.signal
    }).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '<unable to read body>');
      throw new Error(`${response.status} ${response.statusText} - ${errorBody.substring(0, 500)}`);
    }

    const text = await response.text();
    if (!text) {
      return [];
    }

    try {
      const parsed = JSON.parse(text);
      return this.extractContextFromResponse(parsed);
    } catch {
      return [text];
    }
  }

  private buildPayload(server: MCPServerConfig, request: MCPContextRequest): Record<string, any> {
    if (server.payloadTemplate) {
      try {
        const template = JSON.parse(server.payloadTemplate);
        return this.mergeTemplate(template, request);
      } catch {
        console.log(`⚠️ Invalid payloadTemplate for MCP server "${server.name}". Falling back to default payload.`);
      }
    }

    return {
      server: server.name,
      file_path: request.filePath,
      file_diff: request.fileDiff,
      file_content: request.fileContent,
      pr_context: request.prContext,
      metadata: request.metadata || {}
    };
  }

  private mergeTemplate(template: any, request: MCPContextRequest): Record<string, any> {
    const clone = JSON.parse(JSON.stringify(template));

    const inject = (obj: any): any => {
      if (typeof obj !== 'object' || obj === null) {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map(inject);
      }

      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          result[key] = value
            .replace(/\{\{file_path\}\}/gi, request.filePath)
            .replace(/\{\{file_diff\}\}/gi, request.fileDiff)
            .replace(/\{\{file_content\}\}/gi, request.fileContent)
            .replace(/\{\{pr_context\}\}/gi, JSON.stringify(request.prContext))
            .replace(/\{\{metadata\}\}/gi, JSON.stringify(request.metadata || {}));
        } else {
          result[key] = inject(value);
        }
      }
      return result;
    };

    return inject(clone);
  }

  private extractContextFromResponse(data: any): string[] {
    const contexts: string[] = [];

    if (!data) {
      return contexts;
    }

    if (typeof data === 'string') {
      contexts.push(data);
      return contexts;
    }

    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') {
          contexts.push(item);
        } else if (item && typeof item.text === 'string') {
          contexts.push(item.text);
        }
      }
      return contexts;
    }

    if (typeof data === 'object') {
      if (typeof data.context === 'string') {
        contexts.push(data.context);
      } else if (Array.isArray(data.context)) {
        contexts.push(...data.context.filter((item: any) => typeof item === 'string'));
      }

      if (Array.isArray(data.contexts)) {
        contexts.push(...data.contexts.filter((item: any) => typeof item === 'string'));
      }

      if (typeof data.content === 'string') {
        contexts.push(data.content);
      } else if (Array.isArray(data.content)) {
        contexts.push(...data.content.filter((item: any) => typeof item === 'string'));
      }

      if (typeof data.summary === 'string') {
        contexts.push(data.summary);
      }
    }

    return contexts;
  }
}
