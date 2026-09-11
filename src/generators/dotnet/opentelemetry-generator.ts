export function generateOpenTelemetryConfig(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Configuración base de OpenTelemetry / OpenTelemetry base configuration
// --------------------------------------------------------------------------
using Microsoft.Extensions.DependencyInjection;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using OpenTelemetry.Metrics;

namespace ${namespace}.Infrastructure.Telemetry
{
    public static class OpenTelemetryExtensions
    {
        public static IServiceCollection AddCustomOpenTelemetry(this IServiceCollection services, string serviceName)
        {
            services.AddOpenTelemetry()
                .ConfigureResource(resource => resource.AddService(serviceName))
                .WithTracing(tracing =>
                {
                    tracing
                        .AddAspNetCoreInstrumentation()
                        .AddHttpClientInstrumentation()
                        .AddEntityFrameworkCoreInstrumentation()
                        .AddSource(serviceName) // Trazas de dominio / Domain traces
                        .AddOtlpExporter();
                })
                .WithMetrics(metrics =>
                {
                    metrics
                        .AddAspNetCoreInstrumentation()
                        .AddHttpClientInstrumentation()
                        .AddRuntimeInstrumentation()
                        .AddOtlpExporter();
                });

            return services;
        }
    }
}
`;
}
