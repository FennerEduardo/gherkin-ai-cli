import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleDetectCommand } from '../src/commands/detect';
import { handleQualityCommand } from '../src/commands/quality';
import * as stackDetector from '../src/core/stack-detector';
import { logger } from '../src/utils/logger';
import fs from 'fs';

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({ confirmStack: true, applySuggestions: true })
  }
}));

describe('CLI Commands Integration', () => {

  beforeEach(() => {
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detect command should call stack detector and log success', async () => {
    const mockConfig = {
      projectName: 'test',
      projectMode: 'brownfield',
      architecture: 'hexagonal',
      stack: { language: 'typescript', framework: 'nextjs' }
    };
    
    // @ts-ignore
    const detectSpy = vi.spyOn(stackDetector, 'detectExistingStack').mockReturnValue(mockConfig);
    
    await handleDetectCommand();
    
    expect(detectSpy).toHaveBeenCalled();
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('Saved detected project'));
  });

  it('quality command should calculate coverage if coverage-summary.json exists', async () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (p.toString().includes('coverage-summary.json')) return true;
      if (p.toString().includes('specs')) return true;
      return false;
    });

    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p.toString().includes('coverage-summary.json')) {
        return JSON.stringify({
          total: {
            statements: { pct: 85 },
            branches: { pct: 90 },
            functions: { pct: 80 },
            lines: { pct: 85 }
          }
        });
      }
      return '';
    });

    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((p) => {
      // @ts-ignore
      return ['login.feature', 'checkout.feature'];
    });

    await handleQualityCommand();
    
    expect(existsSpy).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('FAIL:'));
  });
});
