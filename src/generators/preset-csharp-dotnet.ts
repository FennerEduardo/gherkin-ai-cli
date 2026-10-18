/* ==========================================================================
   gherkin-ai-cli - C# ASP.NET Core Preset Generator  [stable]

   Domain kernel + xUnit/Reqnroll tests, the runtime kernel (PostgreSQL +
   RabbitMQ + OpenTelemetry) and the application layer wired to it
   (kernel/app/csharp.ts): minimal API with a JWT tenant, CommandService,
   outbox relay worker. Verified by scripts/golden-build.js (dotnet).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { generateOpenTelemetryConfig } from './dotnet/opentelemetry-generator';
import { generateSignalRInfrastructure } from './dotnet/signalr-generator';
import { generateDotNetAspireAppHost, generateDotNetAspireServiceDefaults } from './dotnet/aspire-generator';
import { generateResiliencePipelines } from './dotnet/resilience-generator';
import { buildDomainModel } from './kernel/domain-model';
import { renderCsRuntime } from './kernel/runtime/csharp';
import { REQNROLL_JSON, renderCsDomainValidationException, renderCsAggregate, renderCsAggregateTests, renderCsTestProject, renderReqnrollSteps } from './kernel/csharp';
import { renderAspNetAppLayer } from './kernel/app/csharp';
import { siblingDomainModels } from './kernel/siblings';
import { tenantClaim } from './kernel/app/shared';

/** Root namespace: generation.package (e.g. Acme.Billing), else the project name. */
export function dotnetNamespace(config?: GherkinAIConfig): string {
  const configured = config?.generation?.package?.trim();
  if (configured && /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(configured)) return configured;
  return config?.projectName ? config.projectName.replace(/[^a-zA-Z0-9.]/g, '') || 'MyEnterpriseApp' : 'MyEnterpriseApp';
}

export function generateCsharpDotnetPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const namespace = dotnetNamespace(config);
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const siblings = siblingDomainModels(m, config, s => `src/Domain/Kernel/${s.pascal}Aggregate.cs`);
  const testsDir = `tests/${namespace}.Tests`;

  return [
    { filename: `src/Domain/Kernel/${m.pascal}Aggregate.cs`, content: renderCsAggregate(m, namespace) },
    { filename: 'src/Domain/Kernel/DomainValidationException.cs', content: renderCsDomainValidationException(namespace) },
    { filename: `${testsDir}/${namespace}.Tests.csproj`, content: renderCsTestProject(namespace, `${config?.projectName || 'MyProject'}.csproj`) },
    { filename: `${testsDir}/reqnroll.json`, content: REQNROLL_JSON },
    { filename: `${testsDir}/Domain/${m.pascal}AggregateTests.cs`, content: renderCsAggregateTests(m, namespace) },
    { filename: `${testsDir}/Steps/${m.pascal}StepDefinitions.cs`, content: renderReqnrollSteps(m, namespace) },
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified by Category=Integration tests (docs/RUNTIME-KERNEL.md).
    ...renderCsRuntime(m, namespace, testsDir, siblings, { messaging: config?.stack?.messaging }),
    // Application layer wired to the kernel (kernel/app/shared.ts): HTTP commands, JWT tenant, relay worker.
    ...renderAspNetAppLayer(m, namespace, testsDir, tenantClaim(config), siblings),
    { filename: `src/Infrastructure/Resilience/ResilienceExtensions.cs`, content: generateResiliencePipelines(namespace) },
    { filename: `src/Infrastructure/Telemetry/OpenTelemetryExtensions.cs`, content: generateOpenTelemetryConfig(namespace) },
    { filename: `src/Infrastructure/Realtime/SignalRNotificationService.cs`, content: generateSignalRInfrastructure(namespace) },
    { filename: `src/Api/AppHost/Program.cs`, content: generateDotNetAspireAppHost(namespace) },
    { filename: `src/Api/ServiceDefaults/Extensions.cs`, content: generateDotNetAspireServiceDefaults(namespace) }
  ];
}
