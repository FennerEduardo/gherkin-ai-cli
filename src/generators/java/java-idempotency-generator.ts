// --------------------------------------------------------------------------
// Idempotency Pattern for Java 21 / Spring Boot 3
// WITH TTL AND BACKGROUND CLEANUP
// --------------------------------------------------------------------------

export function generateJavaIdempotencyInfrastructure(packageName: string): { filename: string; content: string }[] {
  const packageHeader = `package ${packageName}.infrastructure.idempotency;\n\n`;

  const idempotencyKeyRecord = `${packageHeader}import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "idempotency_keys", indexes = {
    @Index(name = "uk_idempotency_key", columnList = "idempotencyKey", unique = true),
    @Index(name = "idx_idemp_status_created", columnList = "status, createdAt")
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

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private IdempotencyStatus status = IdempotencyStatus.PROCESSING;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    @Column(nullable = false)
    private Instant updatedAt = Instant.now();

    public enum IdempotencyStatus { PROCESSING, COMPLETED, FAILED }

    public IdempotencyKeyRecord() {}

    public IdempotencyKeyRecord(String idempotencyKey, String requestPath) {
        this.idempotencyKey = idempotencyKey;
        this.requestPath = requestPath;
    }

    public String getIdempotencyKey() { return idempotencyKey; }
    public String getResponseBody() { return responseBody; }
    public int getResponseStatus() { return responseStatus; }
    public IdempotencyStatus getStatus() { return status; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void setResponse(int status, String body, IdempotencyStatus state) {
        this.responseStatus = status;
        this.responseBody = body;
        this.status = state;
        this.updatedAt = Instant.now();
    }
    
    public void markProcessing() {
        this.status = IdempotencyStatus.PROCESSING;
        this.updatedAt = Instant.now();
    }
}
`;

  const idempotencyKeyRepository = `${packageHeader}import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;
import java.time.Instant;
import java.util.Optional;

@Repository
public interface IdempotencyKeyRepository extends JpaRepository<IdempotencyKeyRecord, Long> {
    Optional<IdempotencyKeyRecord> findByIdempotencyKey(String idempotencyKey);

    @Modifying
    @Query("DELETE FROM IdempotencyKeyRecord r WHERE r.createdAt < :cutoff")
    int deleteOlderThan(Instant cutoff);
}
`;

  const idempotencyFilter = `${packageHeader}import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;
import java.io.IOException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;

@Component
public class IdempotencyFilter extends OncePerRequestFilter {
    private static final Logger log = LoggerFactory.getLogger(IdempotencyFilter.class);
    private final IdempotencyKeyRepository repository;
    private static final int PROCESSING_TTL_MINUTES = 2;

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

        Optional<IdempotencyKeyRecord> existingOpt = repository.findByIdempotencyKey(key);
        if (existingOpt.isPresent()) {
            IdempotencyKeyRecord existing = existingOpt.get();
            
            if (existing.getStatus() == IdempotencyKeyRecord.IdempotencyStatus.COMPLETED) {
                response.setStatus(existing.getResponseStatus());
                response.setContentType("application/json");
                response.getWriter().write(existing.getResponseBody() != null ? existing.getResponseBody() : "");
                return;
            }
            
            if (existing.getStatus() == IdempotencyKeyRecord.IdempotencyStatus.PROCESSING) {
                long ageMinutes = ChronoUnit.MINUTES.between(existing.getUpdatedAt(), Instant.now());
                if (ageMinutes < PROCESSING_TTL_MINUTES) {
                    response.setStatus(409); // Conflict
                    response.getWriter().write("{\\"error\\": \\"Request already in progress. Retry after a moment.\\"}");
                    return;
                } else {
                    log.warn("Idempotency key {} stuck in PROCESSING for {} mins. Allowing retry.", key, ageMinutes);
                    existing.markProcessing();
                    repository.save(existing);
                    // Proceed to process the retry
                }
            }
        }

        IdempotencyKeyRecord recordToUpdate;
        if (existingOpt.isEmpty()) {
            try {
                recordToUpdate = new IdempotencyKeyRecord(key, request.getRequestURI());
                repository.save(recordToUpdate);
            } catch (Exception e) {
                // Concurrency conflict: another thread inserted the key just now
                response.setStatus(409);
                response.getWriter().write("{\\"error\\": \\"Duplicate concurrent request in progress\\"}");
                return;
            }
        } else {
            recordToUpdate = existingOpt.get();
        }

        ContentCachingResponseWrapper responseWrapper = new ContentCachingResponseWrapper(response);
        try {
            filterChain.doFilter(request, responseWrapper);
            
            String responseBody = new String(responseWrapper.getContentAsByteArray(), responseWrapper.getCharacterEncoding());
            recordToUpdate.setResponse(responseWrapper.getStatus(), responseBody, IdempotencyKeyRecord.IdempotencyStatus.COMPLETED);
            repository.save(recordToUpdate);
        } catch (Exception e) {
            recordToUpdate.setResponse(500, "{\\"error\\":\\"" + e.getMessage() + "\\"}", IdempotencyKeyRecord.IdempotencyStatus.FAILED);
            repository.save(recordToUpdate);
            throw e;
        }

        responseWrapper.copyBodyToResponse();
    }
}
`;

  const idempotencyCleanupService = `${packageHeader}import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

@Service
public class IdempotencyCleanupService {
    private static final Logger log = LoggerFactory.getLogger(IdempotencyCleanupService.class);
    private final IdempotencyKeyRepository repository;

    public IdempotencyCleanupService(IdempotencyKeyRepository repository) {
        this.repository = repository;
    }

    @Scheduled(fixedRate = 3600000) // Run every hour
    @Transactional
    public void cleanupExpiredKeys() {
        // Keep keys for 24 hours
        Instant cutoff = Instant.now().minus(24, ChronoUnit.HOURS);
        int deleted = repository.deleteOlderThan(cutoff);
        if (deleted > 0) {
            log.info("Cleaned up {} expired idempotency records.", deleted);
        }
    }
}
`;

  return [
    { filename: 'infrastructure/idempotency/IdempotencyKeyRecord.java', content: idempotencyKeyRecord },
    { filename: 'infrastructure/idempotency/IdempotencyKeyRepository.java', content: idempotencyKeyRepository },
    { filename: 'infrastructure/idempotency/IdempotencyFilter.java', content: idempotencyFilter },
    { filename: 'infrastructure/idempotency/IdempotencyCleanupService.java', content: idempotencyCleanupService }
  ];
}
