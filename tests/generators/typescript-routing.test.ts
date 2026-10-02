import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { getStackSupport } from '../../src/generators/stack-support';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const cfg = (framework: string, frontendStack?: any) => ({ ...defaultConfig, stack: { ...defaultConfig.stack, language: 'typescript', framework }, frontendStack });

describe('TypeScript stacks without a NestJS/Express backend', () => {
  it.each([
    ['react', 'frontend/package.json', 'frontend/react'],
    ['vue', 'frontend/package.json', 'frontend/vue'],
    ['next', 'frontend/package.json', 'frontend/nextjs'],
    ['expo', 'frontend/package.json', 'frontend/react-native']
  ])('stack.framework %s renders the stable frontend project', (framework, file, support) => {
    const files = generatePresets(parsed, cfg(framework));
    expect(files.some(f => f.filename === file)).toBe(true);
    expect(getStackSupport(cfg(framework))).toMatchObject({ id: support, tier: 'stable' });
  });

  it('renders the frontend once when stack and frontendStack name the same framework', () => {
    const files = generatePresets(parsed, cfg('react', { framework: 'react', language: 'typescript' }));
    expect(files.filter(f => f.filename === 'frontend/package.json')).toHaveLength(1);
  });

  it('"nest" is an alias of the NestJS preset', () => {
    expect(getStackSupport(cfg('nest')).id).toBe('typescript/nestjs');
    expect(generatePresets(parsed, cfg('nest')).some(f => f.filename === 'src/app.module.ts')).toBe(true);
  });

  it('backends without a preset (fastify) emit no placeholder files and are reported experimental', () => {
    expect(generatePresets(parsed, cfg('fastify'))).toEqual([]);
    expect(getStackSupport(cfg('fastify')).tier).toBe('experimental');
  });
});
