import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { executeSandbox, detectDefaultTestCommand } from '../../src/core/execution-sandbox';
import * as childProcess from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

describe('Execution Sandbox', () => {
  const testDir = path.join(process.cwd(), '.test-sandbox');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('detectDefaultTestCommand()', () => {
    it('should detect jest when jest.config.js exists', () => {
      fs.writeFileSync(path.join(testDir, 'jest.config.js'), '');
      expect(detectDefaultTestCommand(testDir)).toBe('npx jest');
    });

    it('should detect vitest when vitest.config.ts exists', () => {
      fs.writeFileSync(path.join(testDir, 'vitest.config.ts'), '');
      expect(detectDefaultTestCommand(testDir)).toBe('npx vitest run');
    });

    it('should detect playwright', () => {
      fs.writeFileSync(path.join(testDir, 'playwright.config.ts'), '');
      expect(detectDefaultTestCommand(testDir)).toBe('npx playwright test');
    });

    it('should detect maven', () => {
      fs.writeFileSync(path.join(testDir, 'pom.xml'), '');
      expect(detectDefaultTestCommand(testDir)).toBe('mvn test');
    });

    it('should detect gradle', () => {
      fs.writeFileSync(path.join(testDir, 'build.gradle'), '');
      expect(detectDefaultTestCommand(testDir)).toBe('gradle test');
    });

    it('should detect pytest', () => {
      fs.writeFileSync(path.join(testDir, 'pyproject.toml'), '');
      expect(detectDefaultTestCommand(testDir)).toBe('pytest');
    });

    it('should detect go test', () => {
      fs.writeFileSync(path.join(testDir, 'go.mod'), '');
      expect(detectDefaultTestCommand(testDir)).toBe('go test ./...');
    });

    it('should read test scripts from package.json', () => {
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({
        scripts: { test: 'npm test' }
      }));
      expect(detectDefaultTestCommand(testDir)).toBe('npm test');
    });

    it('should include setup scripts if present in package.json', () => {
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({
        scripts: { 
          test: 'jest',
          'db:push': 'prisma db push',
          'db:seed': 'prisma db seed'
        }
      }));
      const cmd = detectDefaultTestCommand(testDir);
      expect(cmd).toContain('npm run db:push');
      expect(cmd).toContain('npm run db:seed');
      expect(cmd).toContain('npm test');
    });

    it('should fallback to npm test if no files found', () => {
      expect(detectDefaultTestCommand(testDir)).toBe('npm test');
    });
  });

  describe('executeSandbox()', () => {
    it('should execute provided command successfully', () => {
      // execSync is called with encoding: 'utf8' so it returns a string
      vi.mocked(childProcess.execSync).mockReturnValue('Test passed' as any);
      
      const result = executeSandbox({ command: 'echo "hello"', cwd: testDir });
      
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Test passed');
      expect(childProcess.execSync).toHaveBeenCalledWith(
        'echo "hello"',
        expect.objectContaining({ cwd: testDir })
      );
    });

    it('should prefer configCommand over auto-detected', () => {
      vi.mocked(childProcess.execSync).mockReturnValue('' as any);
      fs.writeFileSync(path.join(testDir, 'jest.config.js'), ''); // auto-detects jest
      
      executeSandbox({ configCommand: 'npm run custom-test', cwd: testDir });
      
      expect(childProcess.execSync).toHaveBeenCalledWith(
        'npm run custom-test',
        expect.any(Object)
      );
    });

    it('should handle execution failure', () => {
      const error = new Error('Command failed') as any;
      error.status = 1;
      error.stdout = Buffer.from('Output before failure');
      error.stderr = Buffer.from('Error trace');
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw error;
      });
      
      const result = executeSandbox({ command: 'npm test', cwd: testDir });
      
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Output before failure');
      expect(result.stderr).toContain('Error trace');
    });

    it('runs docker without a host shell, in a hardened container with the requested image', () => {
      vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 0, stdout: 'ok', stderr: '' } as any);

      const result = executeSandbox({ command: 'go test ./...', docker: true, dockerImage: 'golang:1.22', cwd: testDir });

      expect(result.success).toBe(true);
      expect(childProcess.execSync).not.toHaveBeenCalled();
      const [bin, args] = vi.mocked(childProcess.spawnSync).mock.calls[0] as [string, string[]];
      expect(bin).toBe('docker');
      const flag = (name: string) => args[args.indexOf(name) + 1];
      expect(flag('--network')).toBe('none');
      expect(flag('--memory')).toBe('2g');
      expect(flag('--pids-limit')).toBe('512');
      expect(flag('--cap-drop')).toBe('ALL');
      expect(flag('--security-opt')).toBe('no-new-privileges');
      expect(args).toContain('--read-only');
      expect(args.slice(-4)).toEqual(['golang:1.22', 'sh', '-c', 'go test ./...']);
    });

    it('lets the caller relax the network and limits', () => {
      vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: 'fail' } as any);
      const result = executeSandbox({ command: 'npm test', docker: true, cwd: testDir, limits: { network: 'bridge', memory: '4g' } });
      const args = vi.mocked(childProcess.spawnSync).mock.calls[0][1] as string[];
      expect(args[args.indexOf('--network') + 1]).toBe('bridge');
      expect(args[args.indexOf('--memory') + 1]).toBe('4g');
      expect(result).toMatchObject({ success: false, exitCode: 1, stderr: 'fail' });
    });

    it('should respect custom timeout', () => {
      vi.mocked(childProcess.execSync).mockReturnValue('' as any);
      
      executeSandbox({ command: 'npm test', timeoutMs: 5000, cwd: testDir });
      
      expect(childProcess.execSync).toHaveBeenCalledWith(
        'npm test',
        expect.objectContaining({ timeout: 5000 })
      );
    });
  });
});

