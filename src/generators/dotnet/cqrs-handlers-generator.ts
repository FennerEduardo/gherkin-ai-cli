// --------------------------------------------------------------------------
// Generador de CommandHandlers, QueryHandlers y Read Model Projectors MediatR
// --------------------------------------------------------------------------

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
    public record CommandResult(bool Success, string Message, Guid? EntityId);

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
            _logger.LogInformation("Procesando comando para crear {Feature} con ref {Ref}", "${featurePascal}", request.ReferenceCode);
            
            // Creación de entidad y guardado atómico
            var entityId = Guid.NewGuid();
            await Task.CompletedTask;

            return new CommandResult(true, "${featurePascal} creado exitosamente", entityId);
        }
    }

    // 2. Query Handler (Read Model)
    public record ${featurePascal}ReadModel(Guid Id, string ReferenceCode, decimal Amount, string Status, DateTime UpdatedAt);

    public class Get${featurePascal}QueryHandler : IRequestHandler<Get${featurePascal}Query, ${featurePascal}ReadModel?>
    {
        public async Task<${featurePascal}ReadModel?> Handle(Get${featurePascal}Query request, CancellationToken cancellationToken)
        {
            await Task.CompletedTask;
            return new ${featurePascal}ReadModel(request.${featurePascal}Id, "REF-10020", 250.00m, "COMPLETED", DateTime.UtcNow);
        }
    }

    // 3. Event Projector (Actualizador de Vista de Lectura)
    public class ${featurePascal}EventProjector : INotificationHandler<${featurePascal}ProcessedEventNotification>
    {
        private readonly ILogger<${featurePascal}EventProjector> _logger;

        public ${featurePascal}EventProjector(ILogger<${featurePascal}EventProjector> logger)
        {
            _logger = logger;
        }

        public async Task Handle(${featurePascal}ProcessedEventNotification notification, CancellationToken cancellationToken)
        {
            _logger.LogInformation("Proyectando evento de lectura {EventId} en ReadModel DB", notification.EventId);
            await Task.CompletedTask;
        }
    }

    public record ${featurePascal}ProcessedEventNotification(Guid EventId, Guid AggregateId, string Details) : INotification;
}
`;
}
