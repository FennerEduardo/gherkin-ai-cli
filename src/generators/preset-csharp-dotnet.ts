/* ==========================================================================
   gherkin-ai-cli - C# .NET & SpecFlow Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

import { generateOutboxInfrastructure } from './dotnet/outbox-generator';
import { generateSagaInfrastructure } from './dotnet/saga-generator';
import { generateIdempotencyInfrastructure } from './dotnet/idempotency-generator';
import { generateOpenTelemetryConfig } from './dotnet/opentelemetry-generator';
import { generateSignalRInfrastructure } from './dotnet/signalr-generator';
import { generateDotNetAspireAppHost, generateDotNetAspireServiceDefaults } from './dotnet/aspire-generator';
import { generateDotNetTestcontainersIntegrationTest } from './dotnet/dotnet-testcontainers-generator';

export function generateCsharpDotnetPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const className = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '') + 'StepDefinitions';
  const namespace = 'MyEnterpriseApp';

  const stepDefCode = `// SpecFlow Step Definitions for ${parsed.featureName}
using System;
using TechTalk.SpecFlow;

namespace Tests.Steps
{
    [Binding]
    public class ${className}
    {
${parsed.scenarios.map(sc => `
        // Scenario: ${sc.name}
${sc.steps.map(st => `
        [${st.keyword.trim()}("${st.text.replace(/"/g, '""')}")]
        public void ${st.keyword.trim()}${st.text.replace(/[^a-zA-Z0-9]/g, '')}()
        {
            // TODO: Implement step
        }
`).join('')}
`).join('')}
    }
}
`;

  return [
    {
      filename: `${className}.cs`,
      content: stepDefCode
    },
    {
      filename: `Infrastructure/Outbox/OutboxInfrastructure.cs`,
      content: generateOutboxInfrastructure(namespace)
    },
    {
      filename: `Application/Sagas/PaymentSagaStateMachine.cs`,
      content: generateSagaInfrastructure(namespace)
    },
    {
      filename: `Application/Behaviors/IdempotencyInfrastructure.cs`,
      content: generateIdempotencyInfrastructure(namespace)
    },
    {
      filename: `Infrastructure/Telemetry/OpenTelemetryExtensions.cs`,
      content: generateOpenTelemetryConfig(namespace)
    },
    {
      filename: `Infrastructure/Realtime/SignalRNotificationService.cs`,
      content: generateSignalRInfrastructure(namespace)
    },
    {
      filename: `AppHost/Program.cs`,
      content: generateDotNetAspireAppHost(namespace)
    },
    {
      filename: `ServiceDefaults/Extensions.cs`,
      content: generateDotNetAspireServiceDefaults(namespace)
    },
    {
      filename: `IntegrationTests/DistributedSystemIntegrationTest.cs`,
      content: generateDotNetTestcontainersIntegrationTest(namespace)
    }
  ];
}

