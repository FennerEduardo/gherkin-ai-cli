/* ==========================================================================
   gherkin-ai-cli - Kotlin Quarkus Preset Generator  [stable] (4.6)

   Gradle (Kotlin DSL, Quarkus plugin) service: the Kotlin domain kernel and
   Cucumber steps of the Kotlin Spring preset, the Java runtime kernel
   (PostgreSQL + broker + OpenTelemetry, IT1-IT7) and the Java Quarkus
   application layer of the Java Quarkus preset (Kotlin/Java interop in one
   module). Verified by scripts/golden-build.js (kotlin-quarkus).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { renderQuarkusAppLayer } from './kernel/app/jvm-quarkus';
import { tenantClaim } from './kernel/app/shared';
import { siblingDomainModels } from './kernel/siblings';
import { buildDomainModel } from './kernel/domain-model';
import { javaPackagePath } from './kernel/java';
import { renderKotlinKernel, renderKotlinKernelTests } from './kernel/kotlin';
import { renderJvmRuntime } from './kernel/runtime/jvm';
import { jvmBasePackage } from './preset-java-spring';

export function generateKotlinQuarkusPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const pkg = jvmBasePackage(config);
  const siblings = siblingDomainModels(m, config, s => `src/main/kotlin/${javaPackagePath(pkg)}/domain/${s.pascal}Aggregate.kt`);
  return [
    // No main class: Quarkus generates the entry point at build time.
    ...renderKotlinKernel(m, pkg),
    ...renderKotlinKernelTests(m, pkg),
    ...renderJvmRuntime(m, pkg, { kotlin: true, siblings, messaging: config?.stack?.messaging }),
    ...renderQuarkusAppLayer(m, pkg, tenantClaim(config))
  ];
}
