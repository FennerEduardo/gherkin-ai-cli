export function generateOpenTelemetryConfig(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Configuración ejecutable de OpenTelemetry & OTLP (.NET 8/9)
// --------------------------------------------------------------------------
using System;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using OpenTelemetry.Context.Propagation;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using OpenTelemetry.Metrics;

namespace ${namespace}.Infrastructure.Telemetry
{
    public static class OpenTelemetryExtensions
    {
        public static IServiceCollection AddCustomOpenTelemetry(this IServiceCollection services, IConfiguration configuration, string serviceName)
        {
            var otlpEndpoint = configuration["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4317";

            Sdk.SetDefaultTextMapPropagator(new TraceContextPropagator());

            services.AddOpenTelemetry()
                .ConfigureResource(resource => resource
                    .AddService(serviceName: serviceName, serviceVersion: "1.0.0")
                    .AddTelemetrySdk())
                .WithTracing(tracing =>
                {
                    tracing
                        .AddAspNetCoreInstrumentation(opts => opts.RecordException = true)
                        .AddHttpClientInstrumentation()
                        .AddEntityFrameworkCoreInstrumentation()
                        .AddSource(serviceName)
                        .AddOtlpExporter(otlpOptions =>
                        {
                            otlpOptions.Endpoint = new Uri(otlpEndpoint);
                        });
                })
                .WithMetrics(metrics =>
                {
                    metrics
                        .AddAspNetCoreInstrumentation()
                        .AddHttpClientInstrumentation()
                        .AddRuntimeInstrumentation()
                        .AddOtlpExporter(otlpOptions =>
                        {
                            otlpOptions.Endpoint = new Uri(otlpEndpoint);
                        });
                });

            return services;
        }
    }
}
`;
}
