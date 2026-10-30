/* ==========================================================================
   gherkin-ai-cli - BFF for Spring Boot (see bff/model.ts)

   Spring MVC + java.net.http.HttpClient: no JPA, JDBC, AMQP or kernel.
   (HttpURLConnection drops the body of a 401, which the LMS BFF ran into.)
   ========================================================================== */

import type { GherkinAIConfig } from '../../core/config';
import type { ParsedFeature } from '../../core/gherkin-parser';
import { buildDomainModel, toKebab, type DomainModel } from '../kernel/domain-model';
import { JACOCO_PLUGIN, javaPackagePath, renderSpringApplication } from '../kernel/java';
import { JVM_VERSIONS } from '../versions';
import { jvmBasePackage, jvmGroupId } from '../preset-java-spring';
import { bffRoute, bffTimeout, bffUpstreams, featureUpstream, upstreamRoute } from './model';

type File = { filename: string; content: string };

function renderBffPom(artifactId: string, groupId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <!-- Backend-for-frontend (stack.role "bff"): no database, broker or runtime kernel. -->
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>${JVM_VERSIONS.springBoot}</version>
    <relativePath/>
  </parent>

  <groupId>${groupId}</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>0.0.1-SNAPSHOT</version>

  <properties>
    <java.version>${JVM_VERSIONS.java}</java.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-webmvc</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
${JACOCO_PLUGIN}
    </plugins>
  </build>
</project>
`;
}

function renderUpstreamClient(pkg: string): string {
  return `package ${pkg}.upstream;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** HTTP client to one domain service (stack.role "bff"). */
public final class UpstreamClient {
  /** Headers the BFF passes on: the caller's identity, trace context and idempotency. */
  private static final List<String> FORWARDED = List.of("authorization", "traceparent", "tracestate", "idempotency-key", "accept-language");

  public record Forwarded(int status, String body, String requestId) {}

  private final String name;
  private final String baseUrl;
  private final Duration timeout;
  private final HttpClient http;

  public UpstreamClient(String name, String baseUrl, Duration timeout) {
    this.name = name;
    this.baseUrl = baseUrl.replaceAll("/+$", "");
    this.timeout = timeout;
    this.http = HttpClient.newBuilder().connectTimeout(timeout).build();
  }

  public String name() { return name; }

  /** @param incoming request headers with lower-case names */
  public Forwarded post(String path, String body, Map<String, String> incoming) {
    String requestId = incoming.getOrDefault("x-request-id", UUID.randomUUID().toString());
    HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(baseUrl + path))
        .timeout(timeout)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .header("x-request-id", requestId)
        .POST(HttpRequest.BodyPublishers.ofString(body == null || body.isBlank() ? "{}" : body));
    for (String header : FORWARDED) {
      String value = incoming.get(header);
      if (value != null && !value.isBlank()) request.header(header, value);
    }
    try {
      HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
      // A failure inside the service is not the client's to handle: 502 without its internals.
      if (response.statusCode() >= 500) return new Forwarded(502, detail(name + " failed (" + response.statusCode() + ")"), requestId);
      String answer = response.body() == null || response.body().isBlank() ? "{}" : response.body();
      return new Forwarded(response.statusCode(), answer, requestId);
    } catch (HttpTimeoutException e) {
      return new Forwarded(504, detail(name + " did not answer in time"), requestId);
    } catch (IOException e) {
      return new Forwarded(502, detail(name + " is unavailable"), requestId);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return new Forwarded(502, detail(name + " is unavailable"), requestId);
    }
  }

  static String detail(String message) {
    return "{\\"detail\\":\\"" + message.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"") + "\\"}";
  }
}
`;
}

function renderUpstreams(pkg: string, config: GherkinAIConfig): string {
  const upstreams = bffUpstreams(config);
  return `package ${pkg}.upstream;

import java.time.Duration;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/** One client per bff.upstreams entry, by name. */
public record Upstreams(Map<String, UpstreamClient> clients) {
  public static final Duration TIMEOUT = Duration.ofMillis(${bffTimeout(config)});

  public UpstreamClient get(String name) {
    return clients.get(name);
  }

  /** Each client at the URL in its environment variable. */
  @Configuration
  public static class FromEnvironment {
    @Bean
    public Upstreams upstreams(Environment env) {
      return new Upstreams(Map.of(
${upstreams.map(u => `          "${u.name}", new UpstreamClient("${u.name}", env.getProperty("${u.envVar}", "${u.url}"), TIMEOUT)`).join(',\n')}
      ));
    }
  }
}
`;
}

function renderGateway(pkg: string): string {
  return `package ${pkg}.upstream;

