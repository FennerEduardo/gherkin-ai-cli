import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { artifactRole, isSourceCode } from '../../src/core/artifact-roles';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const STACKS: [string, string][] = [
  ['java', 'spring-boot'], ['java', 'quarkus'], ['kotlin', 'spring-boot'], ['kotlin', 'quarkus'], ['csharp', 'dotnet'],
  ['typescript', 'nestjs'], ['typescript', 'express'], ['python', 'fastapi'], ['python', 'django'], ['go', 'chi'],
  ['php', 'laravel'], ['ruby', 'rails'], ['elixir', 'phoenix'], ['rust', 'axum']
];
const files = (language: string, framework: string) =>
  generatePresets(parsed, { ...defaultConfig, projectName: 'orders', stack: { ...defaultConfig.stack, language, framework } });

describe('artifact roles', () => {
  it('classifies paths', () => {
    expect(artifactRole('src/main/java/acme/runtime/OutboxRelay.java')).toBe('kernel');
    expect(artifactRole('src/main/java/acme/runtime/RuntimeConfiguration.java')).toBe('wiring');
    expect(artifactRole('internal/runtime/http_integration_test.go')).toBe('wiring');
    expect(artifactRole('src/domain/order.ts')).toBe('kernel');
    expect(artifactRole('contracts/orders/asyncapi.json')).toBe('contract');
    expect(artifactRole('openapi.json')).toBe('contract');
    expect(artifactRole('notes.md', 'openapi')).toBe('contract');
    expect(artifactRole('src/api/HealthController.java')).toBe('scaffold');
    expect(isSourceCode('a/B.java') && isSourceCode('x.exs') && !isSourceCode('seed.sql') && !isSourceCode('pom.xml')).toBe(true);
  });

  // The roles come from the paths the generators emit: a generator that moves its kernel or its wiring
  // must update core/artifact-roles.ts (and this snapshot) in the same change.
  it.each(STACKS)('%s/%s: kernel and wiring files', (language, framework) => {
    const roles = files(language, framework).map(f => `${artifactRole(f.filename)} ${f.filename}`);
    const kernel = roles.filter(r => r.startsWith('kernel '));
    expect(kernel.length, 'the stack has a kernel').toBeGreaterThan(0);
    expect(roles.filter(r => r.startsWith('kernel ') || r.startsWith('wiring ')).sort()).toMatchSnapshot();
  });
});
