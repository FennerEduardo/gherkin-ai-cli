// --------------------------------------------------------------------------
// Patrón de Idempotencia para Java 21 / Spring Boot 3
// --------------------------------------------------------------------------

export function generateJavaIdempotencyInfrastructure(packageName: string): string {
  return `package ${packageName}.infrastructure.idempotency;

import jakarta.persistence.*;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Repository;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

import java.io.IOException;
import java.time.Instant;
import java.util.Optional;

@Entity
@Table(name = "idempotency_keys", indexes = {
    @Index(name = "uk_idempotency_key", columnList = "idempotencyKey", unique = true)
})
public class IdempotencyKeyRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String idempotencyKey;

    @Column(nullable = false)
    private String requestPath;

    @Lob
    private String responseBody;

    private int responseStatus;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    public IdempotencyKeyRecord() {}

    public IdempotencyKeyRecord(String idempotencyKey, String requestPath) {
        this.idempotencyKey = idempotencyKey;
        this.requestPath = requestPath;
    }

    public String getIdempotencyKey() { return idempotencyKey; }
    public String getResponseBody() { return responseBody; }
    public int getResponseStatus() { return responseStatus; }

    public void setResponse(int status, String body) {
        this.responseStatus = status;
        this.responseBody = body;
    }
}

@Repository
interface IdempotencyKeyRepository extends JpaRepository<IdempotencyKeyRecord, Long> {
    Optional<IdempotencyKeyRecord> findByIdempotencyKey(String idempotencyKey);
}

@Component
public class IdempotencyFilter extends OncePerRequestFilter {

    private final IdempotencyKeyRepository repository;

    public IdempotencyFilter(IdempotencyKeyRepository repository) {
        this.repository = repository;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {

        String key = request.getHeader("X-Idempotency-Key");

        if (key == null || key.isBlank() || !request.getMethod().matches("POST|PUT|PATCH")) {
            filterChain.doFilter(request, response);
            return;
        }

        Optional<IdempotencyKeyRecord> existing = repository.findByIdempotencyKey(key);
        if (existing.isPresent()) {
            IdempotencyKeyRecord record = existing.get();
            response.setStatus(record.getResponseStatus());
            response.setContentType("application/json");
            response.getWriter().write(record.getResponseBody() != null ? record.getResponseBody() : "");
            return;
        }

        IdempotencyKeyRecord newRecord = new IdempotencyKeyRecord(key, request.getRequestURI());
        try {
            repository.save(newRecord);
        } catch (Exception e) {
            // Conflicto de concurrencia: petición repetida procesándose simultáneamente
            response.setStatus(409);
            response.getWriter().write("{\\"error\\": \\"Petición concurrente duplicada en proceso\\"}");
            return;
        }

        ContentCachingResponseWrapper responseWrapper = new ContentCachingResponseWrapper(response);
        filterChain.doFilter(request, responseWrapper);

        String responseBody = new String(responseWrapper.getContentAsByteArray(), responseWrapper.getCharacterEncoding());
        newRecord.setResponse(responseWrapper.getStatus(), responseBody);
        repository.save(newRecord);

        responseWrapper.copyBodyToResponse();
    }
}
`;
}
