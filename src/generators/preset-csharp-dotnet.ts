/* ==========================================================================
   gherkin-ai-cli - C# .NET & Clean Architecture Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { generateOutboxInfrastructure } from './dotnet/outbox-generator';
import { generateSagaInfrastructure } from './dotnet/saga-generator';
import { generateIdempotencyInfrastructure } from './dotnet/idempotency-generator';
import { generateOpenTelemetryConfig } from './dotnet/opentelemetry-generator';
import { generateSignalRInfrastructure } from './dotnet/signalr-generator';
import { generateDotNetAspireAppHost, generateDotNetAspireServiceDefaults } from './dotnet/aspire-generator';
import { generateDotNetTestcontainersIntegrationTest } from './dotnet/dotnet-testcontainers-generator';
import { generateCqrsHandlers } from './dotnet/cqrs-handlers-generator';
import { generateInboxInfrastructure } from './dotnet/inbox-generator';
import { generateResiliencePipelines } from './dotnet/resilience-generator';

export function generateCsharpDotnetPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const featurePascal = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '');
  const className = featurePascal + 'StepDefinitions';
  const namespace = config?.projectName ? config.projectName.replace(/[^a-zA-Z0-9.]/g, '') : 'MyEnterpriseApp';

  const stepDefCode = `// SpecFlow Step Definitions for ${parsed.featureName}
using System;
using TechTalk.SpecFlow;

namespace ${namespace}.Tests.Steps
{
    [Binding]
    public class ${className}
    {
${parsed.scenarios.map(sc => `
        // Scenario: ${sc.name}
${(sc.steps || []).map(st => `
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

  const domainEntityCode = `namespace ${namespace}.Domain.Entities;

using System;
using System.Collections.Generic;
using System.Threading.Tasks;

public abstract class AggregateRoot<TId>
{
    public TId Id { get; protected set; } = default!;
    public long Version { get; protected set; }
}

public abstract class ValueObject
{
}

public interface IRepository<TEntity, TId>
{
    Task<TEntity?> GetByIdAsync(TId id);
    Task AddAsync(TEntity entity);
}

public class ${featurePascal} : AggregateRoot<Guid>
{
    public string ReferenceCode { get; private set; } = string.Empty;

    public ${featurePascal}(string referenceCode)
    {
        Id = Guid.NewGuid();
        ReferenceCode = referenceCode;
    }
}
`;

  const appCommandsCode = `namespace ${namespace}.Application.Commands;

using System;
using MediatR;

public record Create${featurePascal}Command(string ReferenceCode, decimal Amount) : IRequest<string>;
public record Get${featurePascal}Query(Guid ${featurePascal}Id) : IRequest<object?>;
`;

  const infraRepoCode = `namespace ${namespace}.Infrastructure.Repositories;

using System;
using System.Threading.Tasks;
using ${namespace}.Domain.Entities;

public class ${featurePascal}Repository : IRepository<${featurePascal}, Guid>
{
    public async Task<${featurePascal}?> GetByIdAsync(Guid id)
    {
        await Task.CompletedTask;
        return new ${featurePascal}("REF-SAMPLE");
    }

    public async Task AddAsync(${featurePascal} entity)
    {
        await Task.CompletedTask;
    }
}
`;

  const apiControllerCode = `namespace ${namespace}.Api.Controllers;

using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using MediatR;
using ${namespace}.Application.Commands;

[ApiController]
[Route("api/v1/[controller]")]
public class ${featurePascal}Controller : ControllerBase
{
    private readonly IMediator _mediator;

    public ${featurePascal}Controller(IMediator mediator)
    {
        _mediator = mediator;
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] Create${featurePascal}Command command)
    {
        var result = await _mediator.Send(command);
        return Accepted(result);
    }
}
`;

  return [
    {
      filename: `src/Domain/${featurePascal}.cs`,
      content: domainEntityCode
    },
    {
      filename: `src/Application/Commands/${featurePascal}Commands.cs`,
      content: appCommandsCode
    },
    {
      filename: `src/Infrastructure/Repositories/${featurePascal}Repository.cs`,
      content: infraRepoCode
    },
    {
      filename: `src/Api/Controllers/${featurePascal}Controller.cs`,
      content: apiControllerCode
    },
    {
      filename: `tests/Steps/${className}.cs`,
      content: stepDefCode
    },
    {
      filename: `src/Application/CQRS/${featurePascal}Handlers.cs`,
      content: generateCqrsHandlers(namespace, parsed.featureName)
    },
    {
      filename: `src/Application/Sagas/PaymentSagaStateMachine.cs`,
      content: generateSagaInfrastructure(namespace)
    },
    {
      filename: `src/Application/Behaviors/IdempotencyInfrastructure.cs`,
      content: generateIdempotencyInfrastructure(namespace)
    },
    {
      filename: `src/Infrastructure/Outbox/OutboxInfrastructure.cs`,
      content: generateOutboxInfrastructure(namespace)
    },
    {
      filename: `src/Infrastructure/Inbox/InboxInfrastructure.cs`,
      content: generateInboxInfrastructure(namespace)
    },
    {
      filename: `src/Infrastructure/Resilience/ResilienceExtensions.cs`,
      content: generateResiliencePipelines(namespace)
    },
    {
      filename: `src/Infrastructure/Telemetry/OpenTelemetryExtensions.cs`,
      content: generateOpenTelemetryConfig(namespace)
    },
    {
      filename: `src/Infrastructure/Realtime/SignalRNotificationService.cs`,
      content: generateSignalRInfrastructure(namespace)
    },
    {
      filename: `src/Api/AppHost/Program.cs`,
      content: generateDotNetAspireAppHost(namespace)
    },
    {
      filename: `src/Api/ServiceDefaults/Extensions.cs`,
      content: generateDotNetAspireServiceDefaults(namespace)
    },
    {
      filename: `tests/IntegrationTests/DistributedSystemIntegrationTest.cs`,
      content: generateDotNetTestcontainersIntegrationTest(namespace)
    }
  ];
}
