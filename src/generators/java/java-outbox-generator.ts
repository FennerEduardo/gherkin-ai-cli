// --------------------------------------------------------------------------
// Patrón Transactional Outbox para Java 21 / Spring Boot 3.2+
// --------------------------------------------------------------------------

export function generateJavaOutboxInfrastructure(packageName: string): string {
  return `package ${packageName}.infrastructure.outbox;

import jakarta.persistence.*;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.annotation.Transactional;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "outbox_messages", indexes = {
    @Index(name = "idx_outbox_status_occurred", columnList = "status, occurredOn")
})
public class OutboxMessage {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String eventType;

    @Lob
    @Column(nullable = false)
    private String payload;

    @Column(nullable = false)
    private Instant occurredOn = Instant.now();

    private Instant processedOn;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private OutboxStatus status = OutboxStatus.PENDING;

    private int retryCount = 0;

    private String error;

    public enum OutboxStatus { PENDING, PROCESSING, PUBLISHED, FAILED }

    public OutboxMessage() {}

    public OutboxMessage(String eventType, String payload) {
        this.eventType = eventType;
        this.payload = payload;
    }

    public UUID getId() { return id; }
    public String getEventType() { return eventType; }
    public String getPayload() { return payload; }
    public Instant getOccurredOn() { return occurredOn; }
    public Instant getProcessedOn() { return processedOn; }
    public OutboxStatus getStatus() { return status; }
    public int getRetryCount() { return retryCount; }
    public String getError() { return error; }

    public void markAsPublished() {
        this.status = OutboxStatus.PUBLISHED;
        this.processedOn = Instant.now();
    }

    public void markAsFailed(String error) {
        this.retryCount++;
        this.error = error;
        if (this.retryCount >= 5) {
            this.status = OutboxStatus.FAILED;
        } else {
            this.status = OutboxStatus.PENDING;
        }
    }
}

@Repository
interface OutboxRepository extends JpaRepository<OutboxMessage, UUID> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT o FROM OutboxMessage o WHERE o.status = 'PENDING' ORDER BY o.occurredOn ASC")
    List<OutboxMessage> findPendingForProcessing(org.springframework.data.domain.Pageable pageable);
}

@Service
public class OutboxService {

    private final OutboxRepository repository;
    private final ObjectMapper objectMapper;

    public OutboxService(OutboxRepository repository, ObjectMapper objectMapper) {
        this.repository = repository;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public <T> void saveMessage(T domainEvent) {
        try {
            String payload = objectMapper.writeValueAsString(domainEvent);
            OutboxMessage message = new OutboxMessage(domainEvent.getClass().getSimpleName(), payload);
            repository.save(message);
        } catch (Exception e) {
            throw new RuntimeException("Error serializando evento para Outbox", e);
        }
    }
}

@Service
public class OutboxPublisher {

    private final OutboxRepository repository;

    public OutboxPublisher(OutboxRepository repository) {
        this.repository = repository;
    }

    @Scheduled(fixedDelay = 5000)
    @Transactional
    public void processOutbox() {
        var page = org.springframework.data.domain.PageRequest.of(0, 50);
        List<OutboxMessage> pending = repository.findPendingForProcessing(page);

        for (OutboxMessage msg : pending) {
            try {
                // Publicación al broker de mensajería (Kafka, RabbitMQ, SQS)
                // EventBroker.publish(msg.getEventType(), msg.getPayload());
                msg.markAsPublished();
            } catch (Exception e) {
                msg.markAsFailed(e.getMessage());
            }
            repository.save(msg);
        }
    }
}
`;
}
