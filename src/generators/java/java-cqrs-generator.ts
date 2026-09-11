// --------------------------------------------------------------------------
// Arquitectura CQRS en Java 21 / Spring Boot 3
// --------------------------------------------------------------------------

export function generateJavaCQRSInfrastructure(packageName: string): string {
  return `package ${packageName}.application.cqrs;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.UUID;

public class PaymentCQRS {

    // Comandos y Consultas como Records inmutables (Java 21)
    public record CreatePaymentCommand(UUID tenantId, BigDecimal amount, String currency, String customerId) {}
    public record GetPaymentQuery(UUID paymentId) {}

    public record PaymentCreatedEvent(UUID paymentId, UUID tenantId, BigDecimal amount) {}
    public record PaymentDTO(UUID paymentId, String status, BigDecimal amount) {}

    // Bus de Comandos / Services desacoplados
    @Service
    public static class CreatePaymentCommandHandler {
        private final ApplicationEventPublisher eventPublisher;

        public CreatePaymentCommandHandler(ApplicationEventPublisher eventPublisher) {
            this.eventPublisher = eventPublisher;
        }

        @Transactional
        public UUID handle(CreatePaymentCommand command) {
            UUID paymentId = UUID.randomUUID();
            // 1. Guardar en Write Model (DB Dominio)
            
            // 2. Publicar Evento de Dominio
            eventPublisher.publishEvent(new PaymentCreatedEvent(paymentId, command.tenantId(), command.amount()));
            return paymentId;
        }
    }

    // Handlers de Consulta (Read Model)
    @Service
    public static class GetPaymentQueryHandler {
        @Transactional(readOnly = true)
        public PaymentDTO handle(GetPaymentQuery query) {
            // Lectura optimizada desde Read Model / Vista proyectada
            return new PaymentDTO(query.paymentId(), "PROCESSED", BigDecimal.valueOf(100.00));
        }
    }
}
`;
}