describe('dockerRunArgs', () => {
  it('keeps the defaults for limits that are present but undefined', async () => {
    const { dockerRunArgs } = await import('../../src/core/execution-sandbox');
    const args = dockerRunArgs('/p', 'node:22', 'npm test', { network: undefined, memory: '4g' } as any);
    expect(args.join(' ')).toContain('--network none');
    expect(args.join(' ')).toContain('--memory 4g');
    expect(args).not.toContain('undefined');
  });

  it('mounts the dependency caches as named volumes, writable under the read-only root', async () => {
    const { dockerRunArgs } = await import('../../src/core/execution-sandbox');
    const args = dockerRunArgs('/p', 'golang:1.26', 'go test ./...', {}, {}, { caches: [['gomod', '/go/pkg/mod']] }).join(' ');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop ALL');
    expect(args).toContain('-v ghk-cache-gomod:/go/pkg/mod');
  });

  it('keeps the image root and capabilities in the toolchain profile, with the limits', async () => {
    const { dockerRunArgs } = await import('../../src/core/execution-sandbox');
    const args = dockerRunArgs('/p', 'python:3.12-slim', 'pip install -e .', { network: 'ghk-net-1' }, {}, { profile: 'toolchain' }).join(' ');
    expect(args).not.toContain('--read-only');
    expect(args).not.toContain('--cap-drop');
    expect(args).not.toContain('HOME=/tmp');
    expect(args).toContain('--security-opt no-new-privileges');
    expect(args).toContain('--memory 2g');
  });

  it('gives every backend toolchain its dependency caches', async () => {
    const { resolveToolchain } = await import('../../src/generators/toolchains');
    for (const stack of [{ language: 'go', framework: 'chi' }, { language: 'java', framework: 'quarkus' }, { language: 'kotlin', framework: 'spring-boot' }, { language: 'typescript', framework: 'nestjs' }]) {
      expect(resolveToolchain({ stack } as any)?.caches?.length, stack.language).toBeGreaterThan(0);
    }
    expect(resolveToolchain({ stack: { language: 'kotlin', framework: 'spring-boot' } } as any)?.env).toMatchObject({ GRADLE_USER_HOME: '/cache/gradle' });
  });
});
