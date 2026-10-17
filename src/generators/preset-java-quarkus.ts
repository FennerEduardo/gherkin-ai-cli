/* ==========================================================================
   gherkin-ai-cli - Java Quarkus & Cucumber-JVM Preset Generator  [beta]

   Produces a Maven Quarkus service: the same domain kernel, Cucumber
   (JUnit Platform) runner and runtime kernel (PostgreSQL + RabbitMQ +
   OpenTelemetry, IT1-IT7) as the Spring preset, with a Quarkus application
   layer (kernel/app/jvm-quarkus.ts). Verified by scripts/golden-build.js
   (quarkus).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { renderQuarkusAppLayer } from './kernel/app/jvm-quarkus';
import { tenantClaim } from './kernel/app/shared';
import { siblingDomainModels } from './kernel/siblings';
import { buildDomainModel, toPascal } from './kernel/domain-model';
import { renderJvmRuntime } from './kernel/runtime/jvm';
import { javaPackagePath, renderJavaKernel, renderJavaKernelTests } from './kernel/java';
import { jvmBasePackage } from './preset-java-spring';

export function generateJavaQuarkusPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const pkg = jvmBasePackage(config);
  const siblings = siblingDomainModels(m, config, s => `src/main/java/${javaPackagePath(pkg)}/domain/${s.pascal}Aggregate.java`);
  const srcRoot = `src/main/java/${javaPackagePath(pkg)}`;

  const results = [
    // No main class: Quarkus generates the entry point at build time.
    ...renderJavaKernel(m, pkg),
    ...renderJavaKernelTests(m, pkg),
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified with -Pintegration (docs/RUNTIME-KERNEL.md).
    ...renderJvmRuntime(m, pkg, { siblings, messaging: config?.stack?.messaging }),
    // Application layer wired to the kernel: Quarkus REST, JWT tenant, Agroal from DATABASE_URL, relay, health.
    ...renderQuarkusAppLayer(m, pkg, tenantClaim(config))
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
