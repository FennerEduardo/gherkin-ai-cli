import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets, BACKEND_PRESET_IDS } from '../../src/generators/presets';
import { STACK_SUPPORT, getStackSupport, isSpringFramework } from '../../src/generators/stack-support';
import { generateContracts } from '../../src/generators/contracts';
import { buildIR } from '../../src/core/ir-builder';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const ir = buildIR(parsed, 'f.feature');
const cfg = (language: string, framework: string) => ({ ...defaultConfig, stack: { ...defaultConfig.stack, language, framework } });

describe('JVM framework routing', () => {
  it.each(['', 'default', 'spring', 'spring-boot', 'Spring Boot'])('"%s" selects Spring Boot', framework => {
    expect(isSpringFramework(framework)).toBe(true);
    expect(getStackSupport(cfg('java', framework)).id).toBe('java/spring');
    expect(getStackSupport(cfg('kotlin', framework)).id).toBe('kotlin/spring');
  });

  it.each([
    ['java', 'quarkus'],
    ['java', 'micronaut'],
    ['kotlin', 'ktor']
  ])('%s + %s is experimental and never falls back to Spring code', (language, framework) => {
    const support = getStackSupport(cfg(language, framework));
    expect(support).toMatchObject({ id: `${language}/${framework}`, tier: 'experimental' });

    const files = generatePresets(parsed, cfg(language, framework));
    expect(files.some(f => /spring|Application\.(java|kt)$/i.test(f.filename) || f.content.includes('org.springframework'))).toBe(false);

    const contracts = generateContracts(parsed, ir, cfg(language, framework) as any);
    const roots = [contracts.projectRootFile].flat().filter(Boolean) as { content: string }[];
    expect(roots.some(r => r.content.includes('spring-boot'))).toBe(false);
  });

  it('Spring keeps its generated application and build file', () => {
    const files = generatePresets(parsed, cfg('java', 'spring-boot'));
    expect(files.some(f => f.content.includes('org.springframework'))).toBe(true);
    const contracts = generateContracts(parsed, ir, cfg('java', 'spring-boot') as any);
    expect([contracts.projectRootFile].flat().some((r: any) => r?.filename === 'pom.xml')).toBe(true);
  });
});

describe('backend preset registry', () => {
  it('every generated backend in the support matrix has a preset', () => {
    const backends = STACK_SUPPORT.filter(s => s.kind === 'backend' && !s.id.startsWith('typescript/'));
    for (const s of backends) expect(BACKEND_PRESET_IDS, s.id).toContain(s.id);
  });
});
