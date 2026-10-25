package com.lms.assessmentservice;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.GetResponse;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** End to end against PostgreSQL and RabbitMQ: context from events, grading over HTTP, GradePublished out, audit kept. */
@Tag("integration")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AssessmentIntegrationTest {
    private static final String SECRET = "integration-secret-with-at-least-32-bytes-123";

    @DynamicPropertySource
    static void infrastructure(DynamicPropertyRegistry registry) {
        URI db = URI.create(System.getenv("DATABASE_URL").replaceFirst("^postgres(ql)?://", "postgresql://"));
        String[] user = db.getUserInfo().split(":", 2);
        registry.add("spring.datasource.url", () -> "jdbc:postgresql://" + db.getHost() + ":" + db.getPort() + db.getPath());
        registry.add("spring.datasource.username", () -> user[0]);
        registry.add("spring.datasource.password", () -> user[1]);
        registry.add("lms.messaging.amqp-url", () -> System.getenv("AMQP_URL"));
        registry.add("lms.messaging.enabled", () -> "true");
        registry.add("lms.messaging.relay-interval-ms", () -> "100");
        registry.add("lms.messaging.inbox-interval-ms", () -> "100");
        registry.add("lms.telemetry.enabled", () -> "false");
        registry.add("lms.security.jwt-secret", () -> SECRET);
    }

    @Autowired TestRestTemplate http;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    @Test
    void gradingAndPublicationThroughTheBroker() throws Exception {
        String tenant = "it-" + UUID.randomUUID();
        String base = "/api/v1/institutions/" + tenant;
        var teacher = bearer(token("teacher-7", tenant, List.of("GRADE_WRITE", "GRADE_PUBLISH", "GRADE_READ")));
        var student = bearer(token("s-1", tenant, List.of("GRADE_READ_OWN")));

        try (var amqp = amqp(); Channel channel = amqp.createChannel()) {
            String probe = channel.queueDeclare().getQueue();
            for (String type : List.of("GradePublished", "GradeChanged")) channel.queueBind(probe, "assessment.events", type);

            publish(channel, "institution.events", "InstitutionConfigured", tenant,
                Map.of("institutionId", tenant, "gradingScale", "0-20", "gradingScaleMin", 0, "gradingScaleMax", 20, "timezone", "UTC"));
            publish(channel, "academic.events", "TeacherAssignedToCourse", tenant, Map.of("institutionId", tenant, "courseId", "c-1", "teacherId", "teacher-7"));
            publish(channel, "learning.events", "AssignmentSubmitted", tenant, Map.of("institutionId", tenant, "submissionId", "sub-1",
                "assignmentId", "asg-1", "assignmentTitle", "Limits worksheet", "courseId", "c-1", "studentId", "s-1", "teacherId", "teacher-7", "attempt", 1));
            eventually(() -> jdbc.queryForObject("SELECT count(*) FROM submitted_work WHERE institution_id = ?", Integer.class, tenant) == 1
                && jdbc.queryForObject("SELECT count(*) FROM grading_scales WHERE institution_id = ?", Integer.class, tenant) == 1
                && jdbc.queryForObject("SELECT count(*) FROM course_teachers WHERE institution_id = ?", Integer.class, tenant) == 1);

            // The institution's 0-20 scale applies.
            ResponseEntity<JsonNode> tooHigh = http.exchange(base + "/submissions/sub-1/grade", HttpMethod.PUT,
                new HttpEntity<>(Map.of("score", 87), teacher), JsonNode.class);
            assertThat(tooHigh.getBody().get("code").asText()).isEqualTo("SCORE_OUT_OF_RANGE");
            JsonNode draft = http.exchange(base + "/submissions/sub-1/grade", HttpMethod.PUT,
                new HttpEntity<>(Map.of("score", 17.5, "feedback", "Good"), teacher), JsonNode.class).getBody();
            assertThat(draft.get("status").asText()).isEqualTo("DRAFT");
            assertThat(get(base + "/students/s-1/grades", student)).as("drafts are not visible to the student").isEmpty();

            http.exchange(base + "/submissions/sub-1/grade/publication", HttpMethod.POST, new HttpEntity<>(teacher), JsonNode.class);
            JsonNode published = json.readTree(drain(channel, probe).getBody());
            assertThat(published.get("eventType").asText()).isEqualTo("GradePublished");
            assertThat(published.get("payload").get("score").asText()).isEqualTo("17.50");
            assertThat(published.get("payload").get("scaleMax").asInt()).isEqualTo(20);
            assertThat(get(base + "/students/s-1/grades", student)).hasSize(1);

            http.exchange(base + "/submissions/sub-1/grade/corrections", HttpMethod.POST,
                new HttpEntity<>(Map.of("score", 18, "reason", "Exercise 3 counted twice"), teacher), JsonNode.class);
            JsonNode changed = json.readTree(drain(channel, probe).getBody());
            assertThat(changed.get("eventType").asText()).isEqualTo("GradeChanged");
            assertThat(changed.get("payload").get("previousScore").asText()).isEqualTo("17.50");
            assertThat(jdbc.queryForList("SELECT action FROM audit_log WHERE tenant_id = ? ORDER BY id", String.class, tenant))
                .containsExactly("GRADE_PUBLISHED", "GRADE_CHANGED");

            var otherTeacher = bearer(token("teacher-8", tenant, List.of("GRADE_WRITE")));
            assertThat(http.exchange(base + "/submissions/sub-1/grade", HttpMethod.PUT, new HttpEntity<>(Map.of("score", 1), otherTeacher), JsonNode.class)
                .getStatusCode().value()).isEqualTo(403);
        }
    }

    @Test
    void exportsTheOpenApiContract() throws Exception {
        JsonNode api = json.readTree(http.getForEntity("/v3/api-docs", String.class).getBody());
        assertThat(api.get("paths").has("/api/v1/institutions/{institutionId}/students/{studentId}/grades")).isTrue();
        Files.writeString(Path.of("target", "openapi.json"), json.writerWithDefaultPrettyPrinter().writeValueAsString(api));
    }

    private JsonNode get(String url, HttpHeaders auth) {
        return http.exchange(url, HttpMethod.GET, new HttpEntity<>(auth), JsonNode.class).getBody();
    }

    private void publish(Channel channel, String exchange, String type, String tenant, Map<String, Object> payload) throws Exception {
        channel.exchangeDeclare(exchange, "topic", true);
        String eventId = UUID.randomUUID().toString();
        var envelope = Map.of("eventId", eventId, "eventType", type, "version", 1, "occurredAt", Instant.now().toString(),
            "correlationId", "it-assessment", "tenantId", tenant, "producer", "it", "payload", payload);
        var props = new AMQP.BasicProperties.Builder().messageId(eventId).type(type).contentType("application/json")
            .headers(Map.of("tenant_id", tenant)).build();
        channel.basicPublish(exchange, type, props, json.writeValueAsString(envelope).getBytes(StandardCharsets.UTF_8));
    }

    private static String token(String subject, String tenant, List<String> permissions) {
        var encoder = new NimbusJwtEncoder(new ImmutableSecret<>(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256")));
        var claims = JwtClaimsSet.builder().issuer("lms-identity").subject(subject).issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(300))
            .claim("tenant", tenant).claim("roles", List.of()).claim("permissions", permissions).build();
        return encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
    }

    private static HttpHeaders bearer(String token) {
        var headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private static com.rabbitmq.client.Connection amqp() throws Exception {
        var factory = new com.rabbitmq.client.ConnectionFactory();
        factory.setUri(System.getenv("AMQP_URL"));
        return factory.newConnection();
    }

    private static GetResponse drain(Channel channel, String queue) throws Exception {
        Instant deadline = Instant.now().plus(Duration.ofSeconds(20));
        while (Instant.now().isBefore(deadline)) {
            GetResponse response = channel.basicGet(queue, true);
            if (response != null) return response;
            Thread.sleep(100);
        }
        throw new AssertionError("no message on " + queue);
    }

    private static void eventually(BooleanSupplier condition) throws InterruptedException {
        Instant deadline = Instant.now().plus(Duration.ofSeconds(15));
        while (!condition.getAsBoolean()) {
            if (Instant.now().isAfter(deadline)) throw new AssertionError("condition not met within 15s");
            Thread.sleep(100);
        }
    }
}
