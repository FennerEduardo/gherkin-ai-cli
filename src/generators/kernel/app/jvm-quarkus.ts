/* ==========================================================================
   gherkin-ai-cli - Application layer for Quarkus (Java) over the JVM runtime
   kernel: Quarkus REST resource, JWT tenant filter, Agroal datasource from
   DATABASE_URL (config source), CommandService producer, scheduled outbox
   relay, OpenTelemetry bootstrap and application.properties.
   Same HTTP contract as the Spring layer (./jvm.ts, ./shared.ts).
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { javaPackagePath } from '../java';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';
import type { JvmAppFile } from './jvm';

const j = (s: string) => JSON.stringify(s);

export function renderQuarkusAppLayer(m: DomainModel, pkg: string, claim: string): JvmAppFile[] {
  const root = `src/main/java/${javaPackagePath(pkg)}`;
  const testRoot = `src/test/java/${javaPackagePath(pkg)}`;
  const first = m.commands[0];

  const tenantContext = `package ${pkg}.auth;

import jakarta.enterprise.context.RequestScoped;

/** Tenant of the current request, set by JwtTenantFilter from the validated bearer token. */
@RequestScoped
public class TenantContext {
    private String tenantId;

    public String tenantId() {
        return tenantId;
    }

    void set(String tenantId) {
        this.tenantId = tenantId;
    }
}
`;

  const filter = `package ${pkg}.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Priority;
import jakarta.inject.Inject;
import jakarta.ws.rs.Priorities;
import jakarta.ws.rs.container.ContainerRequestContext;
import jakarta.ws.rs.container.ContainerRequestFilter;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.Provider;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;
import java.util.Optional;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.eclipse.microprofile.config.inject.ConfigProperty;

/**
 * Authenticates /api requests with an HS256 bearer token (JWT_SECRET) and exposes the tenant from the
 * ${j(claim)} claim through TenantContext. The tenant is never read from a header such as X-Tenant-Id,
 * and there is no default tenant: requests without one get 401.
 */
@Provider
@Priority(Priorities.AUTHENTICATION)
public class JwtTenantFilter implements ContainerRequestFilter {
    public static final String TENANT_CLAIM = ${j(claim)};
    private static final ObjectMapper JSON = new ObjectMapper();

    @ConfigProperty(name = "ghk.jwt-secret")
    Optional<String> secret;

    @Inject
    TenantContext tenant;

    @Override
    public void filter(ContainerRequestContext request) {
        String path = request.getUriInfo().getPath();
        if (!(path.startsWith("/api/") || path.startsWith("api/"))) return;
        String tenantId = tenantOf(request.getHeaderString("Authorization"), secret.orElse(""));
        if (tenantId == null) {
            request.abortWith(Response.status(Response.Status.UNAUTHORIZED).type(MediaType.APPLICATION_JSON)
                .entity("{\\"detail\\":\\"A valid bearer token with a tenant is required\\"}").build());
            return;
        }
        tenant.set(tenantId);
    }

    /** Tenant claim of a valid HS256 token (signature, exp, nbf checked), else null. */
    public static String tenantOf(String authorization, String secret) {
        if (authorization == null || !authorization.regionMatches(true, 0, "Bearer ", 0, 7) || secret == null || secret.isEmpty()) return null;
        String[] parts = authorization.substring(7).trim().split("\\\\.");
        if (parts.length != 3) return null;
        try {
            Map<?, ?> header = JSON.readValue(Base64.getUrlDecoder().decode(parts[0]), Map.class);
            if (!"HS256".equals(header.get("alg"))) return null;
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] expected = mac.doFinal((parts[0] + "." + parts[1]).getBytes(StandardCharsets.UTF_8));
            if (!MessageDigest.isEqual(expected, Base64.getUrlDecoder().decode(parts[2]))) return null;
            Map<?, ?> claims = JSON.readValue(Base64.getUrlDecoder().decode(parts[1]), Map.class);
            long now = System.currentTimeMillis() / 1000;
            if (claims.get("exp") instanceof Number exp && now >= exp.longValue()) return null;
            if (claims.get("nbf") instanceof Number nbf && now < nbf.longValue()) return null;
            return claims.get(TENANT_CLAIM) instanceof String t && !t.isBlank() ? t : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Signs an HS256 token (tests and local tooling; production tokens come from your identity provider). */
    public static String sign(Map<String, Object> claims, String secret) throws Exception {
        Base64.Encoder enc = Base64.getUrlEncoder().withoutPadding();
        String head = enc.encodeToString("{\\"alg\\":\\"HS256\\",\\"typ\\":\\"JWT\\"}".getBytes(StandardCharsets.UTF_8));
        String body = enc.encodeToString(JSON.writeValueAsBytes(claims));
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return head + "." + body + "." + enc.encodeToString(mac.doFinal((head + "." + body).getBytes(StandardCharsets.UTF_8)));
    }
}
`;

  const configSource = `package ${pkg}.runtime;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import org.eclipse.microprofile.config.spi.ConfigSource;

/**
 * Maps DATABASE_URL (libpq form, postgres://user:password@host:5432/db, shared by every gherkin-ai stack)
 * to the Quarkus datasource (quarkus.datasource.jdbc.url / username / password). Explicit
 * QUARKUS_DATASOURCE_* environment variables still win (ordinal below the environment).
 */
public class DatabaseUrlConfigSource implements ConfigSource {
    private final Map<String, String> values = new HashMap<>();

