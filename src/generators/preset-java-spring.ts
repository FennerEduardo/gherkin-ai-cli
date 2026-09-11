/* ==========================================================================
   gherkin-ai-cli - Java Spring Boot & Cucumber-JVM Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

import { generateJavaOutboxInfrastructure } from './java/java-outbox-generator';
import { generateJavaSagaInfrastructure } from './java/java-saga-generator';
import { generateJavaIdempotencyInfrastructure } from './java/java-idempotency-generator';
import { generateJavaOpenTelemetryInfrastructure } from './java/java-opentelemetry-generator';
import { generateJavaCQRSInfrastructure } from './java/java-cqrs-generator';

export function generateJavaSpringPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const className = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '') + 'StepDefinitions';
  const packageName = 'com.example.app';

  const stepDefCode = `// Cucumber-JVM Step Definition Generator for Spring Boot & GraphQL
package com.example.bdd.steps;

import io.cucumber.java.en.Given;
import io.cucumber.java.en.When;
import io.cucumber.java.en.Then;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import static org.assertj.core.api.Assertions.assertThat;

public class ${className} {

    @Autowired
    private TestRestTemplate restTemplate;

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:15-alpine");

    ${parsed.scenarios.map(sc => `
    // Scenario: ${sc.name}
    ${sc.steps.map(st => `
    @${st.keyword.trim()}("${st.text.replace(/"/g, '\\"')}")
    public void step_${st.text.replace(/[^a-zA-Z0-9]/g, '_')}() {
        // TODO: Implement Step Binding for GraphQL / REST Service
    }`).join('\n')}
    `).join('\n')}
}
`;

  return [
    {
      filename: `${className}.java`,
      content: stepDefCode
    },
    {
      filename: `infrastructure/outbox/OutboxInfrastructure.java`,
      content: generateJavaOutboxInfrastructure(packageName)
    },
    {
      filename: `application/sagas/PaymentSagaOrchestrator.java`,
      content: generateJavaSagaInfrastructure(packageName)
    },
    {
      filename: `infrastructure/idempotency/IdempotencyInfrastructure.java`,
      content: generateJavaIdempotencyInfrastructure(packageName)
    },
    {
      filename: `infrastructure/telemetry/OpenTelemetryConfig.java`,
      content: generateJavaOpenTelemetryInfrastructure(packageName)
    },
    {
      filename: `application/cqrs/PaymentCQRS.java`,
      content: generateJavaCQRSInfrastructure(packageName)
    }
  ];
}

