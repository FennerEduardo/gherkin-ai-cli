// --------------------------------------------------------------------------
// OpenTelemetry export of a Spring Boot service (Java and Kotlin projects)
// --------------------------------------------------------------------------

/**
 * @param serviceName default service.name (OTEL_SERVICE_NAME overrides it)
 */
export function generateJavaOpenTelemetryInfrastructure(packageName: string, serviceName = 'service'): string {
  return `package ${packageName}.infrastructure.telemetry;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * With OTEL_EXPORTER_OTLP_ENDPOINT set, registers an OTLP/HTTP exporter (service.name from OTEL_SERVICE_NAME) as the
 * global OpenTelemetry the runtime kernel traces with, unless one is already registered (the OpenTelemetry Java agent,
 * or a test harness). Without it nothing is exported and nothing connects.
 */
@Configuration
public class OpenTelemetryConfig {

    @Bean
    public OpenTelemetry openTelemetry() {
        String endpoint = System.getenv("OTEL_EXPORTER_OTLP_ENDPOINT");
        if (endpoint == null || endpoint.isBlank()) {
            return GlobalOpenTelemetry.get();
        }
        String service = System.getenv().getOrDefault("OTEL_SERVICE_NAME", ${JSON.stringify(serviceName)});
        SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
                .setResource(Resource.getDefault().merge(Resource.create(Attributes.of(AttributeKey.stringKey("service.name"), service))))
                .addSpanProcessor(BatchSpanProcessor.builder(
                        OtlpHttpSpanExporter.builder().setEndpoint(endpoint.replaceAll("/+$", "") + "/v1/traces").build()).build())
                .build();
        try {
            return OpenTelemetrySdk.builder()
                    .setTracerProvider(tracerProvider)
                    .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
                    .buildAndRegisterGlobal();
        } catch (IllegalStateException alreadyRegistered) {
            tracerProvider.close();
            return GlobalOpenTelemetry.get();
        }
    }

    @Bean
    public Tracer tracer(OpenTelemetry openTelemetry) {
        return openTelemetry.getTracer("${packageName}", "1.0.0");
    }
}
`;
}
