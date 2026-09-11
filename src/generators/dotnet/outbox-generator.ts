export function generateOutboxInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Patrón Transactional Outbox / Transactional Outbox Pattern (.NET 8/9)
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
                throw new InvalidOperationException("OutboxMessage debe guardarse dentro de una IDbContextTransaction activa.");
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

    public class OutboxProcessorBackgroundService : BackgroundService
    {
        private readonly DbContext _dbContext;
        private readonly ILogger<OutboxProcessorBackgroundService> _logger;

        public OutboxProcessorBackgroundService(DbContext dbContext, ILogger<OutboxProcessorBackgroundService> logger)
        {
            _dbContext = dbContext;
            _logger = logger;
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    var now = DateTime.UtcNow;
                    var pendingMessages = await _dbContext.Set<OutboxMessage>()
                        .Where(m => m.Status == OutboxStatus.Pending && (m.LockUntil == null || m.LockUntil < now))
                        .Take(50)
                        .ToListAsync(stoppingToken);

                    foreach (var msg in pendingMessages)
                    {
                        msg.Status = OutboxStatus.Processing;
                        msg.LockUntil = now.AddSeconds(30);
                    }

                    await _dbContext.SaveChangesAsync(stoppingToken);

                    foreach (var msg in pendingMessages)
                    {
                        try
                        {
                            // Publicar evento al broker de mensajería (MassTransit, RabbitMQ, Kafka)
                            msg.Status = OutboxStatus.Published;
                            msg.ProcessedOn = DateTime.UtcNow;
                        }
                        catch (Exception ex)
                        {
                            msg.RetryCount++;
                            msg.Error = ex.Message;
                            msg.Status = msg.RetryCount >= 5 ? OutboxStatus.Failed : OutboxStatus.Pending;
                            _logger.LogError(ex, "Fallo al publicar mensaje Outbox {Id}", msg.Id);
                        }
                    }

                    await _dbContext.SaveChangesAsync(stoppingToken);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error en ejecutor de Outbox background");
                }

                await Task.Delay(5000, stoppingToken);
            }
        }
    }
}
`;
}
