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

  // Enhanced regex patterns for capturing language-specific stack traces and core errors
  const testFailRegex = /(?:✕|FAIL|FAILED|Error:|AssertionError|FAILURES!|expected|received|Exception:|Unhandled Rejection|panic:).*/i;
  const fileRefRegex = /(?:at\s+|in\s+|\.\/|src\/|test\/|specs\/)([\w\-\/\.]+\.(?:ts|js|jsx|tsx|java|py|go|cs)):(\d+)?/g;
  
  // Framework noise filters (Mini-RAG technique to shrink context window)
  const noisyStackRegex = /node_modules|org\.springframework|java\.base|sun\.reflect|pytest|xunit|nunit|mass_transit/i;

  let inStackTrace = false;
  let currentTrace = [];

  for (const line of lines) {
    // Start of a stack trace or exception block
    if (testFailRegex.test(line) || line.includes('Traceback (most recent call last):') || line.includes('Exception in thread')) {
      inStackTrace = true;
      relevantLines.push(line.trim());
      if (line.includes('✕') || line.includes('FAIL') || line.includes('Test')) {
        failedTestCases.push(line.trim());
      }
    } else if (inStackTrace) {
      // Capture stack trace lines, filtering out framework internals to compress context
      const isStackLine = /^\s*(at |File |line |\s+\w+\.\w+\(|\s*--->)/i.test(line);
      
      if (isStackLine) {
        if (!noisyStackRegex.test(line)) {
          relevantLines.push(line.trim());
        }
      } else if (line.trim() === '') {
        // Empty lines might mean end of stack trace, but we tolerate a few
        inStackTrace = false; 
      } else {
        // If it's a message attached to an exception, keep it
        relevantLines.push(line.trim());
      }
    }

    // Extract affected files from the raw line regardless of stack context
    let match;
    while ((match = fileRefRegex.exec(line)) !== null) {
      if (match[1] && !noisyStackRegex.test(match[1])) {
        affectedFilesSet.add(match[1]);
      }
    }
  }

  // Deduplicate and limit lines to drastically reduce LLM context window
  const uniqueRelevantLines = [...new Set(relevantLines)];
  const affectedFiles = Array.from(affectedFilesSet);
  
  // The 'Mini-RAG' compressor: Only keep the most critical 25 lines (e.g. top of the stack)
  const cleanedStackTrace = uniqueRelevantLines.slice(0, 25).join('\n') || combinedLog.slice(0, 1000);

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
