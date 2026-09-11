import { describe, it, expect } from 'vitest';
import { generatePresets } from '../src/generators/presets';
import { GherkinAIConfig } from '../src/core/config';

describe('Enterprise Gap Closure & Clean Architecture Suite (.NET + Angular Signals)', () => {
  const mockParsed = {
    featureName: 'OrderManagement',
    scenarios: [
      {
        name: 'Process Order Allocation',
        steps: [
          { keyword: 'Given ', text: 'an order request from customer' },
          { keyword: 'When ', text: 'the order is submitted' },
          { keyword: 'Then ', text: 'the order status is set to ALLOCATED' }
        ]
      }
    ]
  };

  const config: GherkinAIConfig = {
    projectName: 'CustomCompany.BankingApp',
    architecture: 'hexagonal',
    stack: {
      language: 'csharp',
      framework: 'dotnet-aspnetcore',
      orm: 'efcore',
      database: 'postgresql',
      validation: 'fluentvalidation',
      auth: 'jwt',
      testing: 'xunit'
    },
    frontendStack: {
      framework: 'angular',
      language: 'typescript',
      stateManagement: 'signals'
    },
    outputDir: './specs'
  };

  const files = generatePresets(mockParsed, config);

  it('generates 4-project Clean Architecture layout for .NET', () => {
    const domainFile = files.find(f => f.filename.includes('src/Domain/OrderManagement.cs'));
    const appFile = files.find(f => f.filename.includes('src/Application/Commands/OrderManagementCommands.cs'));
    const infraFile = files.find(f => f.filename.includes('src/Infrastructure/Repositories/OrderManagementRepository.cs'));
    const apiFile = files.find(f => f.filename.includes('src/Api/Controllers/OrderManagementController.cs'));

    expect(domainFile).toBeDefined();
    expect(appFile).toBeDefined();
    expect(infraFile).toBeDefined();
    expect(apiFile).toBeDefined();
  });

  it('uses dynamic namespaces based on config.projectName', () => {
    const domainFile = files.find(f => f.filename.includes('src/Domain/OrderManagement.cs'))!;
    const appFile = files.find(f => f.filename.includes('src/Application/Commands/OrderManagementCommands.cs'))!;
    const apiFile = files.find(f => f.filename.includes('src/Api/Controllers/OrderManagementController.cs'))!;

    expect(domainFile.content).toContain('namespace CustomCompany.BankingApp.Domain.Entities');
    expect(appFile.content).toContain('namespace CustomCompany.BankingApp.Application.Commands');
    expect(apiFile.content).toContain('namespace CustomCompany.BankingApp.Api.Controllers');
  });

  it('has zero C# syntax errors ("import" keyword) across all C# generated files', () => {
    const csharpFiles = files.filter(f => f.filename.endsWith('.cs'));
    expect(csharpFiles.length).toBeGreaterThan(5);
    csharpFiles.forEach(file => {
      expect(file.content).not.toMatch(/^import\s+/m);
    });
  });

  it('eliminates generic Dictionary<string, object> and object? from domain contracts', () => {
    const domainFile = files.find(f => f.filename.includes('src/Domain/OrderManagement.cs'))!;
    expect(domainFile.content).not.toContain('Dictionary<string, object>');
    expect(domainFile.content).not.toContain('object?');
    expect(domainFile.content).toContain('public abstract class AggregateRoot<TId>');
    expect(domainFile.content).toContain('public abstract class ValueObject');
    expect(domainFile.content).toContain('public interface IRepository<TEntity, TId>');
  });

  it('generates MediatR Handlers and Read Model Projector', () => {
    const handlersFile = files.find(f => f.filename.includes('src/Application/CQRS/OrderManagementHandlers.cs'))!;
    expect(handlersFile).toBeDefined();
    expect(handlersFile.content).toContain('IRequestHandler<CreateOrderManagementCommand, CommandResult>');
    expect(handlersFile.content).toContain('IRequestHandler<GetOrderManagementQuery, OrderManagementReadModel?>');
    expect(handlersFile.content).toContain('INotificationHandler<OrderManagementProcessedEventNotification>');
  });

  it('generates Inbox Deduplication Service', () => {
    const inboxFile = files.find(f => f.filename.includes('src/Infrastructure/Inbox/InboxInfrastructure.cs'))!;
    expect(inboxFile).toBeDefined();
    expect(inboxFile.content).toContain('public class InboxMessage');
    expect(inboxFile.content).toContain('HasBeenConsumedAsync(Guid messageId)');
  });

  it('generates Polly v8 resilience pipelines with Jitter and Circuit Breaker', () => {
    const resilienceFile = files.find(f => f.filename.includes('src/Infrastructure/Resilience/ResilienceExtensions.cs'))!;
    expect(resilienceFile).toBeDefined();
    expect(resilienceFile.content).toContain('AddRetry');
    expect(resilienceFile.content).toContain('AddCircuitBreaker');
    expect(resilienceFile.content).toContain('AddTimeout');
    expect(resilienceFile.content).toContain('UseJitter = true');
  });

  it('generates strongly-typed Angular Signals Store with domain status enums', () => {
    const storeFile = files.find(f => f.filename.includes('frontend/store/ordermanagement.store.ts'))!;
    expect(storeFile).toBeDefined();
    expect(storeFile.content).toContain("export enum TransactionStatus");
    expect(storeFile.content).toContain("COMPLETED = 'COMPLETED'");
    expect(storeFile.content).toContain("signalStore");
    expect(storeFile.content).toContain("computed(() =>");
  });

  it('generates Angular SignalR Notification Service', () => {
    const signalrFile = files.find(f => f.filename.includes('frontend/services/signalr-notification.service.ts'))!;
    expect(signalrFile).toBeDefined();
    expect(signalrFile.content).toContain('@Injectable');
    expect(signalrFile.content).toContain('HubConnectionBuilder');
    expect(signalrFile.content).toContain('ReceiveDomainEvent');
  });

  it('generates Testcontainers E2E Integration test with happy path, inbox deduplication, and compensation flow', () => {
    const testcontainersFile = files.find(f => f.filename.includes('tests/IntegrationTests/DistributedSystemIntegrationTest.cs'))!;
    expect(testcontainersFile).toBeDefined();
    expect(testcontainersFile.content).toContain('PostgreSqlBuilder');
    expect(testcontainersFile.content).toContain('OutboxAndSaga_HappyPath_ExecutesSuccessfully');
    expect(testcontainersFile.content).toContain('InboxPattern_DuplicateMessage_IsDeduplicatedIdempotently');
    expect(testcontainersFile.content).toContain('Saga_CompensationFlow_TriggersOnProviderFailure');
  });
});
