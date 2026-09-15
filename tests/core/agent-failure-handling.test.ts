import { describe, it, expect } from 'vitest';
import { RealAgentProvider, DefaultCliAgentProvider, saveFailedAttemptLog, LLMConfig } from '../../src/core/agent-adapter';
import fs from 'fs';
import path from 'path';

describe('Agent Failure Handling', () => {
  // ── DefaultCliAgentProvider ────────────────────────────────────────
  describe('DefaultCliAgentProvider', () => {
    it('should always return success with delegation prompt', async () => {
      const provider = new DefaultCliAgentProvider();
      const result = await provider.executeTask({
        id: 'test-task',
        type: 'spec_generation',
        prompt: 'Generate a feature',
        contextFiles: ['file1.ts', 'file2.ts']
      });

      expect(result.success).toBe(true);
      expect(result.agentResponse).toContain('IDE Delegation Prompt');
      expect(result.agentResponse).toContain('spec_generation');
      expect(result.agentResponse).toContain('file1.ts');
    });
  });

  // ── RealAgentProvider — IDE Delegate fallback ──────────────────────
  describe('RealAgentProvider with ide_delegate', () => {
    it('should delegate to DefaultCliAgentProvider when provider is ide_delegate', async () => {
      const config: LLMConfig = {
        provider: 'ide_delegate',
        model: undefined,
        apiKey: undefined,
        baseUrl: undefined
      };
      const provider = new RealAgentProvider(config);
      const result = await provider.executeTask({
        id: 'test-delegate',
        type: 'auto_fix',
        prompt: 'Fix the tests'
      });

      expect(result.success).toBe(true);
      expect(result.agentResponse).toContain('IDE Delegation Prompt');
    });
  });

  // ── extractCodeModifications (via private method testing through executeTask) ──
  describe('Code Modification Extraction', () => {
    it('should handle empty codeModifications gracefully', async () => {
      const config: LLMConfig = {
        provider: 'ide_delegate',
        model: undefined,
        apiKey: undefined,
        baseUrl: undefined
      };
      const provider = new RealAgentProvider(config);
      const result = await provider.executeTask({
        id: 'test-empty',
        type: 'spec_generation',
        prompt: 'Do nothing'
      });

      // IDE delegate doesn't return codeModifications
      expect(result.success).toBe(true);
      expect(result.codeModifications).toBeUndefined();
    });
  });

  // ── saveFailedAttemptLog ───────────────────────────────────────────
  describe('saveFailedAttemptLog', () => {
    it('should create a diagnostic log file with correct content', () => {
      const logPath = saveFailedAttemptLog(
        'test-task-123',
        'Test prompt content',
        'Raw agent response here',
        'JSON parse error'
      );

      expect(fs.existsSync(logPath)).toBe(true);
      
      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('TASK ID: test-task-123');
      expect(content).toContain('Test prompt content');
      expect(content).toContain('Raw agent response here');
      expect(content).toContain('JSON parse error');
      expect(content).toContain('Timestamp:');

      // Cleanup
      fs.unlinkSync(logPath);
    });

    it('should create the autopilot logs directory if it does not exist', () => {
      const logDir = path.resolve('.gherkin-ai', 'logs', 'autopilot');
      const logPath = saveFailedAttemptLog('dir-test', 'p', 'r');

      expect(fs.existsSync(logDir)).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);

      // Cleanup
      fs.unlinkSync(logPath);
    });
  });
});