    public DatabaseUrlConfigSource() {
        String url = System.getenv("DATABASE_URL");
        if (url == null || url.isBlank()) return;
        URI uri = URI.create(url.replaceFirst("^postgres(ql)?://", "postgresql://"));
        values.put("quarkus.datasource.jdbc.url", "jdbc:postgresql://" + uri.getHost() + ":" + (uri.getPort() > 0 ? uri.getPort() : 5432) + uri.getPath());
        String[] userInfo = uri.getRawUserInfo() == null ? new String[0] : uri.getRawUserInfo().split(":", 2);
        if (userInfo.length > 0) values.put("quarkus.datasource.username", URLDecoder.decode(userInfo[0], StandardCharsets.UTF_8));
        if (userInfo.length > 1) values.put("quarkus.datasource.password", URLDecoder.decode(userInfo[1], StandardCharsets.UTF_8));
    }

    @Override
    public Set<String> getPropertyNames() {
        return values.keySet();
    }

    @Override
    public String getValue(String propertyName) {
        return values.get(propertyName);
    }

    @Override
    public String getName() {
        return "DATABASE_URL";
    }

    @Override
    public int getOrdinal() {
        return 275;
    }
}
`;

  const producers = `package ${pkg}.runtime;

import io.agroal.api.AgroalDataSource;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.inject.Produces;

/** Wires the runtime kernel into CDI: connections from the Agroal pool (DATABASE_URL) and the CommandService. */
@ApplicationScoped
public class RuntimeProducers {
    @Produces
    @ApplicationScoped
    ConnectionFactory connectionFactory(AgroalDataSource dataSource) {
        return dataSource::getConnection;
    }

    @Produces
    @ApplicationScoped
    CommandService commandService(ConnectionFactory connections) {
        return new CommandService(connections, "public");
    }
}
`;

  const relayWorker = `package ${pkg}.runtime;

import io.quarkus.scheduler.Scheduled;
import jakarta.annotation.PreDestroy;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import java.util.UUID;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;

/** Publishes the outbox every ${RELAY_INTERVAL_MS} ms when a broker is configured (Broker: GHK_BROKER, AMQP_URL, PUBSUB_*). */
@ApplicationScoped
public class OutboxRelayWorker {
    private static final Logger LOG = Logger.getLogger(OutboxRelayWorker.class);
    private final String workerId = ${j(m.kebab + '-')} + UUID.randomUUID();
    private Broker broker;
    private EventPublisher publisher;
    private OutboxRelay relay;
    private boolean warned;

    @Inject
    ConnectionFactory connections;

    @ConfigProperty(name = "ghk.outbox.relay-enabled", defaultValue = "true")
    boolean enabled;

    @Scheduled(every = "PT${RELAY_INTERVAL_MS / 1000}S", concurrentExecution = Scheduled.ConcurrentExecution.SKIP)
    synchronized void publish() {
        if (!enabled) return;
        if (!Broker.configured()) {
            if (!warned) LOG.warn("No event broker is configured (AMQP_URL, or GHK_BROKER=pubsub with PUBSUB_PROJECT_ID): outbox events are stored but not published.");
            warned = true;
            return;
        }
        try {
            if (relay == null) {
                broker = Broker.fromEnv();
                // GHK_DECLARE_TOPOLOGY=false when infrastructure as code owns the topology (least-privilege credentials).
                if (!"false".equals(System.getenv("GHK_DECLARE_TOPOLOGY"))) broker.declare(Topology.DEFAULT);
                publisher = broker.publisher(Topology.DEFAULT.exchange());
                relay = new OutboxRelay(connections, publisher, "public");
            }
            relay.publishBatch(workerId, 50);
        } catch (Exception e) {
            LOG.errorf("Outbox relay failed: %s", e.getMessage());
            close();
        }
    }

    private void close() {
        relay = null;
        try { if (publisher != null) publisher.close(); } catch (Exception ignored) { }
        try { if (broker != null) broker.close(); } catch (Exception ignored) { }
        publisher = null;
        broker = null;
    }

