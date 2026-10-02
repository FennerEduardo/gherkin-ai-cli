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
import { buildDomainModel } from './kernel/domain-model';
import { REQNROLL_JSON, renderCsAggregate, renderCsAggregateTests, renderCsTestProject, renderReqnrollSteps } from './kernel/csharp';

export function generateCsharpDotnetPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const featurePascal = buildDomainModel(parsed).pascal;
  const namespace = config?.projectName ? config.projectName.replace(/[^a-zA-Z0-9.]/g, '') : 'MyEnterpriseApp';
  const m = buildDomainModel(parsed);
  const testsDir = `tests/${namespace}.Tests`;

  const domainEntityCode = `namespace ${namespace}.Domain.Entities;

using System;
using System.Collections.Generic;
using System.Threading.Tasks;

public abstract class AggregateRoot<TId>
{
    public TId Id { get; protected set; } = default!;
    public long Version { get; protected set; }
    public string TenantId { get; protected set; } = string.Empty;
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

    public ${featurePascal}(string referenceCode, string tenantId = "default")
    {
        Id = Guid.NewGuid();
        ReferenceCode = referenceCode;
        TenantId = tenantId;
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
using ${namespace}.Domain.${featurePascal}; // commands, queries and read models live with the contract

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
    public interface ITenantService
    {
        string GetCurrentTenantId();
    }

    public class ApplicationDbContext : DbContext
    {
        private readonly ITenantService _tenantService;

        public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options, ITenantService tenantService) : base(options) 
        {
            _tenantService = tenantService;
        }

        public DbSet<${featurePascal}> ${featurePascal}s { get; set; } = null!;
        public DbSet<OutboxMessage> OutboxMessages { get; set; } = null!;

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            base.OnModelCreating(modelBuilder);
            
            modelBuilder.Entity<${featurePascal}>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.HasIndex(e => e.ReferenceCode).IsUnique();
                entity.HasQueryFilter(e => EF.Property<string>(e, "TenantId") == _tenantService.GetCurrentTenantId());
            });
            
            modelBuilder.Entity<OutboxMessage>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.HasIndex(e => e.ProcessedOn).HasFilter("[ProcessedOn] IS NULL");
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

// Configure Tenant Service
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ITenantService, HttpHeaderTenantService>();

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

namespace ${namespace}.Infrastructure.Data
{
    using Microsoft.AspNetCore.Http;
    
    public class HttpHeaderTenantService : ITenantService
    {
        private readonly IHttpContextAccessor _httpContextAccessor;

        public HttpHeaderTenantService(IHttpContextAccessor httpContextAccessor)
        {
            _httpContextAccessor = httpContextAccessor;
        }

        public string GetCurrentTenantId()
        {
            var context = _httpContextAccessor.HttpContext;
            if (context != null && context.Request.Headers.TryGetValue("X-Tenant-Id", out var tenantId))
            {
                return tenantId.ToString();
            }
            return "default"; // Fallback
        }
    }
}
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
    { filename: `src/Domain/Kernel/${m.pascal}Aggregate.cs`, content: renderCsAggregate(m, namespace) },
    { filename: `${testsDir}/${namespace}.Tests.csproj`, content: renderCsTestProject(namespace, `${config?.projectName || 'MyProject'}.csproj`) },
    { filename: `${testsDir}/reqnroll.json`, content: REQNROLL_JSON },
    { filename: `${testsDir}/Domain/${m.pascal}AggregateTests.cs`, content: renderCsAggregateTests(m, namespace) },
    { filename: `${testsDir}/Steps/${m.pascal}StepDefinitions.cs`, content: renderReqnrollSteps(m, namespace) },
    {
      filename: `src/Application/CQRS/${featurePascal}Handlers.cs`,
      content: generateCqrsHandlers(namespace, m.pascal)
    },
    {
      filename: `src/Application/Sagas/${featurePascal}SagaStateMachine.cs`,
      content: generateSagaInfrastructure(namespace, m.pascal)
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
      filename: `${testsDir}/Integration/DistributedSystemIntegrationTest.cs`,
      content: generateDotNetTestcontainersIntegrationTest(namespace, featurePascal)
    }
  ];
}
