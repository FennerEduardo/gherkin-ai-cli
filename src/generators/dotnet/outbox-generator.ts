export function generateOutboxInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Patrón Transactional Outbox / Transactional Outbox Pattern
// --------------------------------------------------------------------------
using System;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using System.Threading;
using System.Threading.Tasks;

namespace ${namespace}.Infrastructure.Outbox
{
    public class OutboxMessage
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public string EventType { get; set; } = string.Empty;
        public string Payload { get; set; } = string.Empty;
        public DateTime OccurredOn { get; set; } = DateTime.UtcNow;
        public DateTime? ProcessedOn { get; set; }
        public string? Error { get; set; }
    }

    public interface IOutboxService
    {
        Task SaveMessageAsync<T>(T domainEvent) where T : class;
    }

    public class OutboxService : IOutboxService
    {
        private readonly DbContext _dbContext;

        public OutboxService(DbContext dbContext)
        {
            _dbContext = dbContext;
        }

        public async Task SaveMessageAsync<T>(T domainEvent) where T : class
        {
            var message = new OutboxMessage
            {
                EventType = typeof(T).Name,
                Payload = JsonSerializer.Serialize(domainEvent)
            };
            
            _dbContext.Set<OutboxMessage>().Add(message);
            // El mensaje se guarda en la misma transacción que los cambios de negocio.
            // The message is saved in the same transaction as the business changes.
            await Task.CompletedTask;
        }
    }
}
`;
}
