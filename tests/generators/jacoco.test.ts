import { describe, it, expect } from 'vitest';
import { renderPom, renderQuarkusPom } from '../../src/generators/kernel/java';
import { renderGradleKts, renderQuarkusGradleKts } from '../../src/generators/kernel/kotlin';

// LMS evidence report E-08: generated JVM builds had no JaCoCo, so converge's Code Coverage was 0 or n/a.
describe('JaCoCo in generated JVM builds (E-08)', () => {
  it.each([['spring', renderPom('orders')], ['quarkus', renderQuarkusPom('orders')]])('%s pom.xml: agent and report after the tests', (_name, pom) => {
    expect(pom).toMatch(/<artifactId>jacoco-maven-plugin<\/artifactId>\s*<version>\d+\.\d+\.\d+<\/version>/);
    expect(pom).toContain('<goal>prepare-agent</goal>');
    expect(pom).toMatch(/<phase>test<\/phase>\s*<goals>\s*<goal>report<\/goal>/);
  });

  it.each([['spring', renderGradleKts()], ['quarkus', renderQuarkusGradleKts()]])('%s build.gradle.kts: jacoco plugin with XML and CSV reports', (_name, gradle) => {
    expect(gradle).toMatch(/plugins \{[^}]*\n\s+jacoco\n\}/);
    expect(gradle).toContain('finalizedBy(tasks.jacocoTestReport)');
    expect(gradle).toMatch(/xml\.required = true\s*\n\s*csv\.required = true/);
  });
});
