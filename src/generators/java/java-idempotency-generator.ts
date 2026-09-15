// --------------------------------------------------------------------------
// Idempotency Pattern for Java 21 / Spring Boot 3
// --------------------------------------------------------------------------

export function generateJavaIdempotencyInfrastructure(packageName: string): { filename: string; content: string }[] {
  const packageHeader = `package ${packageName}.infrastructure.idempotency;\n\n`;

  const idempotencyKeyRecord = `${packageHeader}import jakarta.persistence.*;
import java.time.Instant;

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
`;

  const idempotencyKeyRepository = `${packageHeader}import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.Optional;

@Repository
public interface IdempotencyKeyRepository extends JpaRepository<IdempotencyKeyRecord, Long> {
    Optional<IdempotencyKeyRecord> findByIdempotencyKey(String idempotencyKey);
}
`;

  const idempotencyFilter = `${packageHeader}import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;
import java.io.IOException;
import java.util.Optional;

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
            // Concurrency conflict: duplicate request being processed simultaneously
            response.setStatus(409);
            response.getWriter().write("{\\"error\\": \\"Duplicate concurrent request in progress\\"}");
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

  return [
    { filename: 'infrastructure/idempotency/IdempotencyKeyRecord.java', content: idempotencyKeyRecord },
    { filename: 'infrastructure/idempotency/IdempotencyKeyRepository.java', content: idempotencyKeyRepository },
    { filename: 'infrastructure/idempotency/IdempotencyFilter.java', content: idempotencyFilter }
  ];
}
