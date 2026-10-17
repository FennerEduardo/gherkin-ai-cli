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

describe('Java + Quarkus preset', () => {
  const quarkus = cfg('java', 'quarkus');
  const files = generatePresets(parsed, quarkus);
  const file = (suffix: string) => files.find(f => f.filename.endsWith(suffix));

  it('resolves to the java/quarkus stack with its own toolchain', () => {
    expect(getStackSupport(quarkus)).toMatchObject({ id: 'java/quarkus', golden: 'quarkus' });
  });

  it('generates a Quarkus application layer over the shared runtime kernel, without Spring', () => {
    expect(files.some(f => f.content.includes('org.springframework'))).toBe(false);
    expect(file('api/OrderCheckoutResource.java')?.content).toContain('@Path("/api/v1/order-checkout")');
    expect(file('auth/JwtTenantFilter.java')?.content).toContain('implements ContainerRequestFilter');
    expect(file('runtime/RuntimeIntegrationTest.java')?.content).toContain('@Tag("integration")');
    expect(file('runtime/OutboxRelayWorker.java')?.content).toContain('@Scheduled(every = "PT1S"');
    expect(file('META-INF/services/org.eclipse.microprofile.config.spi.ConfigSource')?.content.trim()).toMatch(/\.runtime\.DatabaseUrlConfigSource$/);
    const props = file('src/main/resources/application.properties')!.content;
    expect(props).toContain('quarkus.devservices.enabled=false');
    expect(props).toContain('ghk.jwt-secret=${JWT_SECRET:}');
    expect(file('HttpIntegrationTest.java')?.content).toContain('@QuarkusTest');
  });

  it('builds with the Quarkus BOM after the OpenTelemetry BOM and keeps the integration profile', () => {
    const pom = ([generateContracts(parsed, ir, quarkus as any).projectRootFile].flat()[0] as { filename: string; content: string });
    expect(pom.filename).toBe('pom.xml');
    expect(pom.content).toContain('<quarkus.platform.version>3.40.1</quarkus.platform.version>');
    expect(pom.content.indexOf('opentelemetry-bom')).toBeLessThan(pom.content.indexOf('quarkus-bom'));
    expect(pom.content).toContain('<id>integration</id>');
    expect(pom.content).not.toContain('spring-boot');
  });
});

describe('beta tier warning', () => {
  it('says a beta stack with a golden build is built in CI', async () => {
    const { supportWarning } = await import('../../src/generators/stack-support');
    const warning = supportWarning(getStackSupport(cfg('java', 'quarkus')))!;
    expect(warning).toMatch(/built and tested in CI \(golden "quarkus"\)/);
    expect(warning).not.toMatch(/not built in CI/);
  });
});
