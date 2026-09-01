import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const springBootTemplate: PromptTemplate = {
  name: 'Java Spring Boot',
  match: (config) => config.stack.framework === 'spring-boot',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (Java)', `Implement domain entities and ports in Java 17+.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Strict Architectural Patterns:\n${ctx.arch.patterns.map(p => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: Java\n- Do not use Spring @Entity, @Table, or @Component annotations in the pure domain core.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Pure Java POJOs for Entities/Aggregates\n2. Interfaces for Domain Events\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('BACKEND DEVELOPER AGENT (Spring Boot)', 'Implement @RestController, @Service, @Repository and JPA Entities.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: Spring Boot\n- ORM: Hibernate/JPA\n- Validation: Jakarta Validation API\n- Auth: Spring Security\n` +
      `\n📌 Implementation Rules:\n- Keep controllers lightweight, delegate to @Service.\n- Use MapStruct or manual mapping between DTOs and Entities.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (JUnit/MockMvc)', `Implement automated tests using JUnit 5 and MockMvc.`, ctx) +
      `\n📌 Fixture Reference:\n- Use @DataJpaTest for repository tests.\n- Use @WebMvcTest for controllers.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests with Mockito.\n2. Integration tests using Testcontainers if DB is required.\n`;
  }
};
