import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { getStackSupport } from '../../src/generators/stack-support';
import { renderQuarkusGradleKts } from '../../src/generators/kernel/kotlin';
import { resolveHealth, resolveToolchain } from '../../src/generators/toolchains';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const config = { ...defaultConfig, projectName: 'orders', stack: { ...defaultConfig.stack, language: 'kotlin', framework: 'quarkus' } };

describe('Kotlin + Quarkus backend (4.6)', () => {
  it('resolves to its own stable stack with the Quarkus toolchain and probes', () => {
    expect(getStackSupport(config)).toMatchObject({ id: 'kotlin/quarkus', tier: 'stable', golden: 'kotlin-quarkus' });
    expect(resolveToolchain(config)?.image).toBe('gradle:8.14-jdk21');
    expect(resolveHealth(config)).toEqual({ live: '/q/health/live', ready: '/q/health/ready' });
  });

  it('generates the Kotlin domain, the Java runtime kernel and the Quarkus application layer, without Spring', () => {
    const files = generatePresets(parsed, config);
    const names = files.map(f => f.filename);
    expect(names.some(n => /src\/main\/kotlin\/.*\/domain\/OrderCheckoutAggregate\.kt$/.test(n))).toBe(true);
    expect(names.some(n => /src\/main\/java\/.*\/api\/OrderCheckoutResource\.java$/.test(n))).toBe(true);
    expect(names.some(n => /src\/main\/java\/.*\/runtime\/ConnectionFactory\.java$/.test(n))).toBe(true);
    expect(names.some(n => n.endsWith('/Application.kt'))).toBe(false);
    expect(names).toContain('Dockerfile');
    expect(files.find(f => f.filename === 'Dockerfile')!.content).toContain('/app/build/quarkus-app/');
    for (const f of files) expect(f.content, f.filename).not.toContain('org.springframework');
  });

  it('builds with the Quarkus Gradle plugin and keeps the runtime OpenTelemetry pin', () => {
    const gradle = renderQuarkusGradleKts('com.example');
    expect(gradle).toContain('id("io.quarkus") version');
    expect(gradle).toContain('implementation(platform("io.quarkus.platform:quarkus-bom:');
    expect(gradle).toContain('io.quarkus:quarkus-kotlin');
    expect(gradle).toContain('val integrationTest by tasks.registering(Test::class)');
    expect(gradle).not.toContain('springframework');
  });
});
