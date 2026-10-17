/* ==========================================================================
   gherkin-ai-cli - Kotlin Spring Boot Preset Generator  [stable]

   Gradle (Kotlin DSL) project: Kotlin domain kernel + kotlin-test, Cucumber
   steps in Kotlin bound to ./features, Spring Boot app. The enterprise
   pattern infrastructure (outbox, saga, idempotency, CQRS, multitenancy,
   OpenTelemetry) is shared with the Java preset and compiled from
   src/main/java (Kotlin/Java interop). Verified by golden-build (kotlin).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { generateJavaSpringPreset, jvmBasePackage } from './preset-java-spring';
import { siblingDomainModels } from './kernel/siblings';
import { javaPackagePath } from './kernel/java';
import { buildDomainModel } from './kernel/domain-model';
import { renderJvmRuntime } from './kernel/runtime/jvm';
import { renderKotlinApplication, renderKotlinKernel, renderKotlinKernelTests } from './kernel/kotlin';

export function generateKotlinSpringPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const pkg = jvmBasePackage(config);
  const siblings = siblingDomainModels(m, config, s => `src/main/kotlin/${javaPackagePath(pkg)}/domain/${s.pascal}Aggregate.kt`);

  // Reuse the Java infrastructure and the application layer (REST, JWT tenant, DataSource, relay worker):
  // Java compiles against the Kotlin domain in the same Gradle module.
  const sharedInfra = generateJavaSpringPreset(parsed, config).filter(f =>
    (f.filename.startsWith('src/main/java/') && (/\/(infrastructure|application|auth|api)\//.test(f.filename) || f.filename.endsWith('/runtime/RuntimeConfiguration.java'))) ||
    /^src\/test\/java\/.*\/api\/\w+HttpIntegrationTest\.java$/.test(f.filename) ||
    f.filename === 'src/main/resources/application.properties'
  );

  return [
    renderKotlinApplication(pkg),
    ...renderKotlinKernel(m, pkg),
    ...renderKotlinKernelTests(m, pkg),
    // Runtime kernel (Java, shared with the Java preset): verified with gradle integrationTest (docs/RUNTIME-KERNEL.md).
    ...renderJvmRuntime(m, pkg, { kotlin: true, siblings, messaging: config?.stack?.messaging }),
    ...sharedInfra
  ];
}
