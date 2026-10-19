import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { renderDeploymentTargets } from '../../src/generators/deploy/targets';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const cfg = (language: string, framework: string, extra: object = {}) =>
  ({ ...defaultConfig, projectName: 'orders', stack: { ...defaultConfig.stack, language, framework, database: 'postgresql' }, ...extra }) as any;
const file = (c: any, suffix: string) => generatePresets(parsed, c).find(f => f.filename.endsWith(suffix))?.content ?? '';

// Every backend exports OTLP/HTTP only when OTEL_EXPORTER_OTLP_ENDPOINT is set, with service.name from OTEL_SERVICE_NAME.
describe('OpenTelemetry export of the running service', () => {
  it.each([
    ['typescript', 'nestjs', 'src/runtime/otel.ts', 'new OTLPTraceExporter()'],
    ['typescript', 'express', 'src/runtime/otel.ts', 'new OTLPTraceExporter()'],
    ['java', 'spring-boot', 'infrastructure/telemetry/OpenTelemetryConfig.java', 'OtlpHttpSpanExporter'],
    ['java', 'quarkus', 'infrastructure/telemetry/OpenTelemetryConfig.java', 'OtlpHttpSpanExporter'],
    ['csharp', 'aspnet-core', 'Infrastructure/Telemetry/OpenTelemetryExtensions.cs', 'OtlpExportProtocol.HttpProtobuf'],
    ['python', 'fastapi', 'app/runtime/otel.py', 'OTLPSpanExporter()'],
    ['python', 'django', 'app/runtime/otel.py', 'OTLPSpanExporter()'],
    ['go', 'chi', 'internal/runtime/otel.go', 'otlptracehttp.New(ctx)'],
    ['rust', 'axum', 'src/runtime/otel.rs', 'with_http()'],
    ['ruby', 'rails', 'config/initializers/opentelemetry.rb', 'require "opentelemetry/exporter/otlp"'],
    ['elixir', 'phoenix', 'config/config.exs', 'traces_exporter: :otlp'],
    ['php', 'laravel', 'app/Providers/RuntimeServiceProvider.php', 'SpanExporterFactory']
  ])('%s/%s: %s', (language, framework, suffix, exporter) => {
    const content = file(cfg(language, framework), suffix);
    expect(content).toContain(exporter);
    expect(content).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(content).toContain('OTEL_SERVICE_NAME');
  });

  it('starts the export at boot and wires .NET Program.cs to the runtime ActivitySource', () => {
    expect(file(cfg('typescript', 'nestjs'), 'src/main.ts')).toContain('startTelemetry();');
    expect(file(cfg('go', 'chi'), 'cmd/server/main.go')).toContain('runtime.StartTelemetry(ctx)');
    expect(file(cfg('csharp', 'aspnet-core'), 'Program.cs')).toContain('AddServiceTelemetry(builder.Configuration, Telemetry.Source.Name');
    expect(file(cfg('python', 'django'), 'config/wsgi.py')).toContain('start_telemetry()');
  });
});

describe('collector sidecars in the generated Terraform', () => {
  it.each([
    ['aws', 'deploy/terraform/aws/main.tf', 'aws-otel-collector', 'ecs-default-config.yaml'],
    ['gcp', 'deploy/terraform/gcp/main.tf', 'opentelemetry-collector-contrib', 'googlecloud: {}'],
    ['azure', 'deploy/terraform/azure/main.tf', 'opentelemetry-collector-contrib', 'azuremonitor:']
  ])('%s', (cloud, mainTf, image, exporter) => {
    const files = Object.fromEntries(renderDeploymentTargets(cfg('go', 'chi', { deploy: { cloud } })).map(f => [f.filename, f.content]));
    const all = Object.values(files).join('\n');
    expect(all).toContain(image);
    expect(all).toContain(exporter);
    expect(files[mainTf]).toContain('OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"');
    expect(files[`deploy/terraform/${cloud}/variables.tf`]).toContain('variable "enable_tracing"');
  });
});
