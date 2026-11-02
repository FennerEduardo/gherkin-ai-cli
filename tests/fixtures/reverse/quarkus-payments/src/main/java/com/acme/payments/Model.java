package com.acme.payments;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;
import java.util.Optional;

enum PaymentStatus { PENDING, SETTLED }

record InitiatePaymentRequest(@NotBlank String reference, @Positive BigDecimal amount) {}

class Payment {
    String reference; BigDecimal amount; PaymentStatus status;
    Payment(String reference, BigDecimal amount, PaymentStatus status) { this.reference = reference; this.amount = amount; this.status = status; }
    String id() { return reference; }
}

class PaymentStateException extends RuntimeException {
    PaymentStateException(String message) { super(message); }
}

interface PaymentRepository {
    boolean existsByReference(String reference);
    void persist(Payment payment);
    Optional<Payment> findByIdOptional(String id);
}