import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/** One BFF route forwarded to its upstream: auth presence, command check, forwarding. */
public final class Gateway {
  private Gateway() {}

  public static ResponseEntity<String> forward(String feature, Set<String> commands, UpstreamClient client,
      String id, String command, String body, HttpHeaders headers) {
    if (!commands.contains(command)) return json(404, UpstreamClient.detail("Unknown command " + command), null);
    // The service validates the token; the BFF never forwards an anonymous call.
    String authorization = headers.getFirst(HttpHeaders.AUTHORIZATION);
    if (authorization == null || !authorization.matches("(?i)^Bearer\\\\s+\\\\S+.*")) {
      return json(401, UpstreamClient.detail("Missing bearer token"), null);
    }
    Map<String, String> incoming = new java.util.HashMap<>();
    headers.forEach((name, values) -> { if (!values.isEmpty()) incoming.put(name.toLowerCase(java.util.Locale.ROOT), values.get(0)); });
    UpstreamClient.Forwarded answer = client.post("/api/v1/" + feature + "/" + java.net.URLEncoder.encode(id, java.nio.charset.StandardCharsets.UTF_8) + "/" + command, body, incoming);
    return json(answer.status(), answer.body(), answer.requestId());
  }

  private static ResponseEntity<String> json(int status, String body, String requestId) {
    ResponseEntity.BodyBuilder response = ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON);
    if (requestId != null) response.header("x-request-id", requestId);
    return response.body(body);
  }
}
`;
}

function renderController(pkg: string, m: DomainModel, upstream: string): string {
  return `package ${pkg}.api;

import ${pkg}.upstream.Gateway;
import ${pkg}.upstream.UpstreamClient;
import ${pkg}.upstream.Upstreams;
import java.util.Set;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** BFF route of the "${m.feature}" feature, forwarded to the "${upstream}" service (@upstream:<name>). */
@RestController
@RequestMapping("${bffRoute(m)}")
public class ${m.pascal}BffController {
  static final String UPSTREAM = "${upstream}";
  static final Set<String> COMMANDS = Set.of(${m.commands.map(c => `"${c.snake}"`).join(', ')});

  private final UpstreamClient upstream;

  public ${m.pascal}BffController(Upstreams upstreams) {
    this.upstream = upstreams.get(UPSTREAM);
  }

  @PostMapping("/{id}/{command}")
  public ResponseEntity<String> run(@PathVariable String id, @PathVariable String command,
      @RequestBody(required = false) String body, @RequestHeader HttpHeaders headers) {
    return Gateway.forward("${m.kebab}", COMMANDS, upstream, id, command, body, headers);
  }
}
`;
}

function renderHealth(pkg: string): string {
  return `package ${pkg}.api;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
  @GetMapping("/health")
  public Map<String, String> health() {
    return Map.of("status", "UP");
  }
}
`;
}

function renderControllerTest(pkg: string, m: DomainModel, upstream: string): string {
  const command = m.commands[0].snake;
  return `package ${pkg}.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ${pkg}.upstream.UpstreamClient;
import ${pkg}.upstream.Upstreams;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/** The "${m.feature}" BFF route against a stub upstream service. */
class ${m.pascal}BffControllerTest {
  private static final String PATH = "${bffRoute(m)}/agg-1/${command}";
  private HttpServer upstream;
  private final List<Map<String, String>> seen = new CopyOnWriteArrayList<>();

