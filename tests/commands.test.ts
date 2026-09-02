import { describe, it, expect, vi } from 'vitest';
import { handleDetectCommand } from '../src/commands/detect';
import { handleQualityCommand } from '../src/commands/quality';
import * as stackDetector from '../src/core/stack-detector';
import * as logger from '../src/utils/logger';
import fs from 'fs';

// Mocking dependencies
vi.mock('../src/core/stack-detector');
vi.mock('../src/utils/logger');
vi.mock('fs');

describe('CLI Commands Integration', () => {

  it('detect command should call stack detector and log success', async () => {
    const mockConfig = {
      projectName: 'test',
      projectMode: 'brownfield',
      architecture: 'hexagonal',
      stack: { language: 'typescript', framework: 'nextjs' }
    };
    
    // @ts-ignore
    stackDetector.detectExistingStack.mockReturnValue(mockConfig);
    
    await handleDetectCommand();
    
    expect(stackDetector.detectExistingStack).toHaveBeenCalled();
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('Stack detected'));
  });

  it('quality command should calculate coverage if coverage-summary.json exists', async () => {
    // @ts-ignore
    fs.existsSync.mockReturnValue(true);
    // @ts-ignore
    fs.readFileSync.mockReturnValue(JSON.stringify({
      total: {
        statements: { pct: 85 },
        branches: { pct: 90 },
        functions: { pct: 80 },
        lines: { pct: 85 }
      }
    }));

    await handleQualityCommand();
    
    expect(fs.readFileSync).toHaveBeenCalled();
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('Quality Gate Passed'));
  });
});
