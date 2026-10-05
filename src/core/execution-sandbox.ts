/* ==========================================================================
   gherkin-ai-cli - Test execution for closed-loop verification

   On the host, or with `docker` in a disposable, resource-limited container
   (see dockerRunArgs). The container is an isolation and reproducibility
   boundary for test runs, not a defense against a malicious project: the
   project directory is mounted read-write.
   ========================================================================== */

import { execSync, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { TOOLCHAINS } from '../generators/toolchains';

export interface ContainerLimits {
  /** Docker network ("none" by default: tests cannot reach the network or exfiltrate data). */
  network?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
}

export interface SandboxExecutionOptions {
  command?: string;
  configCommand?: string;
  cwd?: string;
  docker?: boolean;
  dockerImage?: string;
  limits?: ContainerLimits;
  timeoutMs?: number;
}

export const DEFAULT_CONTAINER_LIMITS: Required<ContainerLimits> = { network: 'none', memory: '2g', cpus: '2', pidsLimit: 512 };

/**
 * `docker run` arguments for a hardened, disposable test container: no network by default,
 * CPU/memory/process limits, no Linux capabilities, no privilege escalation, read-only root
 * filesystem with a writable /tmp. Only the project directory is mounted (read-write, so
 * builds can write their outputs). The command runs through `sh -c` inside the container,
 * never through a host shell.
 */
export function dockerRunArgs(cwd: string, image: string, command: string, limits: ContainerLimits = {}): string[] {
  const l = { ...DEFAULT_CONTAINER_LIMITS, ...limits };
  return [
    'run', '--rm',
    '--network', l.network,
    '--memory', l.memory,
    '--cpus', l.cpus,
    '--pids-limit', String(l.pidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,size=1g',
    '-e', 'HOME=/tmp',
    '-e', 'CI=true',
    '-v', `${cwd}:/work`,
    '-w', '/work',
    image,
    'sh', '-c', command
  ];
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

  const commandToRun = options.command || options.configCommand || detectDefaultTestCommand(cwd);

  if (options.docker) {
    const image = options.dockerImage || 'node:24-bookworm';
    const args = dockerRunArgs(cwd, image, commandToRun, options.limits);
    const res = spawnSync('docker', args, { cwd, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return {
      success: res.status === 0,
      exitCode: res.status ?? 1,
      stdout: res.stdout || '',
      stderr: res.stderr || (res.error ? res.error.message : ''),
      durationMs: Date.now() - startTime,
      commandExecuted: ['docker', ...args].join(' ')
    };
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

export function validateStackCompilation(projectDir: string, stack: 'java' | 'dotnet' | 'node' | 'python' | 'go'): SandboxResult {
  let hasLocalSdk = false;
  let command = '';
  let dockerImage = '';

  const toolchainId = { java: 'java/spring', dotnet: 'csharp/dotnet', python: 'python/fastapi', go: 'go/chi', node: 'typescript/nestjs' }[stack];
  const toolchain = TOOLCHAINS[toolchainId];
  const tool = { java: 'mvn', dotnet: 'dotnet', python: 'python3', go: 'go', node: 'npx' }[stack];
  hasLocalSdk = isToolAvailable(tool);
  command = [...toolchain.build, ...toolchain.test].join(' && ');
  dockerImage = toolchain.image;

  if (hasLocalSdk) {
    return executeSandbox({ cwd: projectDir, command });
  }
  // Building restores dependencies, so this container needs network access.
  return executeSandbox({ cwd: projectDir, command, docker: true, dockerImage, limits: { network: 'bridge' } });
}

function isToolAvailable(toolName: string): boolean {
  try {
    const res = spawnSync(toolName, ['--version'], { encoding: 'utf8', shell: true });
    return res.status === 0;
  } catch {
    return false;
  }
}

