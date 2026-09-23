export function generateSagaInfrastructure(namespace: string, featureName?: string): string {
  const feature = featureName
    ? featureName.replace(/[^a-zA-Z0-9]/g, '')
    : 'Payment';
  const entityId = feature + 'Id';

  return `// --------------------------------------------------------------------------
// Saga Orchestration Pattern (.NET 8/9)
// --------------------------------------------------------------------------
using System;
using System.Threading.Tasks;
using MassTransit;

namespace ${namespace}.Application.Sagas
{
    public class ${feature}SagaState : SagaStateMachineInstance
    {
        public Guid CorrelationId { get; set; }
        public string CurrentState { get; set; } = string.Empty;
        public Guid ${entityId} { get; set; }
        public string ErrorReason { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
        public DateTime? TimeoutDeadline { get; set; }
    }

    public class ${feature}SagaStateMachine : MassTransitStateMachine<${feature}SagaState>
    {
        public State Authorized { get; private set; } = null!;
        public State Completed { get; private set; } = null!;
        public State Compensating { get; private set; } = null!;
        public State Failed { get; private set; } = null!;

        public Event<${feature}InitiatedEvent> ${feature}Initiated { get; private set; } = null!;
        public Event<${feature}AuthorizedEvent> ${feature}Authorized { get; private set; } = null!;
        public Event<${feature}FailedEvent> ${feature}Failed { get; private set; } = null!;
        public Event<SagaTimeoutExpiredEvent> TimeoutExpired { get; private set; } = null!;

        public ${feature}SagaStateMachine()
        {
            InstanceState(x => x.CurrentState);

            Event(() => ${feature}Initiated, x => x.CorrelateById(m => m.Message.CorrelationId));
            Event(() => ${feature}Authorized, x => x.CorrelateById(m => m.Message.CorrelationId));
            Event(() => ${feature}Failed, x => x.CorrelateById(m => m.Message.CorrelationId));
            Event(() => TimeoutExpired, x => x.CorrelateById(m => m.Message.CorrelationId));

            Initially(
                When(${feature}Initiated)
                    .Then(context => {
                        context.Saga.${entityId} = context.Message.${entityId};
                        context.Saga.CreatedAt = DateTime.UtcNow;
                        context.Saga.TimeoutDeadline = DateTime.UtcNow.AddMinutes(5);
                    })
                    .Publish(context => new Authorize${feature}Command { ${entityId} = context.Saga.${entityId} })
                    .TransitionTo(Authorized)
            );

            During(Authorized,
                When(${feature}Authorized)
                    .Publish(context => new Complete${feature}Command { ${entityId} = context.Saga.${entityId} })
                    .Then(context => context.Saga.UpdatedAt = DateTime.UtcNow)
                    .TransitionTo(Completed),
                When(${feature}Failed)
                    .TransitionTo(Compensating)
                    .Then(context => {
                        context.Saga.ErrorReason = context.Message.Reason;
                    })
                    .Publish(context => new Compensate${feature}Command { ${entityId} = context.Saga.${entityId}, Reason = context.Message.Reason })
                    .TransitionTo(Failed),
                When(TimeoutExpired)
                    .TransitionTo(Compensating)
                    .Then(context => {
                        context.Saga.ErrorReason = "Saga timeout reached without authorization.";
                    })
                    .Publish(context => new Compensate${feature}Command { ${entityId} = context.Saga.${entityId}, Reason = "Timeout" })
                    .TransitionTo(Failed)
            );
        }
    }

    public record ${feature}InitiatedEvent(Guid CorrelationId, Guid ${entityId});
    public record ${feature}AuthorizedEvent(Guid CorrelationId);
    public record ${feature}FailedEvent(Guid CorrelationId, string Reason);
    public record SagaTimeoutExpiredEvent(Guid CorrelationId);
    public record Authorize${feature}Command { public Guid ${entityId} { get; init; } }
    public record Complete${feature}Command { public Guid ${entityId} { get; init; } }
    public record Compensate${feature}Command { public Guid ${entityId} { get; init; } public string Reason { get; init; } = string.Empty; }
}
`;
}
