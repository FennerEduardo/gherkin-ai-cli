/* ==========================================================================
   gherkin-ai-cli - Real Coverage Integration Engine
   ========================================================================== */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { GherkinAIConfig } from './config';

export interface CoverageResult {
  success: boolean;
  coveragePercentage: number;
  targetPercentage: number;
  toolUsed: string;
  reportPath: string;
  errorMessage?: string;
}

export function runCoverage(projectDir: string, config: GherkinAIConfig): CoverageResult {
  const targetPercentage = config.rules.coverageTarget || 85;
  const stack = config.stack;

  let command = '';
  let toolUsed = '';
  let reportPath = '';

  try {
    if (stack.language === 'typescript' || stack.language === 'javascript') {
      toolUsed = 'Istanbul/c8 (Jest/Vitest)';
      command = 'npm test -- --coverage --coverageReporters="json-summary"';
      reportPath = path.join(projectDir, 'coverage', 'coverage-summary.json');
    } else if (stack.language === 'java') {
      toolUsed = 'JaCoCo';
      command = 'mvn test jacoco:report';
      reportPath = path.join(projectDir, 'target', 'site', 'jacoco', 'jacoco.csv');
    } else if (stack.language === 'csharp' || stack.language === 'dotnet') {
      toolUsed = 'coverlet (dotnet test)';
      command = 'dotnet test /p:CollectCoverage=true /p:CoverletOutputFormat=json';
      reportPath = path.join(projectDir, 'coverage.json');
    } else if (stack.language === 'python') {
      toolUsed = 'coverage.py (pytest)';
      command = 'pytest --cov=. --cov-report=json';
      reportPath = path.join(projectDir, 'coverage.json');
    } else if (stack.language === 'go') {
      toolUsed = 'go tool cover';
      command = 'go test -coverprofile=coverage.out ./... && go tool cover -func=coverage.out > coverage-summary.txt';
      reportPath = path.join(projectDir, 'coverage-summary.txt');
    } else {
      return {
        success: false,
        coveragePercentage: 0,
        targetPercentage,
        toolUsed: 'Unsupported',
        reportPath: '',
        errorMessage: `Coverage integration not yet supported for language: ${stack.language}`
      };
    }

    // Execute the coverage generation command
    try {
      execSync(command, { cwd: projectDir, stdio: 'pipe' });
    } catch (e: any) {
      // Tests might fail, but coverage report might still be generated
      console.warn(`[Coverage] Warning: Tests failed or coverage command exited with error. Analyzing generated report if available...`);
    }

    if (!fs.existsSync(reportPath)) {
      return {
        success: false,
        coveragePercentage: 0,
        targetPercentage,
        toolUsed,
        reportPath,
        errorMessage: `Coverage report not found at ${reportPath}. Ensure ${toolUsed} is installed and configured.`
      };
    }

    let coveragePercentage = 0;

    // Parse the generated report based on the tool
    if (toolUsed === 'Istanbul/c8 (Jest/Vitest)') {
      const summary = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      coveragePercentage = summary.total?.lines?.pct || 0;
    } else if (toolUsed === 'JaCoCo') {
      const csv = fs.readFileSync(reportPath, 'utf8');
      const lines = csv.split('\\n').filter(Boolean);
      let totalMissed = 0;
      let totalCovered = 0;
      // Simple parse of CSV (skip header)
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        // INSTRUCTION_MISSED is index 3, INSTRUCTION_COVERED is index 4 typically in JaCoCo CSV
        if (parts.length >= 5) {
          totalMissed += parseInt(parts[3] || '0', 10);
          totalCovered += parseInt(parts[4] || '0', 10);
        }
      }
      const total = totalMissed + totalCovered;
      coveragePercentage = total > 0 ? (totalCovered / total) * 100 : 0;
    } else if (toolUsed === 'coverlet (dotnet test)' || toolUsed === 'coverage.py (pytest)') {
      const summary = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      // Handle Python coverage.py JSON format
      if (summary.totals && typeof summary.totals.percent_covered !== 'undefined') {
        coveragePercentage = summary.totals.percent_covered;
      } 
      // Handle Coverlet JSON format
      else {
        // Just a basic fallback, Coverlet JSON is complex, but this supports a general extraction if present
        coveragePercentage = summary.total_coverage || 0;
      }
    } else if (toolUsed === 'go tool cover') {
      const txt = fs.readFileSync(reportPath, 'utf8');
      const match = txt.match(/total:\\s+\\(statements\\)\\s+([0-9.]+)%/);
      if (match && match[1]) {
        coveragePercentage = parseFloat(match[1]);
      }
    }

    return {
      success: coveragePercentage >= targetPercentage,
      coveragePercentage: Number(coveragePercentage.toFixed(2)),
      targetPercentage,
      toolUsed,
      reportPath
    };
  } catch (err: any) {
    return {
      success: false,
      coveragePercentage: 0,
      targetPercentage,
      toolUsed,
      reportPath,
      errorMessage: err.message
    };
  }
}
