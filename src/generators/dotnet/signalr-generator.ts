// --------------------------------------------------------------------------
// Generador SignalR Realtime Hub para .NET 8/9
// --------------------------------------------------------------------------

export function generateSignalRInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Hub de SignalR para Notificación Realtime de Eventos de Dominio
// --------------------------------------------------------------------------
using System.Threading.Tasks;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;

namespace ${namespace}.Infrastructure.Realtime
{
    public interface IDomainEventClient
    {
        Task ReceiveDomainEvent(string eventType, string payload);
        Task ReceiveSagaStateChanged(string sagaId, string currentState);
    }

    public class DomainEventHub : Hub<IDomainEventClient>
    {
        private readonly ILogger<DomainEventHub> _logger;

        public DomainEventHub(ILogger<DomainEventHub> logger)
        {
            _logger = logger;
        }

        public async Task SubscribeToTenant(string tenantId)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, $"Tenant_{tenantId}");
            _logger.LogInformation("Conexión SignalR {ConnectionId} suscrita a Tenant {TenantId}", Context.ConnectionId, tenantId);
        }

        public async Task UnsubscribeFromTenant(string tenantId)
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"Tenant_{tenantId}");
        }
    }

    public interface ISignalRNotificationService
    {
        Task NotifyTenantAsync(string tenantId, string eventType, object payload);
        Task BroadcastEventAsync(string eventType, object payload);
    }

    public class SignalRNotificationService : ISignalRNotificationService
    {
        private readonly IHubContext<DomainEventHub, IDomainEventClient> _hubContext;

        public SignalRNotificationService(IHubContext<DomainEventHub, IDomainEventClient> hubContext)
        {
            _hubContext = hubContext;
        }

        public async Task NotifyTenantAsync(string tenantId, string eventType, object payload)
        {
            var jsonPayload = System.Text.Json.JsonSerializer.Serialize(payload);
            await _hubContext.Clients.Group($"Tenant_{tenantId}").ReceiveDomainEvent(eventType, jsonPayload);
        }

        public async Task BroadcastEventAsync(string eventType, object payload)
        {
            var jsonPayload = System.Text.Json.JsonSerializer.Serialize(payload);
            await _hubContext.Clients.All.ReceiveDomainEvent(eventType, jsonPayload);
        }
    }
}
`;
}
