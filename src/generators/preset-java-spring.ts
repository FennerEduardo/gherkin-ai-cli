/* ==========================================================================
   gherkin-ai-cli - Java Spring Boot & Cucumber-JVM Preset Generator  [stable]

   Produces a standard Maven project: domain kernel + JUnit 5 tests, Cucumber
   (JUnit Platform) bound to ./features with pending steps, Spring Boot app
   and enterprise patterns (outbox, saga, idempotency, CQRS, multitenancy,
   OpenTelemetry). Verified by scripts/golden-build.js (java).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { generateJavaOpenTelemetryInfrastructure } from './java/java-opentelemetry-generator';
import { renderSpringAppLayer } from './kernel/app/jvm';
import { tenantClaim } from './kernel/app/shared';
import { siblingDomainModels } from './kernel/siblings';
import { buildDomainModel, toFlat, toPascal } from './kernel/domain-model';
import { renderJvmRuntime } from './kernel/runtime/jvm';
import { javaPackagePath, renderJavaKernel, renderJavaKernelTests, renderSpringApplication } from './kernel/java';

const JAVA_PACKAGE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/;

/** Base package for generated JVM projects: generation.package, else com.example.<projectname>. */
export function jvmBasePackage(config?: GherkinAIConfig): string {
  const configured = config?.generation?.package?.trim();
  if (configured && JAVA_PACKAGE.test(configured)) return configured;
  const flat = toFlat(config?.projectName || 'app');
  return `com.example.${/^[a-z]/.test(flat) ? flat : `app${flat}`}`;
}

/** Maven/Gradle groupId: generation.groupId, else the base package without its last segment. */
export function jvmGroupId(config?: GherkinAIConfig): string {
  const configured = config?.generation?.groupId?.trim();
  if (configured) return configured;
  const pkg = jvmBasePackage(config);
  return pkg.includes('.') ? pkg.slice(0, pkg.lastIndexOf('.')) : pkg;
}

export function generateJavaSpringPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const pkg = jvmBasePackage(config);
  const siblings = siblingDomainModels(m, config, s => `src/main/java/${javaPackagePath(pkg)}/domain/${s.pascal}Aggregate.java`);
  const srcRoot = `src/main/java/${javaPackagePath(pkg)}`;

  // Pattern generators emit paths relative to the base package (e.g. infrastructure/telemetry/X.java).
  const underBasePackage = (files: { filename: string; content: string }[]) =>
    files.map(f => ({ filename: `${srcRoot}/${f.filename}`, content: f.content }));

  const results = [
    renderSpringApplication(pkg),
    ...renderJavaKernel(m, pkg),
    ...renderJavaKernelTests(m, pkg),
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified with -Pintegration (docs/RUNTIME-KERNEL.md).
    ...renderJvmRuntime(m, pkg, { siblings, messaging: config?.stack?.messaging }),
    // Application layer wired to the kernel (kernel/app/shared.ts): REST, JWT tenant, DataSource, relay worker.
    ...renderSpringAppLayer(m, pkg, tenantClaim(config)),
    ...underBasePackage([
      { filename: 'infrastructure/telemetry/OpenTelemetryConfig.java', content: generateJavaOpenTelemetryInfrastructure(pkg, m.service || m.kebab) }
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
