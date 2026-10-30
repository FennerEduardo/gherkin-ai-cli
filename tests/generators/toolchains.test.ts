import { describe, it, expect } from 'vitest';
import path from 'path';
import { defaultConfig } from '../../src/core/config';
import { TOOLCHAINS, resolveToolchain } from '../../src/generators/toolchains';
import { STACK_SUPPORT } from '../../src/generators/stack-support';
import { getStackDockerDetails } from '../../src/generators/infra';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { STACKS } = require(path.resolve(__dirname, '../../scripts/golden-stacks.js')) as { STACKS: Record<string, { image: string }> };

describe('toolchain registry', () => {
  it('uses the same image as the golden build of every stable backend', () => {
    for (const s of STACK_SUPPORT.filter(x => x.kind === 'backend')) {
      // A BFF (stack.role "bff") builds with the toolchain of its framework.
      const id = /^(typescript|bff)\/nestjs/.test(s.id) ? 'typescript/nestjs' : /^(typescript|bff)\/express/.test(s.id) ? 'typescript/express' : s.id === 'bff/spring' ? 'java/spring' : s.id;
      expect(TOOLCHAINS[id], s.id).toBeDefined();
      expect(TOOLCHAINS[id].image, s.id).toBe(STACKS[s.golden!].image);
    }
  });

  it('resolves configs to their toolchain, which docker details reuse', () => {
    const cfg = (language: string, framework: string) => ({ ...defaultConfig, stack: { ...defaultConfig.stack, language, framework } });
    expect(resolveToolchain(cfg('java', 'spring-boot'))!.image).toBe('maven:3.9-eclipse-temurin-17');
    expect(resolveToolchain(cfg('typescript', 'nestjs'))!.image).toBe('node:24-bookworm');
    expect(getStackDockerDetails(cfg('python', 'django'))).toMatchObject({ image: 'python:3.12-slim', testCmd: expect.stringContaining('pytest') });
    expect(getStackDockerDetails(cfg('go', 'chi')).image).toBe('golang:1.26');
  });
});
