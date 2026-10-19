/**
 * OpenTelemetry export of the ASP.NET Core service: with OTEL_EXPORTER_OTLP_ENDPOINT set, the runtime kernel's
 * ActivitySource and the ASP.NET Core / HttpClient instrumentation are exported over OTLP/HTTP (service.name from
 * OTEL_SERVICE_NAME). Without it nothing is exported and nothing connects.
 */
export function generateOpenTelemetryConfig(namespace: string): string {
  return `using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;
using OpenTelemetry.Exporter;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace ${namespace}.Infrastructure.Telemetry;

public static class OpenTelemetryExtensions
{
    /// <summary>Exports traces over OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise does nothing.</summary>
    public static IServiceCollection AddServiceTelemetry(this IServiceCollection services, IConfiguration configuration, string sourceName, string defaultServiceName)
    {
        var endpoint = configuration["OTEL_EXPORTER_OTLP_ENDPOINT"];
        if (string.IsNullOrWhiteSpace(endpoint)) return services;
        var serviceName = configuration["OTEL_SERVICE_NAME"] is { Length: > 0 } name ? name : defaultServiceName;

        Sdk.SetDefaultTextMapPropagator(new TraceContextPropagator());
        services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService(serviceName))
            .WithTracing(tracing => tracing
                .AddSource(sourceName)
                .AddAspNetCoreInstrumentation(options => options.RecordException = true)
                .AddHttpClientInstrumentation()
                .AddOtlpExporter(options =>
                {
                    options.Protocol = OtlpExportProtocol.HttpProtobuf;
                    options.Endpoint = new Uri(endpoint.TrimEnd('/') + "/v1/traces");
                }));
        return services;
    }
}
`;
}
