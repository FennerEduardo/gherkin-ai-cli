import { describe, it, expect } from 'vitest';
import { generateOpenTelemetryConfig } from '../../src/generators/dotnet/opentelemetry-generator';
import { dotnetNamespace, generateCsharpDotnetPreset } from '../../src/generators/preset-csharp-dotnet';
import { parseGherkinText } from '../../src/core/gherkin-parser';

const FEATURE = parseGherkinText('Feature: Payment\n  Scenario: Pay\n    When the customer pays the order\n    Then the order is paid\n');

describe('DotNet generators', () => {
  it('should generate OpenTelemetry config', () => {
    const code = generateOpenTelemetryConfig('TestNamespace');
    expect(code).toContain('namespace TestNamespace.Infrastructure.Telemetry');
    expect(code).toContain('AddOpenTelemetry');
    expect(code).toContain('AddOtlpExporter');
  });

  it('wires the minimal API to the runtime kernel with a JWT tenant, without the 3.0 placeholders', () => {
    const files = generateCsharpDotnetPreset(FEATURE, { projectName: 'Shop' } as any);
    const byName = (suffix: string) => files.find(f => f.filename.endsWith(suffix))?.content ?? '';
    expect(byName('src/Api/Program.cs')).toContain('new CommandService(');
    expect(byName('src/Api/Program.cs')).toContain('AddHostedService<OutboxRelayWorker>');
    expect(byName('PaymentEndpoints.cs')).toContain('JwtTenant.TenantFrom(');
    const all = files.map(f => f.content).join('\n');
    expect(all).not.toContain('X-Tenant-Id", out');
    expect(all).not.toMatch(/MediatR|MassTransit|HttpHeaderTenantService|"default"; \/\/ Fallback/);
    expect(files.some(f => /HttpTests\.cs$/.test(f.filename))).toBe(true);
  });

  it('uses generation.package as the root namespace', () => {
    expect(dotnetNamespace({ projectName: 'shop', generation: { package: 'Acme.Billing' } } as any)).toBe('Acme.Billing');
    expect(dotnetNamespace({ projectName: 'my-shop' } as any)).toBe('myshop');
  });
});
