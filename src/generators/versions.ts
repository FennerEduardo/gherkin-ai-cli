/* ==========================================================================
   gherkin-ai-cli - Pinned versions of the JVM toolchain in generated projects.

   One place to bump them: the renderers in kernel/java.ts and kernel/kotlin.ts
   read these constants. Every bump must pass the golden builds
   (node scripts/golden-build.js java kotlin) before release.
   ========================================================================== */

export const JVM_VERSIONS = {
  /** Spring Boot starter parent / Gradle plugin. */
  springBoot: '3.3.5',
  /** io.spring.dependency-management Gradle plugin. */
  springDependencyManagement: '1.1.6',
  /** Java release compiled against. */
  java: '17',
  kotlin: '1.9.25',
  cucumber: '7.20.1',
  openTelemetry: '1.67.0'
} as const;
