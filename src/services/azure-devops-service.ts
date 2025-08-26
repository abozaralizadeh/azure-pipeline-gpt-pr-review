import * as tl from "azure-pipelines-task-lib/task";
import { Agent } from 'node:https';
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
    this.projectId = tl.getVariable('SYSTEM.TEAMPROJECT') || ''; // Use friendly name instead of GUID
    this.repositoryName = tl.getVariable('Build.Repository.Name') || '';
    this.pullRequestId = tl.getVariable('System.PullRequest.PullRequestId') || '';
    this.accessToken = tl.getVariable('SYSTEM.ACCESSTOKEN') || '';
    this.httpsAgent = httpsAgent;
    
    // Debug logging for troubleshooting
    console.log(`🔧 Azure DevOps Service initialized with:`);
    console.log(`  - Collection URI: "${this.collectionUri}"`);
    console.log(`  - Project ID: "${this.projectId}"`);
    console.log(`  - Repository Name: "${this.repositoryName}"`);
    console.log(`  - Pull Request ID: "${this.pullRequestId}"`);
    console.log(`  - Access Token: ${this.accessToken ? 'Present' : 'Missing'}`);
    
    // Show all available variables for debugging
    console.log(`🔍 All available Azure DevOps variables:`);
    const allVars = [
      'SYSTEM.TEAMFOUNDATIONCOLLECTIONURI',
      'SYSTEM.TEAMPROJECTID', 
      'SYSTEM.TEAMPROJECT',
      'Build.Repository.Name',
      'Build.Repository.Uri',
      'System.PullRequest.PullRequestId',
      'System.PullRequest.SourceBranch',
      'System.PullRequest.TargetBranch',
      'SYSTEM.ACCESSTOKEN'
    ];
    
    allVars.forEach(varName => {
      const value = tl.getVariable(varName);
      console.log(`  - ${varName}: "${value || 'undefined'}"`);
    });
    
    // Validate required variables
    if (!this.collectionUri) {
      console.error(`❌ Missing SYSTEM.TEAMFOUNDATIONCOLLECTIONURI`);
    }
    if (!this.projectId) {
      console.error(`❌ Missing SYSTEM.TEAMPROJECTID`);
    }
    if (!this.repositoryName) {
      console.error(`❌ Missing Build.Repository.Name`);
    }
    if (!this.pullRequestId) {
      console.error(`❌ Missing System.PullRequest.PullRequestId`);
    }
    if (!this.accessToken) {
      console.error(`❌ Missing SYSTEM.ACCESSTOKEN`);
    }
    
    // Additional validation for PR ID format
    if (this.pullRequestId) {
      console.log(`🔍 PR ID validation:`);
      console.log(`  - Raw PR ID: "${this.pullRequestId}"`);
      console.log(`  - Type: ${typeof this.pullRequestId}`);
      console.log(`  - Length: ${this.pullRequestId.length}`);
      console.log(`  - Is numeric: ${!isNaN(Number(this.pullRequestId))}`);
      
      // Check if PR ID might need to be extracted from a different format
      if (this.pullRequestId.includes('/')) {
        const parts = this.pullRequestId.split('/');
        console.log(`  - Contains slashes, parts:`, parts);
        const lastPart = parts[parts.length - 1];
        if (!isNaN(Number(lastPart))) {
          console.log(`  - Last part is numeric: ${lastPart}`);
        }
      }
    }
    
    // Test URL construction
    console.log(`🔍 Testing URL construction:`);
    const testUrl = `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/pullRequests/${this.pullRequestId}`;
    console.log(`  - Base URL: "${testUrl}"`);
    console.log(`  - Collection URI ends with /: ${this.collectionUri.endsWith('/')}`);
    console.log(`  - Project ID starts with /: ${this.projectId.startsWith('/')}`);
    
    // Try alternative variable combinations
    const altProjectId = tl.getVariable('SYSTEM.TEAMPROJECT') || '';
    if (altProjectId && altProjectId !== this.projectId) {
      console.log(`  - Alternative Project ID (SYSTEM.TEAMPROJECT): "${altProjectId}"`);
      const altUrl = `${this.collectionUri}${altProjectId}/_apis/git/repositories/${this.repositoryName}/pullRequests/${this.pullRequestId}`;
      console.log(`  - Alternative URL: "${altUrl}"`);
    }
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
    console.log(`🔍 Starting getChangedFiles with:`);
    console.log(`  - Collection URI: "${this.collectionUri}"`);
    console.log(`  - Project ID: "${this.projectId}"`);
    console.log(`  - Repository Name: "${this.repositoryName}"`);
    console.log(`  - Pull Request ID: "${this.pullRequestId}"`);
    
    // Since the PR Details API is working, let's try to get changes from there first
    console.log(`🔄 Trying to get changes from working PR Details API...`);
    try {
      const prDetails = await this.getPullRequestDetails();
      console.log(`📋 PR Details response:`, JSON.stringify(prDetails, null, 2));
      
      if (prDetails.changes && prDetails.changes.length > 0) {
        console.log(`✅ Found ${prDetails.changes.length} changes in PR details`);
        const filePaths = prDetails.changes
          .filter((change: any) => change.item && change.item.changeType !== 'delete')
          .map((change: any) => change.item.path);
        
        if (filePaths.length > 0) {
          console.log(`✅ Successfully extracted ${filePaths.length} changed files from PR details`);
          return filePaths;
        }
      } else {
        console.log(`⚠️ No changes found in PR details response`);
      }
    } catch (prDetailsError) {
      const errorMessage = prDetailsError instanceof Error ? prDetailsError.message : String(prDetailsError);
      console.error(`❌ Failed to get changes from PR details:`, errorMessage);
    }
    
    // Try Git diff API as fallback (comparing source to target branch)
    console.log(`🔄 Trying Git diff API as fallback...`);
    try {
      const gitDiffFiles = await this.getChangedFilesUsingGitDiff();
      if (gitDiffFiles.length > 0) {
        console.log(`✅ Successfully got ${gitDiffFiles.length} changed files using Git diff API`);
        return gitDiffFiles;
      }
    } catch (gitDiffError) {
      const errorMessage = gitDiffError instanceof Error ? gitDiffError.message : String(gitDiffError);
      console.error(`❌ Git diff fallback also failed:`, errorMessage);
    }
    
    // Try Git commits API as another fallback
    console.log(`🔄 Trying Git commits API as another fallback...`);
    try {
      const gitCommitsFiles = await this.getChangedFilesUsingGitCommits();
      if (gitCommitsFiles.length > 0) {
        console.log(`✅ Successfully got ${gitCommitsFiles.length} changed files using Git commits API`);
        return gitCommitsFiles;
      }
    } catch (gitCommitsError) {
      const errorMessage = gitCommitsError instanceof Error ? gitCommitsError.message : String(gitCommitsError);
      console.error(`❌ Git commits fallback also failed:`, errorMessage);
    }
    
    // Try a few more API approaches as last resort
    console.log(`🔄 Trying additional API approaches as last resort...`);
    const approaches = [
      {
        name: 'PR Changes API (v7.0)',
        url: `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/pullRequests/${this.pullRequestId}/changes?api-version=7.0`
      },
      {
        name: 'PR Changes API (no repo)',
        url: `${this.collectionUri}${this.projectId}/_apis/git/pullRequests/${this.pullRequestId}/changes?api-version=7.0`
      }
    ];

    for (const approach of approaches) {
      try {
        console.log(`🔍 Trying approach: ${approach.name}`);
        console.log(`🔍 URL: ${approach.url}`);
        
        const response = await fetch(approach.url, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          agent: this.httpsAgent
        });

        console.log(`🔍 Response status: ${response.status} ${response.statusText}`);

        if (response.ok) {
          const changes = await response.json();
          console.log(`📁 Raw changes response from ${approach.name}:`, JSON.stringify(changes, null, 2));
          
          if (changes.value && Array.isArray(changes.value)) {
            const filePaths = changes.value
              .filter((change: any) => change.item && change.item.changeType !== 'delete')
              .map((change: any) => change.item.path);
            
            console.log(`✅ Successfully extracted ${filePaths.length} changed files using ${approach.name}`);
            return filePaths;
          }
        } else {
          console.log(`⚠️ ${approach.name} failed: ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`⚠️ ${approach.name} failed with error:`, errorMessage);
      }
    }
    
    throw new Error('Failed to fetch changed files: All approaches failed');
  }

  public async getChangedFilesUsingGitDiff(): Promise<string[]> {
    console.log(`🔄 Trying to get changes using Git diff API...`);
    
    try {
      // Get PR details to get source and target branches
      const prDetails = await this.getPullRequestDetails();
      const sourceBranch = prDetails.sourceRefName.replace('refs/heads/', '');
      const targetBranch = prDetails.targetRefName.replace('refs/heads/', '');
      
      console.log(`🔍 Source branch: ${sourceBranch}, Target branch: ${targetBranch}`);
      
      // Try to get changes using the Git diff API
      const diffUrl = `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/diffs/commits?baseVersion=${targetBranch}&targetVersion=${sourceBranch}&api-version=7.0`;
      console.log(`🔍 Git diff URL: ${diffUrl}`);
      
      const response = await fetch(diffUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        agent: this.httpsAgent
      });
      
      if (response.ok) {
        const diffData = await response.json();
        console.log(`📋 Git diff response:`, JSON.stringify(diffData, null, 2));
        
        if (diffData.changes && Array.isArray(diffData.changes)) {
          const filePaths = diffData.changes
            .filter((change: any) => change.item && change.item.changeType !== 'delete')
            .map((change: any) => change.item.path);
          
          console.log(`✅ Successfully extracted ${filePaths.length} changed files using Git diff API`);
          return filePaths;
        }
      } else {
        console.log(`⚠️ Git diff API failed: ${response.status} ${response.statusText}`);
        try {
          const errorBody = await response.text();
          console.log(`🔍 Git diff error response body:`, errorBody);
        } catch (e) {
          console.log(`🔍 Could not read git diff error response body`);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`⚠️ Git diff approach failed:`, errorMessage);
    }
    
    return [];
  }

  public async getChangedFilesUsingGitCommits(): Promise<string[]> {
    console.log(`🔄 Trying to get changes using Git commits API...`);
    
    try {
      // Get PR details to get source and target branches
      const prDetails = await this.getPullRequestDetails();
      const sourceBranch = prDetails.sourceRefName.replace('refs/heads/', '');
      const targetBranch = prDetails.targetRefName.replace('refs/heads/', '');
      
      console.log(`🔍 Source branch: ${sourceBranch}, Target branch: ${targetBranch}`);
      
      // Get the latest commit from source branch
      const sourceCommitsUrl = `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/commits?searchCriteria.itemVersion.version=${sourceBranch}&searchCriteria.itemVersion.versionType=branch&api-version=7.0`;
      console.log(`🔍 Source commits URL: ${sourceCommitsUrl}`);
      
      const sourceResponse = await fetch(sourceCommitsUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        agent: this.httpsAgent
      });
      
      if (sourceResponse.ok) {
        const sourceCommits = await sourceResponse.json();
        console.log(`📋 Source commits response:`, JSON.stringify(sourceCommits, null, 2));
        
        if (sourceCommits.value && sourceCommits.value.length > 0) {
          const latestSourceCommit = sourceCommits.value[0];
          console.log(`🔍 Latest source commit: ${latestSourceCommit.commitId}`);
          
          // Get the latest commit from target branch
          const targetCommitsUrl = `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/commits?searchCriteria.itemVersion.version=${targetBranch}&searchCriteria.itemVersion.versionType=branch&api-version=7.0`;
          console.log(`🔍 Target commits URL: ${targetCommitsUrl}`);
          
          const targetResponse = await fetch(targetCommitsUrl, {
            headers: {
              'Authorization': `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json'
            },
            agent: this.httpsAgent
          });
          
          if (targetResponse.ok) {
            const targetCommits = await targetResponse.json();
            console.log(`📋 Target commits response:`, JSON.stringify(targetCommits, null, 2));
            
            if (targetCommits.value && targetCommits.value.length > 0) {
              const latestTargetCommit = targetCommits.value[0];
              console.log(`🔍 Latest target commit: ${latestTargetCommit.commitId}`);
              
              // Now get the diff between these two commits
              const diffUrl = `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/diffs/commits?baseVersion=${latestTargetCommit.commitId}&targetVersion=${latestSourceCommit.commitId}&api-version=7.0`;
              console.log(`🔍 Commits diff URL: ${diffUrl}`);
              
              const diffResponse = await fetch(diffUrl, {
                headers: {
                  'Authorization': `Bearer ${this.accessToken}`,
                  'Content-Type': 'application/json'
                },
                agent: this.httpsAgent
              });
              
              if (diffResponse.ok) {
                const diffData = await diffResponse.json();
                console.log(`📋 Commits diff response:`, JSON.stringify(diffData, null, 2));
                
                if (diffData.changes && Array.isArray(diffData.changes)) {
                  const filePaths = diffData.changes
                    .filter((change: any) => change.item && change.item.changeType !== 'delete')
                    .map((change: any) => change.item.path);
                  
                  console.log(`✅ Successfully extracted ${filePaths.length} changed files using Git commits API`);
                  return filePaths;
                }
              } else {
                console.log(`⚠️ Commits diff API failed: ${diffResponse.status} ${diffResponse.statusText}`);
              }
            }
          } else {
            console.log(`⚠️ Target commits API failed: ${targetResponse.status} ${targetResponse.statusText}`);
          }
        }
      } else {
        console.log(`⚠️ Source commits API failed: ${sourceResponse.status} ${sourceResponse.statusText}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`⚠️ Git commits approach failed:`, errorMessage);
    }
    
    return [];
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
    try {
      console.log("Deleting existing comments from previous runs...");

      const threads = await this.getExistingComments();
      const collectionUri = tl.getVariable('SYSTEM.TEAMFOUNDATIONCOLLECTIONURI') as string;
      const collectionName = this.getCollectionName(collectionUri);
      const buildServiceName = `${tl.getVariable('SYSTEM.TEAMPROJECT')} Build Service (${collectionName})`;

      console.log(`🔍 Looking for comments from: ${buildServiceName}`);
      console.log(`📝 Found ${threads.length} comment threads`);

      let deletedCount = 0;
      for (const thread of threads) {
        if (thread.threadContext) {
          for (const comment of thread.comments) {
            // Check if comment is from our build service
            if (comment.author?.displayName === buildServiceName) {
              try {
                await this.deleteComment(thread.id, comment.id!);
                deletedCount++;
              } catch (deleteError) {
                const errorMessage = deleteError instanceof Error ? deleteError.message : String(deleteError);
                console.warn(`⚠️ Failed to delete comment ${comment.id}:`, errorMessage);
              }
            }
          }
        }
      }

      console.log(`✅ Successfully deleted ${deletedCount} existing comments`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️ Failed to delete existing comments:`, errorMessage);
      console.log(`🔄 Continuing with review process...`);
    }
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

  public async testApiConnectivity(): Promise<void> {
    console.log("🧪 Testing Azure DevOps API connectivity...");
    
    try {
      // Test basic PR details endpoint
      const prDetails = await this.getPullRequestDetails();
      console.log(`✅ PR Details API working - PR ID: ${prDetails.id}, Title: ${prDetails.title}`);
      
      // Test if we can access the repository
      const repoUrl = `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}?api-version=7.0`;
      const repoResponse = await fetch(repoUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        agent: this.httpsAgent
      });
      
      if (repoResponse.ok) {
        const repoData = await repoResponse.json();
        console.log(`✅ Repository API working - Repo: ${repoData.name}, Default Branch: ${repoData.defaultBranch}`);
      } else {
        console.warn(`⚠️ Repository API failed: ${repoResponse.status} ${repoResponse.statusText}`);
      }
      
      // Test PR changes endpoint specifically
      console.log("🧪 Testing PR changes endpoint...");
      const changesUrl = `${this.collectionUri}${this.projectId}/_apis/git/repositories/${this.repositoryName}/pullRequests/${this.pullRequestId}/changes?api-version=7.0`;
      console.log(`🔍 Testing URL: ${changesUrl}`);
      
      const changesResponse = await fetch(changesUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        agent: this.httpsAgent
      });
      
      if (changesResponse.ok) {
        const changesData = await changesResponse.json();
        console.log(`✅ PR Changes API working - Found ${changesData.value?.length || 0} changes`);
      } else {
        console.warn(`⚠️ PR Changes API failed: ${changesResponse.status} ${changesResponse.statusText}`);
        try {
          const errorBody = await changesResponse.text();
          console.log(`🔍 Error response body:`, errorBody);
        } catch (e) {
          console.log(`🔍 Could not read error response body`);
        }
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ API connectivity test failed:`, errorMessage);
      throw error;
    }
  }

  public async testBaseUrlConnectivity(): Promise<void> {
    console.log("🧪 Testing base URL connectivity...");
    
    // Test the collection URI itself
    try {
      const baseUrl = this.collectionUri.replace('/_apis', '');
      console.log(`🔍 Testing base URL: ${baseUrl}`);
      
      const response = await fetch(baseUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        agent: this.httpsAgent
      });
      
      console.log(`🔍 Base URL response: ${response.status} ${response.statusText}`);
      if (response.ok) {
        console.log(`✅ Base URL is accessible`);
      } else {
        console.warn(`⚠️ Base URL returned: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️ Base URL test failed:`, errorMessage);
    }
    
    // Test project-level access
    try {
      const projectUrl = `${this.collectionUri}${this.projectId}/_apis/project?api-version=7.0`;
      console.log(`🔍 Testing project URL: ${projectUrl}`);
      
      const response = await fetch(projectUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        agent: this.httpsAgent
      });
      
      console.log(`🔍 Project URL response: ${response.status} ${response.statusText}`);
      if (response.ok) {
        const projectData = await response.json();
        console.log(`✅ Project accessible: ${projectData.name}`);
      } else {
        console.warn(`⚠️ Project URL returned: ${response.status} ${response.statusText}`);
        try {
          const errorBody = await response.text();
          console.log(`🔍 Project error response body:`, errorBody);
        } catch (e) {
          console.log(`🔍 Could not read project error response body`);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️ Project URL test failed:`, errorMessage);
    }
  }

  public async testCorrectedUrlStructure(): Promise<void> {
    console.log("🧪 Testing corrected URL structure with friendly project name...");
    
    // Test with the corrected project name (Personals instead of GUID)
    const correctedProjectId = tl.getVariable('SYSTEM.TEAMPROJECT') || '';
    console.log(`🔍 Using corrected project ID: "${correctedProjectId}"`);
    
    try {
      // Test the corrected PR details endpoint
      const correctedPrUrl = `${this.collectionUri}${correctedProjectId}/_apis/git/repositories/${this.repositoryName}/pullRequests/${this.pullRequestId}`;
      console.log(`🔍 Testing corrected PR URL: ${correctedPrUrl}`);
      
      const response = await fetch(correctedPrUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        agent: this.httpsAgent
      });
      
      if (response.ok) {
        const prData = await response.json();
        console.log(`✅ Corrected PR URL working - PR ID: ${prData.id}, Title: ${prData.title}`);
        
        // Check if this response contains changes
        if (prData.changes && Array.isArray(prData.changes)) {
          console.log(`✅ Found ${prData.changes.length} changes in corrected PR response`);
        } else {
          console.log(`⚠️ No changes found in corrected PR response`);
        }
      } else {
        console.warn(`⚠️ Corrected PR URL failed: ${response.status} ${response.statusText}`);
      }
      
      // Test the corrected changes endpoint
      const correctedChangesUrl = `${this.collectionUri}${correctedProjectId}/_apis/git/repositories/${this.repositoryName}/pullRequests/${this.pullRequestId}/changes?api-version=7.0`;
      console.log(`🔍 Testing corrected changes URL: ${correctedChangesUrl}`);
      
      const changesResponse = await fetch(correctedChangesUrl, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        agent: this.httpsAgent
      });
      
      if (changesResponse.ok) {
        const changesData = await changesResponse.json();
        console.log(`✅ Corrected changes URL working - Found ${changesData.value?.length || 0} changes`);
      } else {
        console.warn(`⚠️ Corrected changes URL failed: ${changesResponse.status} ${changesResponse.statusText}`);
        try {
          const errorBody = await changesResponse.text();
          console.log(`🔍 Corrected changes error response body:`, errorBody);
        } catch (e) {
          console.log(`🔍 Could not read corrected changes error response body`);
        }
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Corrected URL structure test failed:`, errorMessage);
    }
  }
}
