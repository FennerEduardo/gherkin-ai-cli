/* ==========================================================================
   gherkin-ai-cli - Java Spring Boot & Cucumber-JVM Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generateJavaSpringPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const className = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '') + 'StepDefinitions';

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
    }
  ];
}
