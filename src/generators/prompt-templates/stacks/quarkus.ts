import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const quarkusTemplate: PromptTemplate = {
  name: 'Java Quarkus',
  match: (config) => String(config.stack.framework || '').toLowerCase() === 'quarkus',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (Java 21)', 'Implement domain entities and ports in plain Java 21 (records, sealed types).', ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Strict Architectural Patterns:\n${ctx.arch.patterns.map(p => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: Java 21\n- The domain core has no Quarkus, Jakarta (CDI, JAX-RS, JPA) or Jackson annotations.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Pure Java records / classes for Entities and Aggregates\n2. Domain events and ports as interfaces\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('BACKEND DEVELOPER AGENT (Quarkus)', 'Implement Quarkus REST resources and CDI beans over the generated runtime kernel.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: Quarkus 3.40 LTS (Quarkus REST, Arc CDI, Agroal, Scheduler, SmallRye Health)\n- Persistence: plain JDBC through the runtime kernel (CommandService, outbox, inbox, sagas); no Hibernate\n- Auth: the generated JwtTenantFilter (tenant only from the token claim)\n` +
      `\n📌 Implementation Rules:\n` +
      `- Use CDI (@ApplicationScoped, @Inject, @Produces); never Spring annotations such as @Autowired or @Component.\n` +
      `- Read configuration with @ConfigProperty / @ConfigMapping from application.properties and environment variables; never hard-code secrets or URLs.\n` +
      `- JDBC is blocking: keep resources returning plain types (worker threads) or mark them @Blocking; never block the Vert.x event loop.\n` +
      `- Avoid runtime reflection and classpath scanning (build-time CDI; keep native-image compatibility).\n` +
      `- Commands go through CommandService so idempotency, the outbox and traceparent propagation stay intact.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (JUnit 5 / @QuarkusTest)', 'Implement automated tests with JUnit 5, Cucumber-JVM and @QuarkusTest.', ctx) +
      `\n📌 Fixture Reference:\n- Domain tests are plain JUnit 5 (no Quarkus boot).\n- HTTP tests use @QuarkusTest with @TestHTTPResource; tag tests that need PostgreSQL / RabbitMQ with @Tag("integration") (mvn test -Pintegration).\n- Dev Services are disabled: tests use DATABASE_URL and AMQP_URL.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests of the aggregate rules.\n2. Cucumber steps bound to the feature file.\n3. Integration tests of the HTTP contract (401 without token, 202/200 idempotent, 422 on domain errors).\n`;
  }
};
