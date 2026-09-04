/* ==========================================================================
   gherkin-ai-cli - Error Parser & Failure Diagnosis Generator
   ========================================================================== */

import { SandboxResult } from './execution-sandbox';

export interface FailureDiagnosis {
  summary: string;
  failedTestCases: string[];
  affectedFiles: string[];
  cleanedStackTrace: string;
  suggestedFixContext: string;
  confidenceScore: number;
  suggestedActions: string[];
  agentName?: string;
}

export function parseExecutionFailure(result: SandboxResult, agentName?: string): FailureDiagnosis {
  const combinedLog = `${result.stdout}\n${result.stderr}`;
  const lines = combinedLog.split('\n');

  const failedTestCases: string[] = [];
  const affectedFilesSet = new Set<string>();
  const relevantLines: string[] = [];

  // Match typical test failures across Jest, Vitest, JUnit, Pytest, Playwright
  const testFailRegex = /(?:✕|FAIL|FAILED|Error:|AssertionError|FAILURES!|expected|received).*/i;
  const fileRefRegex = /(?:at\s+|in\s+|\.\/|src\/|test\/|specs\/)([\w\-\/\.]+\.(?:ts|js|jsx|tsx|java|py|go|cs)):(\d+)?/g;

  for (const line of lines) {
    if (testFailRegex.test(line)) {
      relevantLines.push(line.trim());
      if (line.includes('✕') || line.includes('FAIL') || line.includes('Test')) {
        failedTestCases.push(line.trim());
      }
    }

    let match;
    while ((match = fileRefRegex.exec(line)) !== null) {
      if (match[1] && !match[1].includes('node_modules')) {
        affectedFilesSet.add(match[1]);
      }
    }
  }

  const affectedFiles = Array.from(affectedFilesSet);
  const cleanedStackTrace = relevantLines.slice(0, 30).join('\n') || combinedLog.slice(0, 1500);

  return {
    summary: `Suite execution failed with exit code ${result.exitCode}. Found ${failedTestCases.length || 1} failure points.`,
    failedTestCases: failedTestCases.length > 0 ? failedTestCases : ['Test suite execution failure'],
    affectedFiles,
    cleanedStackTrace,
    suggestedFixContext: `Fix the underlying code in [${affectedFiles.join(', ')}] to resolve:\n${cleanedStackTrace}`,
    confidenceScore: affectedFiles.length > 0 ? 0.92 : 0.75,
    suggestedActions: [
      'Check if the test command matches your project structure.',
      'Review the modified files for compilation or logical errors.',
      'Consider running the tests manually to get more details.'
    ],
    agentName
  };
}
