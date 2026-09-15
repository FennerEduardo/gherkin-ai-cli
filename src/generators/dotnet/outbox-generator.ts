export function generateOutboxInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Transactional Outbox Pattern (.NET 8/9)
// --------------------------------------------------------------------------
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ${namespace}.Infrastructure.Outbox
{
    public enum OutboxStatus
    {
        Pending = 0,
        Processing = 1,
        Published = 2,
        Failed = 3
    }

    public class OutboxMessage
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public string EventType { get; set; } = string.Empty;
        public string Payload { get; set; } = string.Empty;
        public DateTime OccurredOn { get; set; } = DateTime.UtcNow;
        public DateTime? ProcessedOn { get; set; }
        public OutboxStatus Status { get; set; } = OutboxStatus.Pending;
        public int RetryCount { get; set; } = 0;
        public string? Error { get; set; }
        public DateTime? LockUntil { get; set; }
    }

    public interface IOutboxService
    {
        Task SaveMessageAsync<T>(T domainEvent, IDbContextTransaction transaction) where T : class;
    }

    public class OutboxService : IOutboxService
    {
        private readonly DbContext _dbContext;

        public OutboxService(DbContext dbContext)
        {
            _dbContext = dbContext;
        }

        public async Task SaveMessageAsync<T>(T domainEvent, IDbContextTransaction transaction) where T : class
        {
            if (transaction == null)
            {
                throw new InvalidOperationException("OutboxMessage must be saved within an active IDbContextTransaction.");
            }

            var message = new OutboxMessage
            {
                EventType = typeof(T).Name,
                Payload = JsonSerializer.Serialize(domainEvent),
                Status = OutboxStatus.Pending
            };
            
            await _dbContext.Set<OutboxMessage>().AddAsync(message);
        }
    }

    public interface IMessageBrokerPublisher
    {
        Task PublishAsync(string eventType, string payload, CancellationToken cancellationToken);
    }

    public class OutboxProcessorBackgroundService : BackgroundService
    {
        private readonly IServiceProvider _serviceProvider;
        private readonly ILogger<OutboxProcessorBackgroundService> _logger;

        public OutboxProcessorBackgroundService(IServiceProvider serviceProvider, ILogger<OutboxProcessorBackgroundService> logger)
        {
            _serviceProvider = serviceProvider;
            _logger = logger;
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    using var scope = _serviceProvider.CreateScope();
                    var dbContext = scope.ServiceProvider.GetRequiredService<DbContext>();
                    var messageBroker = scope.ServiceProvider.GetRequiredService<IMessageBrokerPublisher>();

                    var now = DateTime.UtcNow;
                    var lockTime = now.AddSeconds(30);
                    
                    // Atomic Locking (AC-08): PostgreSQL FOR UPDATE SKIP LOCKED
                    var pendingMessages = await dbContext.Set<OutboxMessage>()
                        .FromSqlRaw(@"
                            UPDATE ""OutboxMessages""
                            SET ""Status"" = 1, ""LockUntil"" = {0}
                            WHERE ""Id"" IN (
                                SELECT ""Id"" FROM ""OutboxMessages""
                                WHERE ""Status"" = 0 AND (""LockUntil"" IS NULL OR ""LockUntil"" < {1})
                                LIMIT 50
                                FOR UPDATE SKIP LOCKED
                            )
                            RETURNING *;", lockTime, now)
                        .ToListAsync(stoppingToken);

                    if (pendingMessages.Any())
                    {

                        foreach (var msg in pendingMessages)
                        {
                            try
                            {
                                await messageBroker.PublishAsync(msg.EventType, msg.Payload, stoppingToken);
                                msg.Status = OutboxStatus.Published;
                                msg.ProcessedOn = DateTime.UtcNow;
                            }
                            catch (Exception ex)
                            {
                                msg.RetryCount++;
                                msg.Error = ex.Message;
                                msg.Status = msg.RetryCount >= 5 ? OutboxStatus.Failed : OutboxStatus.Pending;
                                _logger.LogError(ex, "Failed to publish Outbox message {Id}", msg.Id);
                            }
                        }
                        await dbContext.SaveChangesAsync(stoppingToken);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error in Outbox background processor");
                }

                await Task.Delay(5000, stoppingToken);
            }
        }
    }
}
`;
}
