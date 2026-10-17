import { describe, it, expect } from 'vitest';
import path from 'path';
import { defaultConfig } from '../../src/core/config';
import { renderContainerFiles } from '../../src/generators/deploy/container';
import { resolveHealth } from '../../src/generators/toolchains';
import { STACK_SUPPORT } from '../../src/generators/stack-support';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { STACKS } = require(path.resolve(__dirname, '../../scripts/golden-stacks.js')) as { STACKS: Record<string, { stack: any; integration?: string[] }> };

const cfg = (stack: any) => ({ ...defaultConfig, projectName: 'orders-svc', stack: { ...defaultConfig.stack, ...stack } });
const dockerfile = (stack: any) => renderContainerFiles(cfg(stack)).find(f => f.filename === 'Dockerfile')?.content;

describe('production container image', () => {
  it('is generated for every backend golden build with runtime integration tests', () => {
    for (const [name, def] of Object.entries(STACKS).filter(([, d]) => d.integration)) {
      const files = renderContainerFiles(cfg(def.stack));
      expect(files.map(f => f.filename), name).toEqual(['Dockerfile', '.dockerignore']);
    }
  });

  it('builds in stages and runs as a non-root user', () => {
    for (const [name, def] of Object.entries(STACKS).filter(([, d]) => d.integration)) {
      const content = dockerfile(def.stack)!;
      expect(content, name).toMatch(/^USER /m);
      expect(content, name).not.toMatch(/^USER (root|0)\b/m);
      if (def.stack.language !== 'elixir') expect(content.match(/^FROM /gm)!.length, name).toBeGreaterThanOrEqual(2);
    }
  });

  it('documents the port and probes and keeps secrets and local state out of the build context', () => {
    const files = renderContainerFiles(cfg({ language: 'java', framework: 'quarkus', orm: 'jdbc' }));
    expect(files[0].content).toContain('probes: liveness /q/health/live, readiness /q/health/ready');
    expect(files[0].content).toContain('EXPOSE 8080');
    expect(files[1].content.split('\n')).toEqual(expect.arrayContaining(['.env', '.ghe', 'target']));
  });

  it('names the stack artefacts after the project (.NET assembly, Rust binary)', () => {
    expect(dockerfile({ language: 'csharp', framework: 'aspnet-core' })).toContain('ENTRYPOINT ["dotnet", "orders-svc.dll"]');
    expect(dockerfile({ language: 'rust', framework: 'axum' })).toContain('cargo build --release --bin orders_svc');
  });

  it('runs Django with gunicorn and debug off', () => {
    const content = dockerfile({ language: 'python', framework: 'django' })!;
    expect(content).toContain('"gunicorn", "config.wsgi:application"');
    expect(content).toContain('DJANGO_DEBUG=false');
  });

  it('is not generated for frontends or experimental stacks', () => {
    expect(renderContainerFiles(cfg({ language: 'typescript', framework: 'react' }))).toEqual([]);
    expect(renderContainerFiles(cfg({ language: 'kotlin', framework: 'ktor' }))).toEqual([]);
  });

  it('exposes readiness separately where the stack checks the database', () => {
    expect(resolveHealth(cfg({ language: 'java', framework: 'spring-boot' }))).toEqual({ live: '/health', ready: '/health/ready' });
    expect(resolveHealth(cfg({ language: 'php', framework: 'laravel' }))).toEqual({ live: '/up', ready: '/up' });
    expect(resolveHealth(cfg({ language: 'go', framework: 'chi' }))).toEqual({ live: '/health', ready: '/health' });
    expect(STACK_SUPPORT.length).toBeGreaterThan(0);
  });
});
