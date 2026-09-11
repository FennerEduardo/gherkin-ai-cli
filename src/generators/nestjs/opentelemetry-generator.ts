export function generateNestJsOpenTelemetry(): string {
  return `// --------------------------------------------------------------------------
// OpenTelemetry para NestJS / OpenTelemetry Setup for NestJS
// --------------------------------------------------------------------------
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

export const otelSDK = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTLP_TRACE_URL || 'http://localhost:4318/v1/traces',
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: process.env.OTLP_METRICS_URL || 'http://localhost:4318/v1/metrics',
    }),
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-nestjs-core': { enabled: true },
      '@opentelemetry/instrumentation-express': { enabled: true },
      '@opentelemetry/instrumentation-http': { enabled: true },
    }),
  ],
});

// Inicializar antes de cargar el módulo principal:
// Initialize before loading the main module:
// otelSDK.start();
`;
}
