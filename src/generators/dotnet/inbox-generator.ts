// --------------------------------------------------------------------------
// Patrón Inbox Pattern / Inbox Consumer Deduplication (.NET 8/9)
// --------------------------------------------------------------------------

export function generateInboxInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Inbox Pattern & Consumer Deduplication Middleware
// --------------------------------------------------------------------------
using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace ${namespace}.Infrastructure.Inbox
{
    public class InboxMessage
    {
        public Guid MessageId { get; set; }
        public string EventType { get; set; } = string.Empty;
        public string SourceService { get; set; } = string.Empty;
        public DateTime ConsumedAt { get; set; } = DateTime.UtcNow;
    }

    public interface IInboxService
    {
        Task<bool> HasBeenConsumedAsync(Guid messageId);
        Task MarkAsConsumedAsync(Guid messageId, string eventType, string sourceService);
    }

    public class InboxService : IInboxService
    {
        private readonly DbContext _dbContext;
        private readonly ILogger<InboxService> _logger;

        public InboxService(DbContext dbContext, ILogger<InboxService> logger)
        {
            _dbContext = dbContext;
            _logger = logger;
        }

        public async Task<bool> HasBeenConsumedAsync(Guid messageId)
        {
            return await _dbContext.Set<InboxMessage>().AnyAsync(m => m.MessageId == messageId);
        }

        public async Task MarkAsConsumedAsync(Guid messageId, string eventType, string sourceService)
        {
            var inboxRecord = new InboxMessage
            {
                MessageId = messageId,
                EventType = eventType,
                SourceService = sourceService,
                ConsumedAt = DateTime.UtcNow
            };

            await _dbContext.Set<InboxMessage>().AddAsync(inboxRecord);
            await _dbContext.SaveChangesAsync();
        }
    }
}
`;
}
