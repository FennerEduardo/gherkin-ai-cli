/* ==========================================================================
   gherkin-ai-cli - Application layer for Spring Boot (Java) over the JVM
   runtime kernel: REST controller, JWT tenant filter, DataSource from
   DATABASE_URL, CommandService bean, scheduled outbox relay, and
   application.properties. Contract: ./shared.ts.
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { javaPackagePath } from '../java';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';

export interface JvmAppFile {
  filename: string;
  content: string;
}

const j = (s: string) => JSON.stringify(s);

export function renderSpringAppLayer(m: DomainModel, pkg: string, claim: string): JvmAppFile[] {
  const root = `src/main/java/${javaPackagePath(pkg)}`;
  const testRoot = `src/test/java/${javaPackagePath(pkg)}`;
  const first = m.commands[0];

  const filter = `package ${pkg}.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Authenticates /api requests with an HS256 bearer token (JWT_SECRET) and exposes the tenant from the
 * ${j(claim)} claim as the request attribute "tenantId". The tenant is never read from a header such
 * as X-Tenant-Id, and there is no default tenant: requests without one get 401.
 */
@Component
@Order(1)
public class JwtTenantFilter extends OncePerRequestFilter {
    public static final String TENANT_CLAIM = ${j(claim)};
    public static final String TENANT_ATTRIBUTE = "tenantId";
    private static final ObjectMapper JSON = new ObjectMapper();
    private final String secret;

    public JwtTenantFilter(@Value("\${ghk.jwt-secret:}") String secret) {
        this.secret = secret;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/api/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        String tenant = tenantOf(request.getHeader("Authorization"), secret);
        if (tenant == null) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json");
            response.getWriter().write("{\\"detail\\":\\"A valid bearer token with a tenant is required\\"}");
            return;
        }
        request.setAttribute(TENANT_ATTRIBUTE, tenant);
        chain.doFilter(request, response);
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
            return claims.get(TENANT_CLAIM) instanceof String tenant && !tenant.isBlank() ? tenant : null;
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

  const config = `package ${pkg}.runtime;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Wires the runtime kernel into Spring: a pooled DataSource from DATABASE_URL (libpq URL, shared with
 * JPA), the CommandService, and the outbox relay below.
 */
@Configuration
public class RuntimeConfiguration {
    @Bean
    public DataSource dataSource() {
        String url = System.getenv("DATABASE_URL");
        if (url == null || url.isBlank()) throw new IllegalStateException("DATABASE_URL is not set (postgres://user:password@host:5432/db)");
        URI uri = URI.create(url.replaceFirst("^postgres(ql)?://", "postgresql://"));
        String[] userInfo = uri.getRawUserInfo() == null ? new String[0] : uri.getRawUserInfo().split(":", 2);
        return DataSourceBuilder.create()
            .url("jdbc:postgresql://" + uri.getHost() + ":" + (uri.getPort() > 0 ? uri.getPort() : 5432) + uri.getPath())
            .username(userInfo.length > 0 ? URLDecoder.decode(userInfo[0], StandardCharsets.UTF_8) : null)
            .password(userInfo.length > 1 ? URLDecoder.decode(userInfo[1], StandardCharsets.UTF_8) : null)
            .build();
    }

    @Bean
    public ConnectionFactory connectionFactory(DataSource dataSource) {
        return dataSource::getConnection;
    }

    @Bean
    public CommandService commandService(ConnectionFactory connections) {
        return new CommandService(connections, "public");
    }

    /** Publishes the outbox every ${RELAY_INTERVAL_MS} ms when a broker is configured (Broker: GHK_BROKER, AMQP_URL, PUBSUB_*). */
    @Component
    public static class OutboxRelayWorker implements DisposableBean {
        private static final Logger LOG = LoggerFactory.getLogger(OutboxRelayWorker.class);
        private final ConnectionFactory connections;
        private final boolean enabled;
        private final String workerId = ${j(m.kebab + '-')} + UUID.randomUUID();
        private Broker broker;
        private EventPublisher publisher;
        private OutboxRelay relay;
        private boolean warned;

        public OutboxRelayWorker(ConnectionFactory connections, @Value("\${ghk.outbox.relay-enabled:true}") boolean enabled) {
            this.connections = connections;
            this.enabled = enabled;
        }

        @Scheduled(fixedDelay = ${RELAY_INTERVAL_MS})
        public synchronized void publish() {
            if (!enabled) return;
            if (!Broker.configured()) {
                if (!warned) LOG.warn("No event broker is configured (AMQP_URL, or GHK_BROKER=pubsub with PUBSUB_PROJECT_ID): outbox events are stored but not published.");
                warned = true;
                return;
            }
            try {
                if (relay == null) {
                    broker = Broker.fromEnv();
                    broker.declare(Topology.DEFAULT);
                    publisher = broker.publisher(Topology.DEFAULT.exchange());
                    relay = new OutboxRelay(connections, publisher, "public");
                }
                relay.publishBatch(workerId, 50);
            } catch (Exception e) {
                LOG.error("Outbox relay failed: {}", e.getMessage());
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

        @Override
        public synchronized void destroy() {
            close();
        }
    }
}
`;