    @PreDestroy
    synchronized void destroy() {
        close();
    }
}
`;

  const telemetry = `package ${pkg}.infrastructure.telemetry;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.quarkus.runtime.StartupEvent;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

/**
 * With OTEL_EXPORTER_OTLP_ENDPOINT set, registers an OTLP/HTTP exporter (service.name from OTEL_SERVICE_NAME) as the
 * global OpenTelemetry the runtime kernel traces with, unless one is already registered (agent or test harness).
 * Without it nothing is exported and nothing connects.
 */
@ApplicationScoped
public class OpenTelemetryConfig {
    void onStart(@Observes StartupEvent event) {
        String endpoint = System.getenv("OTEL_EXPORTER_OTLP_ENDPOINT");
        if (endpoint == null || endpoint.isBlank()) return;
        String service = System.getenv().getOrDefault("OTEL_SERVICE_NAME", ${j(m.service || m.kebab)});
        SdkTracerProvider tracerProvider = SdkTracerProvider.builder()
            .setResource(Resource.getDefault().merge(Resource.create(Attributes.of(AttributeKey.stringKey("service.name"), service))))
            .addSpanProcessor(BatchSpanProcessor.builder(OtlpHttpSpanExporter.builder().setEndpoint(endpoint.replaceAll("/+$", "") + "/v1/traces").build()).build())
            .build();
        try {
            OpenTelemetrySdk.builder()
                .setTracerProvider(tracerProvider)
                .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
                .buildAndRegisterGlobal();
        } catch (IllegalStateException alreadyRegistered) {
            // Keep the registered one (OpenTelemetry Java agent, or a test harness).
            tracerProvider.close();
        }
    }
}
`;

  const resource = `package ${pkg}.api;

import ${pkg}.auth.TenantContext;
import ${pkg}.runtime.CommandService;
import jakarta.inject.Inject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.HeaderParam;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.sql.SQLException;
import java.util.Map;

/** POST ${commandRoute(m)}/{id}/{command} (${m.commands.map(c => c.snake).join(', ')}). Runs on a worker thread (blocking JDBC). */
// ghk:implements ${m.pascal}
@Path(${j(commandRoute(m))})
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class ${m.pascal}Resource {
    private static final Map<String, Integer> STATUS = Map.of("created", 202, "replayed", 200, "in-progress", 409);

    @Inject
    CommandService commands;

    @Inject
    TenantContext tenant;

    @POST
    @Path("/{id}/{command}")
    public Response handle(
        @PathParam("id") String id,
        @PathParam("command") String command,
        @HeaderParam("Idempotency-Key") String idempotencyKey,
        @HeaderParam("traceparent") String traceparent,
        Map<String, Object> payload
    ) throws SQLException {
        CommandService.Result result = commands.handle(new CommandService.Request(tenant.tenantId(), id, command, payload == null ? Map.of() : payload, idempotencyKey, traceparent, ${j(m.pascal)}));
        return Response.status(STATUS.getOrDefault(result.status(), 200)).entity(result).build();
    }
}
`;

  const mapper = `package ${pkg}.api;

import ${pkg}.domain.DomainValidationException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.ExceptionMapper;
import jakarta.ws.rs.ext.Provider;
import java.util.Map;

/** Domain rule violations are 422 Unprocessable Entity. */
@Provider
public class DomainValidationExceptionMapper implements ExceptionMapper<DomainValidationException> {
    @Override
    public Response toResponse(DomainValidationException e) {
        return Response.status(422).type(MediaType.APPLICATION_JSON).entity(Map.of("detail", String.valueOf(e.getMessage()))).build();
    }
}
`;

  const properties = `# Generated by gherkin-ai. The database and broker come from DATABASE_URL / AMQP_URL (see .env.example);
# runtime/DatabaseUrlConfigSource.java maps DATABASE_URL to the Agroal datasource below.
quarkus.application.name=${m.kebab}
quarkus.http.port=\${SERVER_PORT:8080}
quarkus.http.test-port=0
quarkus.banner.enabled=false
quarkus.datasource.db-kind=postgresql
# The runtime kernel manages its own JDBC transactions (outbox in the same transaction as the aggregate).
quarkus.datasource.jdbc.transactions=disabled
# PostgreSQL and RabbitMQ are provided (docker compose / CI): no Dev Services containers.
quarkus.devservices.enabled=false
# HS256 secret of the bearer tokens (the tenant comes from their claim, never from a header).
ghk.jwt-secret=\${JWT_SECRET:}
# Publish the outbox from this process (turn off when a separate relay process runs).
ghk.outbox.relay-enabled=\${GHK_OUTBOX_RELAY:true}

# Tests: fixed secret; the relay is off so its spans do not mix with the runtime trace assertions.
%test.ghk.jwt-secret=integration-test-secret-with-32-chars!
%test.ghk.outbox.relay-enabled=false
`;

  const httpTest = `package ${pkg}.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ${pkg}.auth.JwtTenantFilter;
import ${pkg}.runtime.ConnectionFactory;
import ${pkg}.runtime.Schema;
import io.quarkus.test.common.http.TestHTTPResource;
import io.quarkus.test.junit.QuarkusTest;
import java.net.URI;
import java.net.URL;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** HTTP contract of the application layer against PostgreSQL (needs DATABASE_URL). */
@Tag("integration")
@QuarkusTest
class ${m.pascal}HttpIntegrationTest {
    static final String SECRET = "integration-test-secret-with-32-chars!";
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    @TestHTTPResource("/")
    URL base;

