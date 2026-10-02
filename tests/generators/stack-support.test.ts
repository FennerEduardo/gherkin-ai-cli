import { describe, it, expect } from 'vitest';
import path from 'path';
import { STACK_SUPPORT, getStackSupport, supportWarning } from '../../src/generators/stack-support';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { STACKS } = require(path.resolve(__dirname, '../../scripts/golden-stacks.js')) as { STACKS: Record<string, unknown> };

describe('stack support matrix', () => {
  it('every stable entry is verified by a golden build that exists', () => {
    for (const s of STACK_SUPPORT.filter(x => x.tier === 'stable')) {
      expect(s.golden, s.id).toBeDefined();
      expect(Object.keys(STACKS), `${s.id} -> ${s.golden}`).toContain(s.golden);
    }
  });

  it('every golden build is referenced by the support matrix', () => {
    const referenced = new Set(STACK_SUPPORT.map(s => s.golden));
    for (const name of Object.keys(STACKS)) expect(referenced.has(name), name).toBe(true);
  });

  it('routes configs to their stack and warns only for unsupported ones', () => {
    const stack = (language: string, framework: string) => ({ stack: { language, framework, orm: '', database: '', validation: '', auth: '', testing: '' } });
    expect(getStackSupport(stack('python', 'django')).id).toBe('python/django');
    expect(getStackSupport(stack('python', 'fastapi')).id).toBe('python/fastapi');
    expect(getStackSupport(stack('typescript', 'express')).id).toBe('typescript/express');
    expect(getStackSupport(stack('elixir', 'phoenix')).id).toBe('elixir/phoenix');
    expect(supportWarning(getStackSupport(stack('java', 'spring-boot')))).toBeUndefined();
    expect(supportWarning(getStackSupport(stack('cobol', 'cics')))).toMatch(/EXPERIMENTAL/);
  });
});
