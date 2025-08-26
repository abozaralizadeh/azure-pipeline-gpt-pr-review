import * as tl from "azure-pipelines-task-lib/task";

export function getTargetBranchName(): string | null {
  const targetBranch = tl.getVariable('System.PullRequest.TargetBranch');
  if (targetBranch) {
    return targetBranch.replace('refs/heads/', '');
  }
  return null;
}

export function getSourceBranchName(): string | null {
  const sourceBranch = tl.getVariable('System.PullRequest.SourceBranch');
  if (sourceBranch) {
    return sourceBranch.replace('refs/heads/', '');
  }
  return null;
}

export function getPullRequestId(): string | null {
  return tl.getVariable('System.PullRequest.PullRequestId') || null;
}

export function getRepositoryName(): string | null {
  return tl.getVariable('Build.Repository.Name') || null;
}

export function getProjectName(): string | null {
  return tl.getVariable('System.TeamProject') || null;
}