    @BeforeAll
    static void migrate() throws Exception {
        Schema.migrate(ConnectionFactory.fromUrl(System.getenv("DATABASE_URL")), "public");
    }

    private HttpResponse<String> post(String path, Map<String, String> headers) throws Exception {
        HttpRequest.Builder req = HttpRequest.newBuilder(base.toURI().resolve(path.substring(1)))
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString("{}"));
        headers.forEach(req::header);
        return HTTP.send(req.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String bearer(Map<String, Object> claims) throws Exception {
        return "Bearer " + JwtTenantFilter.sign(claims, SECRET);
    }

    @Test
    void rejectsRequestsWithoutAValidTokenAndNeverTrustsXTenantId() throws Exception {
        String path = ${j(commandRoute(m) + '/')} + UUID.randomUUID() + ${j('/' + first.snake)};
        assertEquals(401, post(path, Map.of()).statusCode());
        assertEquals(401, post(path, Map.of("X-Tenant-Id", "acme")).statusCode());
        assertEquals(401, post(path, Map.of("Authorization", bearer(Map.of("sub", "u1")))).statusCode());
        assertEquals(401, post(path, Map.of("Authorization", "Bearer " + JwtTenantFilter.sign(Map.of(JwtTenantFilter.TENANT_CLAIM, "acme"), "wrong-secret"))).statusCode());
    }

    @Test
    void runsACommandIntoTheOutboxForTheTokenTenantIdempotently() throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        String id = UUID.randomUUID().toString();
        Map<String, String> headers = Map.of("Authorization", bearer(Map.of(JwtTenantFilter.TENANT_CLAIM, tenant)), "Idempotency-Key", UUID.randomUUID().toString(), "X-Tenant-Id", "someone-else");
        String path = ${j(commandRoute(m) + '/')} + id + ${j('/' + first.snake)};
        assertEquals(202, post(path, headers).statusCode());
        HttpResponse<String> replay = post(path, headers);
        assertEquals(200, replay.statusCode());
        assertTrue(replay.body().contains("replayed"));
        try (Connection conn = ConnectionFactory.fromUrl(System.getenv("DATABASE_URL")).open();
             PreparedStatement ps = conn.prepareStatement("SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = ?")) {
            ps.setString(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                assertTrue(rs.next());
                assertEquals(tenant, rs.getString(1));
            }
        }
    }

    @Test
    void mapsDomainValidationErrorsTo422() throws Exception {
        String path = ${j(commandRoute(m) + '/')} + UUID.randomUUID() + "/no_such_command";
        assertEquals(422, post(path, Map.of("Authorization", bearer(Map.of(JwtTenantFilter.TENANT_CLAIM, "acme")))).statusCode());
    }

    @Test
    void reportsHealth() throws Exception {
        HttpResponse<String> live = HTTP.send(HttpRequest.newBuilder(base.toURI().resolve("q/health/live")).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, live.statusCode());
        HttpResponse<String> ready = HTTP.send(HttpRequest.newBuilder(base.toURI().resolve("q/health/ready")).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, ready.statusCode());
    }
}
`;

  return [
    { filename: `${root}/auth/TenantContext.java`, content: tenantContext },
    { filename: `${root}/auth/JwtTenantFilter.java`, content: filter },
    { filename: `${root}/runtime/DatabaseUrlConfigSource.java`, content: configSource },
    { filename: 'src/main/resources/META-INF/services/org.eclipse.microprofile.config.spi.ConfigSource', content: `${pkg}.runtime.DatabaseUrlConfigSource\n` },
    { filename: `${root}/runtime/RuntimeProducers.java`, content: producers },
    { filename: `${root}/runtime/OutboxRelayWorker.java`, content: relayWorker },
    { filename: `${root}/infrastructure/telemetry/OpenTelemetryConfig.java`, content: telemetry },
    { filename: `${root}/api/${m.pascal}Resource.java`, content: resource },
    { filename: `${root}/api/DomainValidationExceptionMapper.java`, content: mapper },
    { filename: 'src/main/resources/application.properties', content: properties },
    { filename: `${testRoot}/api/${m.pascal}HttpIntegrationTest.java`, content: httpTest }
  ];
}
