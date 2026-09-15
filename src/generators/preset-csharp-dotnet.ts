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

  const generatedMethods = new Set<string>();

  const stepDefCode = `// Reqnroll Step Definitions for ${parsed.featureName}
using System;
using Reqnroll;

namespace ${namespace}.Tests.Steps
{
    [Binding]
    public class ${className}
    {
${parsed.scenarios.map(sc => `
        // Scenario: ${sc.name}
${(sc.steps || []).map(st => {
    const methodName = `${st.keyword.trim()}${st.text.replace(/[^a-zA-Z0-9]/g, '')}`;
    if (generatedMethods.has(methodName)) return '';
    generatedMethods.add(methodName);
    return `        [${st.keyword.trim()}("${st.text.replace(/"/g, '""')}")]
        public void ${methodName}()
        {
            throw new PendingStepException();
        }`;
}).join('\n')}
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
        return Ok(result);
    }
}
`;

  const dbContextCode = `using Microsoft.EntityFrameworkCore;
using ${namespace}.Domain.Entities;
using ${namespace}.Infrastructure.Outbox;

namespace ${namespace}.Infrastructure.Data
{
    public class ApplicationDbContext : DbContext
    {
        public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options) : base(options) { }

        public DbSet<${featurePascal}Aggregate> ${featurePascal}s { get; set; } = null!;
        public DbSet<OutboxMessage> OutboxMessages { get; set; } = null!;

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            base.OnModelCreating(modelBuilder);
            
            modelBuilder.Entity<${featurePascal}Aggregate>(entity =>
            {
                entity.HasKey(e => e.Id);
                // Additional configurations can be added here
            });
            
            modelBuilder.Entity<OutboxMessage>(entity =>
            {
                entity.HasKey(e => e.Id);
            });
        }
    }
}
`;

  const programCode = `using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.EntityFrameworkCore;
using MassTransit;
using ${namespace}.Infrastructure.Data;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// Configure DbContext
builder.Services.AddDbContext<ApplicationDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection") ?? "Host=localhost;Database=mydb;Username=postgres;Password=postgres"));

// Configure MediatR
builder.Services.AddMediatR(cfg => cfg.RegisterServicesFromAssembly(typeof(Program).Assembly));

// Configure MassTransit
builder.Services.AddMassTransit(x =>
{
${config?.stack?.messaging === 'sqs' ? `    x.UsingAmazonSqs((context, cfg) =>
    {
        cfg.Host("us-east-1", h => {
            h.AccessKey("test");
            h.SecretKey("test");
        });
        cfg.ConfigureEndpoints(context);
    });` : `    x.UsingRabbitMq((context, cfg) =>
    {
        cfg.Host(builder.Configuration["RabbitMQ:Host"] ?? "localhost", "/", h => {
            h.Username(builder.Configuration["RabbitMQ:Username"] ?? "guest");
            h.Password(builder.Configuration["RabbitMQ:Password"] ?? "guest");
        });
        cfg.ConfigureEndpoints(context);
    });`}
});

var app = builder.Build();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseAuthorization();
app.MapControllers();

app.Run();

public partial class Program { } // For integration testing
`;

  return [
    {
      filename: `src/Domain/${featurePascal}.cs`,
      content: domainEntityCode
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
      filename: `src/Infrastructure/Data/ApplicationDbContext.cs`,
      content: dbContextCode
    },
    {
      filename: `src/Api/Program.cs`,
      content: programCode
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
      content: generateDotNetTestcontainersIntegrationTest(namespace, featurePascal)
    }
  ];
}
