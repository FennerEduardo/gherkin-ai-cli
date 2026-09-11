export function generateSagaInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Patrón de Orquestación Saga / Saga Orchestration Pattern (.NET 8/9)
// --------------------------------------------------------------------------
using System;
using System.Threading.Tasks;
using MassTransit;

namespace ${namespace}.Application.Sagas
{
    public class PaymentSagaState : SagaStateMachineInstance
    {
        public Guid CorrelationId { get; set; }
        public string CurrentState { get; set; } = string.Empty;
        public Guid PaymentId { get; set; }
        public decimal Amount { get; set; }
        public string ErrorReason { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
        public DateTime? TimeoutDeadline { get; set; }
    }

    public class PaymentSagaStateMachine : MassTransitStateMachine<PaymentSagaState>
    {
        public State Authorized { get; private set; } = null!;
        public State Completed { get; private set; } = null!;
        public State Compensating { get; private set; } = null!;
        public State Failed { get; private set; } = null!;

        public Event<PaymentInitiatedEvent> PaymentInitiated { get; private set; } = null!;
        public Event<PaymentAuthorizedEvent> PaymentAuthorized { get; private set; } = null!;
        public Event<PaymentFailedEvent> PaymentFailed { get; private set; } = null!;
        public Event<SagaTimeoutExpiredEvent> TimeoutExpired { get; private set; } = null!;

        public PaymentSagaStateMachine()
        {
            InstanceState(x => x.CurrentState);

            Event(() => PaymentInitiated, x => x.CorrelateById(m => m.Message.CorrelationId));
            Event(() => PaymentAuthorized, x => x.CorrelateById(m => m.Message.CorrelationId));
            Event(() => PaymentFailed, x => x.CorrelateById(m => m.Message.CorrelationId));
            Event(() => TimeoutExpired, x => x.CorrelateById(m => m.Message.CorrelationId));

            Initially(
                When(PaymentInitiated)
                    .Then(context => {
                        context.Saga.PaymentId = context.Message.PaymentId;
                        context.Saga.Amount = context.Message.Amount;
                        context.Saga.CreatedAt = DateTime.UtcNow;
                        context.Saga.TimeoutDeadline = DateTime.UtcNow.AddMinutes(5);
                    })
                    .Publish(context => new AuthorizePaymentCommand { PaymentId = context.Saga.PaymentId, Amount = context.Saga.Amount })
                    .TransitionTo(Authorized)
            );

            During(Authorized,
                When(PaymentAuthorized)
                    .Publish(context => new CapturePaymentCommand { PaymentId = context.Saga.PaymentId })
                    .Then(context => context.Saga.UpdatedAt = DateTime.UtcNow)
                    .TransitionTo(Completed),
                When(PaymentFailed)
                    .TransitionTo(Compensating)
                    .Then(context => {
                        context.Saga.ErrorReason = context.Message.Reason;
                    })
                    .Publish(context => new CancelAuthorizationCommand { PaymentId = context.Saga.PaymentId, Reason = context.Message.Reason })
                    .TransitionTo(Failed),
                When(TimeoutExpired)
                    .TransitionTo(Compensating)
                    .Then(context => {
                        context.Saga.ErrorReason = "Saga timeout alcanzado sin autorización.";
                    })
                    .Publish(context => new CancelAuthorizationCommand { PaymentId = context.Saga.PaymentId, Reason = "Timeout" })
                    .TransitionTo(Failed)
            );
        }
    }

    public record PaymentInitiatedEvent(Guid CorrelationId, Guid PaymentId, decimal Amount);
    public record PaymentAuthorizedEvent(Guid CorrelationId);
    public record PaymentFailedEvent(Guid CorrelationId, string Reason);
    public record SagaTimeoutExpiredEvent(Guid CorrelationId);
    public record AuthorizePaymentCommand { public Guid PaymentId { get; init; } public decimal Amount { get; init; } }
    public record CapturePaymentCommand { public Guid PaymentId { get; init; } }
    public record CancelAuthorizationCommand { public Guid PaymentId { get; init; } public string Reason { get; init; } = string.Empty; }
}
`;
}