  const controller = `package ${pkg}.api;

import ${pkg}.auth.JwtTenantFilter;
import ${pkg}.domain.DomainValidationException;
import ${pkg}.runtime.CommandService;
import java.sql.SQLException;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** POST ${commandRoute(m)}/{id}/{command} (${m.commands.map(c => c.snake).join(', ')}). */
// ghk:implements ${m.pascal}
@RestController
@RequestMapping(${j(commandRoute(m))})
public class ${m.pascal}Controller {
    private static final Map<String, HttpStatus> STATUS = Map.of("created", HttpStatus.ACCEPTED, "replayed", HttpStatus.OK, "in-progress", HttpStatus.CONFLICT);
    private final CommandService commands;

    public ${m.pascal}Controller(CommandService commands) {
        this.commands = commands;
    }

    @PostMapping("/{id}/{command}")
    public ResponseEntity<CommandService.Result> handle(
        @PathVariable("id") String id,
        @PathVariable("command") String command,
        @RequestBody(required = false) Map<String, Object> payload,
        @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
        @RequestHeader(value = "traceparent", required = false) String traceparent,
        @RequestAttribute(JwtTenantFilter.TENANT_ATTRIBUTE) String tenantId
    ) throws SQLException {
        CommandService.Result result = commands.handle(new CommandService.Request(tenantId, id, command, payload == null ? Map.of() : payload, idempotencyKey, traceparent, ${j(m.pascal)}));
        return ResponseEntity.status(STATUS.getOrDefault(result.status(), HttpStatus.OK)).body(result);
    }

    @ExceptionHandler(DomainValidationException.class)
    public ResponseEntity<Map<String, String>> invalid(DomainValidationException e) {
        return ResponseEntity.unprocessableEntity().body(Map.of("detail", String.valueOf(e.getMessage())));
    }
}
`;

  const health = `package ${pkg}.api;

import java.sql.Connection;
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Probes for container platforms: /health (process is up) and /health/ready (database reachable). */
@RestController
public class HealthController {
    private final DataSource dataSource;

    public HealthController(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    @GetMapping("/health")
    public Map<String, String> live() {
        return Map.of("status", "ok");
    }

    @GetMapping("/health/ready")
    public ResponseEntity<Map<String, String>> ready() {
        try (Connection conn = dataSource.getConnection()) {
            if (conn.isValid(2)) return ResponseEntity.ok(Map.of("status", "ok"));
        } catch (Exception e) {
            // reported below
        }
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("status", "unavailable"));
    }
}
`;

  const properties = `# Generated by gherkin-ai. The database and broker come from DATABASE_URL / AMQP_URL (see .env.example);
# the DataSource is built from DATABASE_URL in runtime/RuntimeConfiguration.java.
server.port=\${SERVER_PORT:8080}
spring.application.name=${m.kebab}
# The runtime kernel creates its own tables (Schema.migrate); JPA must not alter the schema.
spring.jpa.hibernate.ddl-auto=none
spring.jpa.open-in-view=false
# HS256 secret of the bearer tokens (the tenant comes from their claim, never from a header).
ghk.jwt-secret=\${JWT_SECRET:}
# Publish the outbox from this process (turn off when a separate relay process runs).
ghk.outbox.relay-enabled=\${GHK_OUTBOX_RELAY:true}
`;

  const httpTest = `package ${pkg}.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ${pkg}.auth.JwtTenantFilter;
import ${pkg}.runtime.ConnectionFactory;
import ${pkg}.runtime.Schema;
import java.net.URI;
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
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/** HTTP contract of the application layer against PostgreSQL (needs DATABASE_URL). */
@Tag("integration")
// The relay is off here: its publish spans would mix with the trace assertions of the runtime tests in this JVM.
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"ghk.jwt-secret=" + ${m.pascal}HttpIntegrationTest.SECRET, "ghk.outbox.relay-enabled=false"})
class ${m.pascal}HttpIntegrationTest {
    static final String SECRET = "integration-test-secret-with-32-chars!";
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    @LocalServerPort
    int port;

    @BeforeAll
    static void migrate() throws Exception {
        Schema.migrate(ConnectionFactory.fromUrl(System.getenv("DATABASE_URL")), "public");
    }

    private HttpResponse<String> post(String path, Map<String, String> headers) throws Exception {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
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
        for (String probe : new String[] {"/health", "/health/ready"}) {
            HttpResponse<String> res = HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + probe)).build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(200, res.statusCode(), probe);
        }
    }
}
`;

  return [
    { filename: `${root}/auth/JwtTenantFilter.java`, content: filter },
    { filename: `${root}/runtime/RuntimeConfiguration.java`, content: config },
    { filename: `${root}/api/${m.pascal}Controller.java`, content: controller },
    { filename: `${root}/api/HealthController.java`, content: health },
    { filename: 'src/main/resources/application.properties', content: properties },
    { filename: `${testRoot}/api/${m.pascal}HttpIntegrationTest.java`, content: httpTest }
  ];
}
