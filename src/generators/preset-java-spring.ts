/* ==========================================================================
   gherkin-ai-cli - Java Spring Boot & Cucumber-JVM Preset Generator  [stable]

   Produces a standard Maven project: domain kernel + JUnit 5 tests, Cucumber
   (JUnit Platform) bound to ./features with pending steps, Spring Boot app
   and enterprise patterns (outbox, saga, idempotency, CQRS, multitenancy,
   OpenTelemetry). Verified by scripts/golden-build.js (java).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { generateJavaOutboxInfrastructure } from './java/java-outbox-generator';
import { generateJavaSagaInfrastructure } from './java/java-saga-generator';
import { generateJavaIdempotencyInfrastructure } from './java/java-idempotency-generator';
import { generateJavaOpenTelemetryInfrastructure } from './java/java-opentelemetry-generator';
import { generateJavaCQRSInfrastructure } from './java/java-cqrs-generator';
import { generateJavaMultiTenancyInfrastructure } from './java/java-multitenancy-generator';
import { buildDomainModel, toFlat, toPascal } from './kernel/domain-model';
import { javaPackagePath, renderJavaKernel, renderJavaKernelTests, renderSpringApplication } from './kernel/java';

/** Base package for generated JVM projects: com.example.<projectname>. */
export function jvmBasePackage(config?: GherkinAIConfig): string {
  const flat = toFlat(config?.projectName || 'app');
  return `com.example.${/^[a-z]/.test(flat) ? flat : `app${flat}`}`;
}

export function generateJavaSpringPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  const pkg = jvmBasePackage(config);
  const srcRoot = `src/main/java/${javaPackagePath(pkg)}`;

  // Pattern generators emit paths relative to the base package (e.g. infrastructure/outbox/X.java).
  const underBasePackage = (files: { filename: string; content: string }[]) =>
    files.map(f => ({ filename: `${srcRoot}/${f.filename}`, content: f.content }));

  const results = [
    renderSpringApplication(pkg),
    ...renderJavaKernel(m, pkg),
    ...renderJavaKernelTests(m, pkg),
    ...underBasePackage([
      ...generateJavaOutboxInfrastructure(pkg),
      ...generateJavaSagaInfrastructure(pkg, m.pascal),
      ...generateJavaIdempotencyInfrastructure(pkg),
      { filename: 'infrastructure/telemetry/OpenTelemetryConfig.java', content: generateJavaOpenTelemetryInfrastructure(pkg) },
      ...generateJavaCQRSInfrastructure(pkg, m.pascal),
      ...generateJavaMultiTenancyInfrastructure(pkg)
    ])
  ];

  // Field DTOs inferred from the specification
  for (const field of parsed.domainAnalysis?.fields ?? []) {
    const type = field.type === 'number' ? 'Double' : field.type === 'boolean' ? 'Boolean' : 'String';
    const recordName = `${toPascal(field.name)}DTO`;
    if (!/^[A-Za-z]/.test(recordName)) continue;
    results.push({
      filename: `${srcRoot}/application/dto/${recordName}.java`,
      content: `package ${pkg}.application.dto;\n\npublic record ${recordName}(${type} value) {}\n`
    });
  }

  return results;
}
