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

  it('wires the .NET API to the runtime kernel (domain kernel, runtime, endpoints, worker)', () => {
    for (const suffix of ['src/Domain/Kernel/OrderManagementAggregate.cs', 'src/Runtime/CommandService.cs', 'src/Api/OrderManagementEndpoints.cs', 'src/Api/Workers/OutboxRelayWorker.cs', 'src/Api/Auth/JwtTenant.cs', 'src/Api/Program.cs']) {
      expect(files.some(f => f.filename.endsWith(suffix)), suffix).toBe(true);
    }
  });

  it('uses dynamic namespaces based on config.projectName', () => {
    expect(files.find(f => f.filename.endsWith('src/Domain/Kernel/OrderManagementAggregate.cs'))!.content).toContain('namespace CustomCompany.BankingApp.Domain.Kernel');
    expect(files.find(f => f.filename.endsWith('src/Api/OrderManagementEndpoints.cs'))!.content).toContain('namespace CustomCompany.BankingApp.Api;');
  });

  it('has zero C# syntax errors ("import" keyword) across all C# generated files', () => {
    const csharpFiles = files.filter(f => f.filename.endsWith('.cs'));
    expect(csharpFiles.length).toBeGreaterThan(5);
    csharpFiles.forEach(file => {
      expect(file.content).not.toMatch(/^import\s+/m);
    });
  });

  it('takes the tenant only from the JWT, with no default tenant', () => {
    const all = files.filter(f => f.filename.endsWith('.cs')).map(f => f.content).join('\n');
    expect(all).toContain('JwtTenant.TenantFrom(');
    expect(all).not.toMatch(/X-Tenant-Id", out var|return "default"/);
  });

  it('generates Polly v8 resilience pipelines with Jitter and Circuit Breaker', () => {
    const resilienceFile = files.find(f => f.filename.includes('src/Infrastructure/Resilience/ResilienceExtensions.cs'))!;
    expect(resilienceFile).toBeDefined();
    expect(resilienceFile.content).toContain('AddRetry');
    expect(resilienceFile.content).toContain('AddCircuitBreaker');
    expect(resilienceFile.content).toContain('AddTimeout');
    expect(resilienceFile.content).toContain('UseJitter = true');
  });

  it('generates an Angular Signals Store bound to the typed API client', () => {
    const storeFile = files.find(f => f.filename === 'frontend/src/app/state/order-management.store.ts')!;
    expect(storeFile).toBeDefined();
    expect(storeFile.content).toContain('signalStore');
    expect(storeFile.content).toContain('patchState');
    expect(storeFile.content).toContain('idempotencyKey');
    expect(files.some(f => f.filename === 'frontend/src/app/state/order-management.store.spec.ts')).toBe(true);
  });

  it('generates Angular SignalR Notification Service', () => {
    const signalrFile = files.find(f => f.filename === 'frontend/src/app/realtime/realtime.service.ts')!;
    expect(signalrFile).toBeDefined();
    expect(signalrFile.content).toContain('@Injectable');
    expect(signalrFile.content).toContain('HubConnectionBuilder');
    expect(signalrFile.content).toContain('ReceiveDomainEvent');
  });

  it('generates an HTTP integration test of the command contract against PostgreSQL', () => {
    const http = files.find(f => f.filename.endsWith('/Api/OrderManagementHttpTests.cs'))!;
    expect(http.content).toContain('[Trait("Category", "Integration")]');
    expect(http.content).toContain('Rejects_requests_without_a_valid_token_and_never_trusts_X_Tenant_Id');
    expect(http.content).toContain('Runs_a_command_into_the_outbox_for_the_token_tenant_idempotently');
});
});
