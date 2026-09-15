// --------------------------------------------------------------------------
// CQRS Architecture for Java 21 / Spring Boot 3
// --------------------------------------------------------------------------

export function generateJavaCQRSInfrastructure(packageName: string): string {
  return `package ${packageName}.application.cqrs;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.UUID;

public class PaymentCQRS {

    // Commands and Queries as immutable Records (Java 21)
    public record CreatePaymentCommand(UUID tenantId, BigDecimal amount, String currency, String customerId) {}
    public record GetPaymentQuery(UUID paymentId) {}

    public record PaymentCreatedEvent(UUID paymentId, UUID tenantId, BigDecimal amount) {}
    public record PaymentDTO(UUID paymentId, String status, BigDecimal amount) {}

    // Decoupled Command Bus / Services
    @Service
    public static class CreatePaymentCommandHandler {
        private final ApplicationEventPublisher eventPublisher;

        public CreatePaymentCommandHandler(ApplicationEventPublisher eventPublisher) {
            this.eventPublisher = eventPublisher;
        }

        @Transactional
        public UUID handle(CreatePaymentCommand command) {
            UUID paymentId = UUID.randomUUID();
            // 1. Save to Write Model (Domain DB)
            
            // 2. Publish Domain Event
            eventPublisher.publishEvent(new PaymentCreatedEvent(paymentId, command.tenantId(), command.amount()));
            return paymentId;
        }
    }

    // Query Handlers (Read Model)
    @Service
    public static class GetPaymentQueryHandler {
        @Transactional(readOnly = true)
        public PaymentDTO handle(GetPaymentQuery query) {
            // Optimized read from Read Model / Projected View
            return new PaymentDTO(query.paymentId(), "PROCESSED", BigDecimal.valueOf(100.00));
        }
    }
}
`;
}
