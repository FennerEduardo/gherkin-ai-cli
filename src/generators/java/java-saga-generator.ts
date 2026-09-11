// --------------------------------------------------------------------------
// Patrón de Orquestación Saga / Saga Orchestration Pattern en Java 21 / Spring Boot 3
// --------------------------------------------------------------------------

export function generateJavaSagaInfrastructure(packageName: string): string {
  return `package ${packageName}.application.sagas;

import jakarta.persistence.*;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

// Records de Eventos y Comandos (Java 21)
public class PaymentSagaContract {
    public record PaymentInitiatedEvent(UUID correlationId, UUID paymentId, BigDecimal amount) {}
    public record PaymentAuthorizedEvent(UUID correlationId) {}
    public record PaymentFailedEvent(UUID correlationId, String reason) {}

    public record AuthorizePaymentCommand(UUID paymentId, BigDecimal amount) {}
    public record CapturePaymentCommand(UUID paymentId) {}
    public record CancelAuthorizationCommand(UUID paymentId, String reason) {}
}

@Entity
@Table(name = "saga_instances")
public class SagaInstance {

    @Id
    private UUID correlationId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private SagaState currentState;

    private UUID paymentId;
    private BigDecimal amount;
    private String failureReason;
    private Instant createdAt = Instant.now();
    private Instant updatedAt = Instant.now();

    public enum SagaState { STARTED, AUTHORIZED, COMPLETED, COMPENSATING, FAILED }

    public SagaInstance() {}

    public SagaInstance(UUID correlationId, UUID paymentId, BigDecimal amount) {
        this.correlationId = correlationId;
        this.paymentId = paymentId;
        this.amount = amount;
        this.currentState = SagaState.STARTED;
    }

    public UUID getCorrelationId() { return correlationId; }
    public SagaState getCurrentState() { return currentState; }
    public void setCurrentState(SagaState state) { 
        this.currentState = state; 
        this.updatedAt = Instant.now();
    }
    public UUID getPaymentId() { return paymentId; }
    public BigDecimal getAmount() { return amount; }
    public String getFailureReason() { return failureReason; }
    public void setFailureReason(String reason) { this.failureReason = reason; }
}

@Repository
interface SagaInstanceRepository extends JpaRepository<SagaInstance, UUID> {}

@Service
public class PaymentSagaOrchestrator {

    private final SagaInstanceRepository sagaRepository;

    public PaymentSagaOrchestrator(SagaInstanceRepository sagaRepository) {
        this.sagaRepository = sagaRepository;
    }

    @Transactional
    public void handle(PaymentSagaContract.PaymentInitiatedEvent event) {
        SagaInstance saga = new SagaInstance(event.correlationId(), event.paymentId(), event.amount());
        sagaRepository.save(saga);

        // Disparar Comando de Autorización
        // dispatch(new PaymentSagaContract.AuthorizePaymentCommand(saga.getPaymentId(), saga.getAmount()));
    }

    @Transactional
    public void handle(PaymentSagaContract.PaymentAuthorizedEvent event) {
        SagaInstance saga = sagaRepository.findById(event.correlationId())
                .orElseThrow(() -> new IllegalArgumentException("Saga no encontrada: " + event.correlationId()));

        saga.setCurrentState(SagaInstance.SagaState.AUTHORIZED);

        // Disparar Captura
        // dispatch(new PaymentSagaContract.CapturePaymentCommand(saga.getPaymentId()));
        saga.setCurrentState(SagaInstance.SagaState.COMPLETED);
        sagaRepository.save(saga);
    }

    @Transactional
    public void handle(PaymentSagaContract.PaymentFailedEvent event) {
        SagaInstance saga = sagaRepository.findById(event.correlationId())
                .orElseThrow(() -> new IllegalArgumentException("Saga no encontrada: " + event.correlationId()));

        saga.setCurrentState(SagaInstance.SagaState.COMPENSATING);
        saga.setFailureReason(event.reason());

        // Ejecutar Acción Compensatoria (Cancelar Autorización)
        // dispatch(new PaymentSagaContract.CancelAuthorizationCommand(saga.getPaymentId(), event.reason()));

        saga.setCurrentState(SagaInstance.SagaState.FAILED);
        sagaRepository.save(saga);
    }
}
`;
}
