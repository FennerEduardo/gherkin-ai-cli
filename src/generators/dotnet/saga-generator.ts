export function generateSagaInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Patrón de Orquestación Saga / Saga Orchestration Pattern
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
    }

    public class PaymentSagaStateMachine : MassTransitStateMachine<PaymentSagaState>
    {
        public State Authorized { get; private set; } = null!;
        public State Completed { get; private set; } = null!;
        public State Failed { get; private set; } = null!;

        public Event<PaymentInitiatedEvent> PaymentInitiated { get; private set; } = null!;
        public Event<PaymentAuthorizedEvent> PaymentAuthorized { get; private set; } = null!;
        public Event<PaymentFailedEvent> PaymentFailed { get; private set; } = null!;

        public PaymentSagaStateMachine()
        {
            InstanceState(x => x.CurrentState);

            Event(() => PaymentInitiated, x => x.CorrelateById(m => m.Message.CorrelationId));
            Event(() => PaymentAuthorized, x => x.CorrelateById(m => m.Message.CorrelationId));
            Event(() => PaymentFailed, x => x.CorrelateById(m => m.Message.CorrelationId));

            Initially(
                When(PaymentInitiated)
                    .Then(context => {
                        context.Saga.PaymentId = context.Message.PaymentId;
                        context.Saga.Amount = context.Message.Amount;
                    })
                    .Publish(context => new AuthorizePaymentCommand { PaymentId = context.Saga.PaymentId })
                    .TransitionTo(Authorized)
            );

            During(Authorized,
                When(PaymentAuthorized)
                    .Publish(context => new CapturePaymentCommand { PaymentId = context.Saga.PaymentId })
                    .TransitionTo(Completed),
                When(PaymentFailed)
                    .Then(context => {
                        context.Saga.ErrorReason = context.Message.Reason;
                        // Ejecutar compensación / Execute compensation
                    })
                    .Publish(context => new CancelAuthorizationCommand { PaymentId = context.Saga.PaymentId })
                    .TransitionTo(Failed)
            );
        }
    }

    // Dummy events/commands for illustration
    public record PaymentInitiatedEvent(Guid CorrelationId, Guid PaymentId, decimal Amount);
    public record PaymentAuthorizedEvent(Guid CorrelationId);
    public record PaymentFailedEvent(Guid CorrelationId, string Reason);
    public record AuthorizePaymentCommand { public Guid PaymentId { get; init; } }
    public record CapturePaymentCommand { public Guid PaymentId { get; init; } }
    public record CancelAuthorizationCommand { public Guid PaymentId { get; init; } }
}
`;
}
