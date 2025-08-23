// Test setup file for Jest
import { jest } from '@jest/globals';

// Mock Azure DevOps task library
jest.mock('azure-pipelines-task-lib/task', () => ({
  getVariable: jest.fn((name: string) => {
    const variables: { [key: string]: string } = {
      'Build.Reason': 'PullRequest',
      'SYSTEM.TEAMFOUNDATIONCOLLECTIONURI': 'https://dev.azure.com/',
      'SYSTEM.TEAMPROJECTID': 'test-project-id',
      'Build.Repository.Name': 'test-repo',
      'System.PullRequest.PullRequestId': '123',
      'SYSTEM.ACCESSTOKEN': 'test-token',
      'SYSTEM.TEAMPROJECT': 'test-project'
    };
    return variables[name] || '';
  }),
  getInput: jest.fn((name: string, required?: boolean) => {
    const inputs: { [key: string]: string } = {
      'azure_openai_endpoint': 'https://test.openai.azure.com/',
      'azure_openai_api_key': 'test-api-key',
      'azure_openai_deployment_name': 'gpt-4',
      'max_llm_calls': '100',
      'review_threshold': '0.7',
      'enable_code_suggestions': 'true',
      'enable_security_scanning': 'true',
      'support_self_signed_certificate': 'false'
    };
    const value = inputs[name];
    if (required && !value) {
      throw new Error(`Required input '${name}' not provided`);
    }
    return value || '';
  }),
  getBoolInput: jest.fn((name: string) => {
    const inputs: { [key: string]: boolean } = {
      'enable_code_suggestions': true,
      'enable_security_scanning': true,
      'support_self_signed_certificate': false
    };
    return inputs[name] || false;
  }),
  setResult: jest.fn(),
  TaskResult: {
    Succeeded: 0,
    Failed: 1,
    Skipped: 2
  }
}));

// Mock fetch for testing
(global as any).fetch = jest.fn();

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
};

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com/';
process.env.AZURE_OPENAI_API_KEY = 'test-api-key';
process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'gpt-4';
