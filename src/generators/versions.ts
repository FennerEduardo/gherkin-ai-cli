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
  openTelemetry: '1.67.0',
  /** Quarkus platform BOM (current LTS: supported for 12 months from its release). */
  quarkus: '3.40.1',
  /** Java release of Quarkus projects. */
  quarkusJava: '21',
  /** RabbitMQ Java client (explicit: Quarkus projects have no Spring BOM). */
  amqpClient: '5.21.0',
  /** Azure SDK BOM (Service Bus adapter only): azure-messaging-servicebus 7.18.1, azure-identity 1.18.7. */
  azureSdkBom: '1.3.9',
  mavenCompilerPlugin: '3.13.0',
  mavenSurefirePlugin: '3.5.2'
} as const;
