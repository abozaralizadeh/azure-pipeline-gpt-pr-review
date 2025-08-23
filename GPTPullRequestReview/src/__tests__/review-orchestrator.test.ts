import { ReviewOrchestrator } from '../services/review-orchestrator';
import { Agent } from 'https';

describe('ReviewOrchestrator', () => {
  let orchestrator: ReviewOrchestrator;
  let mockHttpsAgent: Agent;

  beforeEach(() => {
    mockHttpsAgent = {} as Agent;
    
    orchestrator = new ReviewOrchestrator(
      mockHttpsAgent,
      'https://test.openai.azure.com/',
      'test-api-key',
      'gpt-4',
      100,
      0.7,
      true,
      true
    );
  });

  describe('constructor', () => {
    it('should create a ReviewOrchestrator instance with correct configuration', () => {
      expect(orchestrator).toBeInstanceOf(ReviewOrchestrator);
    });
  });

  describe('private methods', () => {
    it('should identify binary files correctly', () => {
      const binaryFiles = [
        'image.png',
        'document.pdf',
        'archive.zip',
        'executable.exe',
        'library.dll'
      ];

      const nonBinaryFiles = [
        'script.js',
        'style.css',
        'index.html',
        'README.md',
        'package.json'
      ];

      binaryFiles.forEach(file => {
        expect((orchestrator as any).isBinaryFile(file)).toBe(true);
      });

      nonBinaryFiles.forEach(file => {
        expect((orchestrator as any).isBinaryFile(file)).toBe(false);
      });
    });

    it('should generate appropriate summary text', () => {
      const noIssues: any[] = [];
      const someIssues = [
        { type: 'improvement', confidence: 0.8 },
        { type: 'style', confidence: 0.7 }
      ];
      const criticalIssues = [
        { type: 'security', confidence: 0.9 },
        { type: 'bug', confidence: 0.8 }
      ];

      const noIssuesSummary = (orchestrator as any).generateSummaryText(noIssues, {});
      const someIssuesSummary = (orchestrator as any).generateSummaryText(someIssues, {});
      const criticalIssuesSummary = (orchestrator as any).generateSummaryText(criticalIssues, {});

      expect(noIssuesSummary).toContain('No issues found');
      expect(someIssuesSummary).toContain('2 issues');
      expect(someIssuesSummary).toContain('can be approved with suggestions');
      expect(criticalIssuesSummary).toContain('2 critical issues');
      expect(criticalIssuesSummary).toContain('requires changes');
    });

    it('should generate appropriate recommendations', () => {
      const noIssues: any[] = [];
      const securityIssues = [{ type: 'security' }];
      const bugIssues = [{ type: 'bug' }];
      const testIssues = [{ type: 'test' }];
      const styleIssues = [{ type: 'style' }];

      const noRecs = (orchestrator as any).generateRecommendations(noIssues);
      const securityRecs = (orchestrator as any).generateRecommendations(securityIssues);
      const bugRecs = (orchestrator as any).generateRecommendations(bugIssues);
      const testRecs = (orchestrator as any).generateRecommendations(testIssues);
      const styleRecs = (orchestrator as any).generateRecommendations(styleIssues);

      expect(noRecs).toContain('No specific recommendations');
      expect(securityRecs).toContain('🔒 Address 1 security vulnerabilities');
      expect(bugRecs).toContain('🐛 Fix 1 identified bugs');
      expect(testRecs).toContain('🧪 Add or improve tests');
      expect(styleRecs).toContain('🎨 Consider code style improvements');
    });
  });
});
