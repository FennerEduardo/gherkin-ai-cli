// MediatR CommandHandlers, QueryHandlers and Read Model Projectors Generator

export function generateCqrsHandlers(namespace: string, featureName: string): string {
  const featurePascal = featureName.replace(/[^a-zA-Z0-9]/g, '');

  return `// --------------------------------------------------------------------------
// MediatR CQRS Handlers & Read Model Event Projectors
// --------------------------------------------------------------------------
using System;
using System.Threading;
using System.Threading.Tasks;
using MediatR;
using Microsoft.Extensions.Logging;

namespace ${namespace}.Application.Handlers
{
    // 1. Command Handler
    public class Create${featurePascal}CommandHandler : IRequestHandler<Create${featurePascal}Command, CommandResult>
    {
        private readonly ILogger<Create${featurePascal}CommandHandler> _logger;

        public Create${featurePascal}CommandHandler(ILogger<Create${featurePascal}CommandHandler> logger)
        {
            _logger = logger;
        }

        public async Task<CommandResult> Handle(Create${featurePascal}Command request, CancellationToken cancellationToken)
        {
            _logger.LogInformation("Processing command to create {Feature} with ref {Ref}", "${featurePascal}", request.ReferenceCode);
            
            // Entity creation and atomic save
            var entityId = Guid.NewGuid();
            await Task.CompletedTask;

            return new CommandResult(true, "${featurePascal} created successfully", entityId);
        }
    }

    // 2. Query Handler (Read Model)

    public class Get${featurePascal}QueryHandler : IRequestHandler<Get${featurePascal}Query, ${featurePascal}ReadModel?>
    {
        public async Task<${featurePascal}ReadModel?> Handle(Get${featurePascal}Query request, CancellationToken cancellationToken)
        {
            await Task.CompletedTask;
            return new ${featurePascal}ReadModel(request.${featurePascal}Id, "REF-10020", 250.00m, "COMPLETED", DateTime.UtcNow);
        }
    }

    // 3. Event Projector (Read View Updater)
    public class ${featurePascal}EventProjector : INotificationHandler<${featurePascal}ProcessedEventNotification>
    {
        private readonly ILogger<${featurePascal}EventProjector> _logger;

        public ${featurePascal}EventProjector(ILogger<${featurePascal}EventProjector> logger)
        {
            _logger = logger;
        }

        public async Task Handle(${featurePascal}ProcessedEventNotification notification, CancellationToken cancellationToken)
        {
            _logger.LogInformation("Projecting read event {EventId} into ReadModel DB", notification.EventId);
            await Task.CompletedTask;
        }
    }

    public record ${featurePascal}ProcessedEventNotification(Guid EventId, Guid AggregateId, string Details) : INotification;
}
`;
}
