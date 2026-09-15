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
using ${namespace}.Infrastructure.Data;

namespace ${namespace}.Application.Handlers
{
    // 1. Command Handler
    public class Create${featurePascal}CommandHandler : IRequestHandler<Create${featurePascal}Command, CommandResult>
    {
        private readonly ILogger<Create${featurePascal}CommandHandler> _logger;
        private readonly ApplicationDbContext _dbContext;

        public Create${featurePascal}CommandHandler(ILogger<Create${featurePascal}CommandHandler> logger, ApplicationDbContext dbContext)
        {
            _logger = logger;
            _dbContext = dbContext;
        }

        public async Task<CommandResult> Handle(Create${featurePascal}Command request, CancellationToken cancellationToken)
        {
            _logger.LogInformation("Processing command to create {Feature} with ref {Ref}", "${featurePascal}", request.ReferenceCode);
            
            // Scaffold: Replace with actual domain logic
            var entityId = Guid.NewGuid();
            
            // Atomic save through DbContext (enables Outbox pattern)
            // _dbContext.${featurePascal}s.Add(newEntity);
            // await _dbContext.SaveChangesAsync(cancellationToken);

            return new CommandResult(true, "${featurePascal} created successfully (Scaffold)", entityId);
        }
    }

    // 2. Query Handler (Read Model)

    public class Get${featurePascal}QueryHandler : IRequestHandler<Get${featurePascal}Query, ${featurePascal}ReadModel?>
    {
        private readonly ApplicationDbContext _dbContext;

        public Get${featurePascal}QueryHandler(ApplicationDbContext dbContext)
        {
            _dbContext = dbContext;
        }

        public async Task<${featurePascal}ReadModel?> Handle(Get${featurePascal}Query request, CancellationToken cancellationToken)
        {
            // Scaffold: Read from actual Read Model store or DbContext
            // var entity = await _dbContext.${featurePascal}s.FindAsync(request.${featurePascal}Id);
            throw new Exception("Scaffold: Implement database read logic here");
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
