import * as tl from "azure-pipelines-task-lib/task";
import { Agent } from 'https';
import fetch from 'node-fetch';

export interface PRComment {
  id?: number;
  parentCommentId?: number;
  content: string;
  commentType: number;
  author?: {
    displayName: string;
    uniqueName: string;
  };
  threadContext?: {
    filePath?: string;
    leftFileStart?: number;
    leftFileEnd?: number;
    rightFileStart?: number;
    rightFileEnd?: number;
  };
}

export interface PRThread {
  id: number;
  status: number;
  threadContext: any;
  comments: PRComment[];
}

export interface PRDetails {
  id: number;
  title: string;
  description: string;
  sourceRefName: string;
  targetRefName: string;
  createdBy: {
    displayName: string;
    uniqueName: string;
  };
  reviewers: Array<{
    displayName: string;
    uniqueName: string;
    vote: number;
  }>;
  status: string;
  mergeStatus: string;
  changes: Array<{
    changeId: number;
    item: {
      path: string;
      changeType: string;
    };
  }>;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  isBinary: boolean;
}

export class AzureDevOpsService {
  private collectionUri: string;
  private projectId: string;
  private repositoryName: string;
  private pullRequestId: string;
  private accessToken: string;
  private httpsAgent: Agent;

  constructor(httpsAgent: Agent) {
    this.collectionUri = tl.getVariable('SYSTEM.TEAMFOUNDATIONCOLLECTIONURI') || '';
    this.projectId = tl.getVariable('SYSTEM.TEAMPROJECTID') || '';
    this.repositoryName = tl.getVariable('Build.Repository.Name') || '';
    this.pullRequestId = tl.getVariable('System.PullRequest.PullRequestId') || '';
    this.accessToken = tl.getVariable('SYSTEM.ACCESSTOKEN') || '';
    this.httpsAgent = httpsAgent;
  }

  private getApiUrl(endpoint: string): string {
    return `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/pullRequests/${this.pullRequestId}${endpoint}?api-version=7.0`;
  }

  public async getPullRequestDetails(): Promise<PRDetails> {
    const url = this.getApiUrl('');
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      agent: this.httpsAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch PR details: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  public async getChangedFiles(): Promise<string[]> {
    const url = this.getApiUrl('/changes');
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      agent: this.httpsAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch changed files: ${response.status} ${response.statusText}`);
    }

    const changes = await response.json();
    return changes.value
      .filter((change: any) => change.item.changeType !== 'delete')
      .map((change: any) => change.item.path);
  }

  public async getFileContent(filePath: string, targetBranch: string): Promise<FileContent> {
    const url = `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${targetBranch}&api-version=7.0`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      agent: this.httpsAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch file content for ${filePath}: ${response.status} ${response.statusText}`);
    }

    const content = await response.json();
    
    // Check if file is binary
    const isBinary = this.isBinaryFile(content.content);
    
    return {
      path: filePath,
      content: content.content || '',
      size: content.size || 0,
      isBinary: isBinary
    };
  }

  public async getFileDiff(filePath: string, targetBranch: string, sourceBranch: string): Promise<string> {
    const url = `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/diffs/commits?baseVersion=${targetBranch}&targetVersion=${sourceBranch}&api-version=7.0`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      agent: this.httpsAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch diff for ${filePath}: ${response.status} ${response.statusText}`);
    }

    const diff = await response.json();
    
    // Filter diff for specific file
    const fileChanges = diff.changes?.filter((change: any) => change.item.path === filePath) || [];
    
    if (fileChanges.length === 0) {
      return '';
    }

    return fileChanges.map((change: any) => change.item.path).join('\n');
  }

  public async addComment(comment: PRComment): Promise<void> {
    const url = this.getApiUrl('/threads');
    
    const body = {
      comments: [comment],
      status: 1,
      threadContext: comment.threadContext
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      agent: this.httpsAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to add comment: ${response.status} ${response.statusText}`);
    }

    console.log(`Comment added successfully for ${comment.threadContext?.filePath || 'general'}`);
  }

  public async addInlineComment(
    filePath: string,
    comment: string,
    lineNumber: number,
    isRightSide: boolean = true
  ): Promise<void> {
    const threadContext = {
      filePath: filePath,
      rightFileStart: isRightSide ? lineNumber : undefined,
      rightFileEnd: isRightSide ? lineNumber : undefined,
      leftFileStart: !isRightSide ? lineNumber : undefined,
      leftFileEnd: !isRightSide ? lineNumber : undefined
    };

    await this.addComment({
      content: comment,
      commentType: 1,
      threadContext: threadContext
    });
  }

  public async addGeneralComment(comment: string): Promise<void> {
    await this.addComment({
      content: comment,
      commentType: 1
    });
  }

  public async getExistingComments(): Promise<PRThread[]> {
    const url = this.getApiUrl('/threads');
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      agent: this.httpsAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch existing comments: ${response.status} ${response.statusText}`);
    }

    const threads = await response.json();
    return threads.value || [];
  }

  public async deleteComment(threadId: number, commentId: number): Promise<void> {
    const url = this.getApiUrl(`/threads/${threadId}/comments/${commentId}`);
    
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      agent: this.httpsAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to delete comment: ${response.status} ${response.statusText}`);
    }

    console.log(`Comment ${commentId} deleted successfully`);
  }

  public async deleteExistingComments(): Promise<void> {
    console.log("Deleting existing comments from previous runs...");

    const threads = await this.getExistingComments();
    const collectionUri = tl.getVariable('SYSTEM.TEAMFOUNDATIONCOLLECTIONURI') as string;
    const collectionName = this.getCollectionName(collectionUri);
    const buildServiceName = `${tl.getVariable('SYSTEM.TEAMPROJECT')} Build Service (${collectionName})`;

    for (const thread of threads) {
      if (thread.threadContext) {
        for (const comment of thread.comments) {
          // Check if comment is from our build service
          if (comment.author?.displayName === buildServiceName) {
            await this.deleteComment(thread.id, comment.id!);
          }
        }
      }
    }

    console.log("Existing comments deleted successfully");
  }

  public async updatePRStatus(status: 'active' | 'abandoned' | 'completed'): Promise<void> {
    const url = this.getApiUrl('');
    
    const body = {
      status: status
    };

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      agent: this.httpsAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to update PR status: ${response.status} ${response.statusText}`);
    }

    console.log(`PR status updated to ${status}`);
  }

  public async addReviewer(displayName: string, uniqueName: string): Promise<void> {
    const url = this.getApiUrl('/reviewers');
    
    const body = {
      displayName: displayName,
      uniqueName: uniqueName,
      vote: 0
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      agent: this.httpsAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to add reviewer: ${response.status} ${response.statusText}`);
    }

    const responseData = await response.json();
    console.log(`Reviewer ${displayName} added successfully`);
  }

  private isBinaryFile(content: string): boolean {
    // Simple heuristic to detect binary files
    const binaryPatterns = [
      /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/,
      /^\x89PNG\r\n\x1A\n/,
      /^GIF8[79]a/,
      /^JFIF/,
      /^PK\x03\x04/,
      /^MZ/
    ];

    return binaryPatterns.some(pattern => pattern.test(content));
  }

  private getCollectionName(collectionUri: string): string {
    const collectionUriWithoutProtocol = collectionUri.replace('https://', '').replace('http://', '');

    if (collectionUriWithoutProtocol.includes('.visualstudio.')) {
      return collectionUriWithoutProtocol.split('.visualstudio.')[0];
    } else {
      return collectionUriWithoutProtocol.split('/')[1];
    }
  }
}