  private MockMvc mvc(int status, String body, long delayMs, Duration timeout) throws Exception {
    upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    upstream.createContext("/", exchange -> {
      String received = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      seen.add(Map.of("path", exchange.getRequestURI().getPath(), "body", received,
          "authorization", String.valueOf(exchange.getRequestHeaders().getFirst("authorization")),
          "traceparent", String.valueOf(exchange.getRequestHeaders().getFirst("traceparent")),
          "x-request-id", String.valueOf(exchange.getRequestHeaders().getFirst("x-request-id"))));
      try { Thread.sleep(delayMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
      byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().add("content-type", "application/json");
      exchange.sendResponseHeaders(status, bytes.length);
      exchange.getResponseBody().write(bytes);
      exchange.close();
    });
    upstream.start();
    String url = "http://127.0.0.1:" + upstream.getAddress().getPort();
    return MockMvcBuilders.standaloneSetup(new ${m.pascal}BffController(new Upstreams(Map.of("${upstream}", new UpstreamClient("${upstream}", url, timeout))))).build();
  }

  @AfterEach
  void stop() {
    if (upstream != null) upstream.stop(0);
  }

  @Test
  void forwardsTheCommandWithTheCallerIdentityAndTraceContext() throws Exception {
    MockMvc mvc = mvc(202, "{\\"aggregateId\\":\\"agg-1\\",\\"version\\":1}", 0, Duration.ofSeconds(5));
    mvc.perform(post(PATH).header("Authorization", "Bearer token-1")
            .header("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
            .contentType(MediaType.APPLICATION_JSON).content("{\\"source\\":\\"bff-test\\"}"))
        .andExpect(status().isAccepted())
        .andExpect(content().json("{\\"aggregateId\\":\\"agg-1\\",\\"version\\":1}"));
    assertThat(seen.get(0).get("path")).isEqualTo("${upstreamRoute(m)}/agg-1/${command}");
    assertThat(seen.get(0).get("authorization")).isEqualTo("Bearer token-1");
    assertThat(seen.get(0).get("traceparent")).isEqualTo("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    assertThat(seen.get(0).get("x-request-id")).isNotBlank();
    assertThat(seen.get(0).get("body")).isEqualTo("{\\"source\\":\\"bff-test\\"}");
  }

  @Test
  void refusesACallWithoutABearerTokenBeforeReachingTheService() throws Exception {
    mvc(202, "{}", 0, Duration.ofSeconds(5)).perform(post(PATH).contentType(MediaType.APPLICATION_JSON).content("{}"))
        .andExpect(status().isUnauthorized());
    assertThat(seen).isEmpty();
  }

  @Test
  void answers404ForACommandTheFeatureDoesNotDeclare() throws Exception {
    mvc(202, "{}", 0, Duration.ofSeconds(5)).perform(post("${bffRoute(m)}/agg-1/not_a_command").header("Authorization", "Bearer t"))
        .andExpect(status().isNotFound());
  }

  @Test
  void passesA4xxThrough() throws Exception {
    mvc(422, "{\\"detail\\":\\"Command id is required\\"}", 0, Duration.ofSeconds(5))
        .perform(post(PATH).header("Authorization", "Bearer t").contentType(MediaType.APPLICATION_JSON).content("{}"))
        .andExpect(status().is(422))
        .andExpect(content().json("{\\"detail\\":\\"Command id is required\\"}"));
  }

  @Test
  void turnsA5xxInto502WithoutItsInternals() throws Exception {
    String body = mvc(500, "{\\"stack\\":\\"internal\\"}", 0, Duration.ofSeconds(5))
        .perform(post(PATH).header("Authorization", "Bearer t").contentType(MediaType.APPLICATION_JSON).content("{}"))
        .andExpect(status().isBadGateway()).andReturn().getResponse().getContentAsString();
    assertThat(body).doesNotContain("internal");
  }

  @Test
  void answers504WhenTheServiceDoesNotAnswerInTime() throws Exception {
    mvc(202, "{}", 1500, Duration.ofMillis(200))
        .perform(post(PATH).header("Authorization", "Bearer t").contentType(MediaType.APPLICATION_JSON).content("{}"))
        .andExpect(status().isGatewayTimeout());
  }
}
`;
}

export function renderSpringBff(parsed: ParsedFeature, config: GherkinAIConfig): File[] {
  const m = buildDomainModel(parsed, { service: config.projectName });
  const pkg = jvmBasePackage(config);
  const upstream = featureUpstream(parsed, config).name;
  const main = `src/main/java/${javaPackagePath(pkg)}`;
  const test = `src/test/java/${javaPackagePath(pkg)}`;
  return [
    { filename: 'pom.xml', content: renderBffPom(toKebab(config.projectName || 'bff'), jvmGroupId(config)) },
    renderSpringApplication(pkg),
    { filename: `${main}/upstream/UpstreamClient.java`, content: renderUpstreamClient(pkg) },
    { filename: `${main}/upstream/Upstreams.java`, content: renderUpstreams(pkg, config) },
    { filename: `${main}/upstream/Gateway.java`, content: renderGateway(pkg) },
    { filename: `${main}/api/HealthController.java`, content: renderHealth(pkg) },
    { filename: `${main}/api/${m.pascal}BffController.java`, content: renderController(pkg, m, upstream) },
    { filename: `${test}/api/${m.pascal}BffControllerTest.java`, content: renderControllerTest(pkg, m, upstream) },
    { filename: 'src/main/resources/application.yml', content: 'server:\n  port: ${SERVER_PORT:8080}\nspring:\n  application:\n    name: ' + toKebab(config.projectName || 'bff') + '\n' }
  ];
}
