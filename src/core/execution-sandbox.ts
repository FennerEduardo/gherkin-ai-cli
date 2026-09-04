/* ==========================================================================
   gherkin-ai-cli - Execution Sandbox for Closed-Loop Verification
   ========================================================================== */

import { execSync, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface SandboxExecutionOptions {
  command?: string;
  configCommand?: string;
  cwd?: string;
  docker?: boolean;
  dockerImage?: string;
  timeoutMs?: number;
}

export interface SandboxResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  commandExecuted: string;
}

export function executeSandbox(options: SandboxExecutionOptions = {}): SandboxResult {
  const cwd = options.cwd || process.cwd();
  // Use a longer default timeout for large projects (300000 = 5 mins)
  const timeout = options.timeoutMs || 300000;
  const startTime = Date.now();

  let commandToRun = options.command || options.configCommand || detectDefaultTestCommand(cwd);

  if (options.docker) {
    const imageName = options.dockerImage || 'node:20-alpine';
    commandToRun = `docker run --rm -v "${cwd}:/app" -w /app ${imageName} ${commandToRun}`;
  }

  try {
    const output = execSync(commandToRun, {
      cwd,
      timeout,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }
    });

    return {
      success: true,
      exitCode: 0,
      stdout: output || '',
      stderr: '',
      durationMs: Date.now() - startTime,
      commandExecuted: commandToRun
    };
  } catch (error: any) {
    return {
      success: false,
      exitCode: error.status || 1,
      stdout: error.stdout ? error.stdout.toString() : '',
      stderr: error.stderr ? error.stderr.toString() : error.message || 'Execution failed',
      durationMs: Date.now() - startTime,
      commandExecuted: commandToRun
    };
  }
}

export function detectDefaultTestCommand(projectDir: string): string {
  // Advanced Test Runner Detection for Large Projects
  if (fs.existsSync(path.join(projectDir, 'jest.config.js')) || fs.existsSync(path.join(projectDir, 'jest.config.ts'))) {
    return 'npx jest';
  }
  if (fs.existsSync(path.join(projectDir, 'vitest.config.ts'))) {
    return 'npx vitest run';
  }
  if (fs.existsSync(path.join(projectDir, 'playwright.config.ts'))) {
    return 'npx playwright test';
  }

  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      let baseCmd = pkg.scripts?.test ? 'npm test' : 'npx jest';
      
      // Setup phase detection (e.g., db seed or push)
      if (pkg.scripts?.['db:push'] || pkg.scripts?.['db:seed'] || pkg.scripts?.['test:setup']) {
        const setups = [];
        if (pkg.scripts['db:push']) setups.push('npm run db:push');
        if (pkg.scripts['db:seed']) setups.push('npm run db:seed');
        if (pkg.scripts['test:setup']) setups.push('npm run test:setup');
        
        if (setups.length > 0) {
          return `${setups.join(' && ')} && ${baseCmd}`;
        }
      }

      if (pkg.scripts?.test) return 'npm test';
    } catch (_) {}
  }

  if (fs.existsSync(path.join(projectDir, 'pom.xml'))) {
    return 'mvn test';
  }
  if (fs.existsSync(path.join(projectDir, 'build.gradle'))) {
    return 'gradle test';
  }
  if (fs.existsSync(path.join(projectDir, 'pytest.ini')) || fs.existsSync(path.join(projectDir, 'pyproject.toml'))) {
    return 'pytest';
  }
  if (fs.existsSync(path.join(projectDir, 'go.mod'))) {
    return 'go test ./...';
  }

  return 'npm test';
}
