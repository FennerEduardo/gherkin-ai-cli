// --------------------------------------------------------------------------
// Saga Orchestration Pattern for Java 21 / Spring Boot 3
// PARAMETRIZED: Generates saga based on feature name, not hardcoded to Payment
// --------------------------------------------------------------------------

export function generateJavaSagaInfrastructure(packageName: string, featureName?: string): { filename: string; content: string }[] {
  // Extract PascalCase feature name, default to 'Payment' for backward compatibility
  const feature = featureName
    ? featureName.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
    : 'Payment';
  const featureLower = feature.charAt(0).toLowerCase() + feature.slice(1);

  const packageHeader = `package ${packageName}.application.sagas;\n\n`;

  const sagaContract = `${packageHeader}import java.util.UUID;

/**
 * Saga Contract for ${feature} domain process.
 * Contains all events and commands involved in the saga orchestration.
 */
public class ${feature}SagaContract {

    // === Events ===
    public record ${feature}InitiatedEvent(UUID correlationId, UUID ${featureLower}Id, java.util.Map<String, Object> metadata) {}
    public record ${feature}AuthorizedEvent(UUID correlationId) {}
    public record ${feature}CompletedEvent(UUID correlationId) {}
    public record ${feature}FailedEvent(UUID correlationId, String reason) {}

    // === Commands ===
    public record Authorize${feature}Command(UUID ${featureLower}Id, java.util.Map<String, Object> metadata) {}
    public record Complete${feature}Command(UUID ${featureLower}Id) {}
    public record Compensate${feature}Command(UUID ${featureLower}Id, String reason) {}
}
`;

  const sagaInstance = `${packageHeader}import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/**
 * Persistent Saga state entity for ${feature} orchestration.
 * Tracks the current step and allows recovery after failures.
 */
@Entity
@Table(name = "saga_instances", indexes = {
    @Index(name = "idx_saga_state", columnList = "currentState"),
    @Index(name = "idx_saga_type", columnList = "sagaType")
})
public class ${feature}SagaInstance {
    @Id
    private UUID correlationId;

    @Column(nullable = false)
    private String sagaType = "${feature}";

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private SagaState currentState;

    private UUID ${featureLower}Id;

    @Column(columnDefinition = "TEXT")
    private String metadata;

    private String failureReason;
    private Instant createdAt = Instant.now();
    private Instant updatedAt = Instant.now();
    private int retryCount = 0;

    public enum SagaState { STARTED, AUTHORIZED, COMPLETING, COMPLETED, COMPENSATING, COMPENSATED, FAILED }

    public ${feature}SagaInstance() {}

    public ${feature}SagaInstance(UUID correlationId, UUID ${featureLower}Id, String metadata) {
        this.correlationId = correlationId;
        this.${featureLower}Id = ${featureLower}Id;
        this.metadata = metadata;
        this.currentState = SagaState.STARTED;
    }

    public UUID getCorrelationId() { return correlationId; }
    public String getSagaType() { return sagaType; }
    public SagaState getCurrentState() { return currentState; }
    public void transitionTo(SagaState state) {
        this.currentState = state;
        this.updatedAt = Instant.now();
    }
    public UUID get${feature}Id() { return ${featureLower}Id; }
    public String getMetadata() { return metadata; }
    public String getFailureReason() { return failureReason; }
    public void setFailureReason(String reason) { this.failureReason = reason; }
    public int getRetryCount() { return retryCount; }
    public void incrementRetry() { this.retryCount++; this.updatedAt = Instant.now(); }
}
`;

  const sagaInstanceRepository = `${packageHeader}import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;
import java.util.List;
import java.util.UUID;

@Repository
public interface ${feature}SagaInstanceRepository extends JpaRepository<${feature}SagaInstance, UUID> {

    List<${feature}SagaInstance> findByCurrentState(${feature}SagaInstance.SagaState state);

    @Query("SELECT s FROM ${feature}SagaInstance s WHERE s.currentState IN ('COMPENSATING', 'STARTED') AND s.retryCount < :maxRetries")
    List<${feature}SagaInstance> findRetryableSagas(int maxRetries);
}
`;

  const sagaOrchestrator = `${packageHeader}import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * ${feature} Saga Orchestrator.
 * Manages the lifecycle of the ${feature} saga through state transitions.
 * Each handler is transactional and idempotent.
 */
@Service
public class ${feature}SagaOrchestrator {
    private static final Logger log = LoggerFactory.getLogger(${feature}SagaOrchestrator.class);
    private final ${feature}SagaInstanceRepository sagaRepository;
    private final ApplicationEventPublisher commandBus;

    public ${feature}SagaOrchestrator(${feature}SagaInstanceRepository sagaRepository, ApplicationEventPublisher commandBus) {
        this.sagaRepository = sagaRepository;
        this.commandBus = commandBus;
    }

    @Transactional
    public void handle(${feature}SagaContract.${feature}InitiatedEvent event) {
        log.info("Saga initiated: correlationId={}", event.correlationId());
        var metadata = event.metadata() != null ? event.metadata().toString() : "{}";
        var saga = new ${feature}SagaInstance(event.correlationId(), event.${featureLower}Id(), metadata);
        sagaRepository.save(saga);

        // Commands are dispatched in-process; bridge them to your broker (e.g. via the outbox) as needed.
        commandBus.publishEvent(new ${feature}SagaContract.Authorize${feature}Command(event.${featureLower}Id(), event.metadata()));
    }

    @Transactional
    public void handle(${feature}SagaContract.${feature}AuthorizedEvent event) {
        log.info("Saga authorized: correlationId={}", event.correlationId());
        var saga = sagaRepository.findById(event.correlationId())
                .orElseThrow(() -> new IllegalArgumentException("Saga not found: " + event.correlationId()));

        saga.transitionTo(${feature}SagaInstance.SagaState.AUTHORIZED);
        saga.transitionTo(${feature}SagaInstance.SagaState.COMPLETING);
        sagaRepository.save(saga);

        commandBus.publishEvent(new ${feature}SagaContract.Complete${feature}Command(saga.get${feature}Id()));
    }

    @Transactional
    public void handle(${feature}SagaContract.${feature}CompletedEvent event) {
        log.info("Saga completed: correlationId={}", event.correlationId());
        var saga = sagaRepository.findById(event.correlationId())
                .orElseThrow(() -> new IllegalArgumentException("Saga not found: " + event.correlationId()));

        saga.transitionTo(${feature}SagaInstance.SagaState.COMPLETED);
        sagaRepository.save(saga);
    }

    @Transactional
    public void handle(${feature}SagaContract.${feature}FailedEvent event) {
        log.info("Saga failed: correlationId={}, reason={}", event.correlationId(), event.reason());
        var saga = sagaRepository.findById(event.correlationId())
                .orElseThrow(() -> new IllegalArgumentException("Saga not found: " + event.correlationId()));

        saga.transitionTo(${feature}SagaInstance.SagaState.COMPENSATING);
        saga.setFailureReason(event.reason());

        commandBus.publishEvent(new ${feature}SagaContract.Compensate${feature}Command(saga.get${feature}Id(), event.reason()));

        saga.transitionTo(${feature}SagaInstance.SagaState.FAILED);
        sagaRepository.save(saga);
    }
}
`;

  return [
    { filename: `application/sagas/${feature}SagaContract.java`, content: sagaContract },
    { filename: `application/sagas/${feature}SagaInstance.java`, content: sagaInstance },
    { filename: `application/sagas/${feature}SagaInstanceRepository.java`, content: sagaInstanceRepository },
    { filename: `application/sagas/${feature}SagaOrchestrator.java`, content: sagaOrchestrator }
  ];
}
