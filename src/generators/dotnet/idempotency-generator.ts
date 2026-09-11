export function generateIdempotencyInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Patrón de Consumidor Idempotente / Idempotent Consumer Pattern
// --------------------------------------------------------------------------
using System;
using System.Threading;
using System.Threading.Tasks;
using MediatR;
using Microsoft.Extensions.Logging;

namespace ${namespace}.Application.Behaviors
{
    public interface IIdempotentRequest
    {
        string IdempotencyKey { get; }
    }

    public interface IIdempotencyStore
    {
        Task<bool> ExistsAsync(string key);
        Task SaveAsync(string key);
    }

    public class IdempotentBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
        where TRequest : IRequest<TResponse>, IIdempotentRequest
    {
        private readonly IIdempotencyStore _store;
        private readonly ILogger<IdempotentBehavior<TRequest, TResponse>> _logger;

        public IdempotentBehavior(IIdempotencyStore store, ILogger<IdempotentBehavior<TRequest, TResponse>> logger)
        {
            _store = store;
            _logger = logger;
        }

        public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
        {
            if (await _store.ExistsAsync(request.IdempotencyKey))
            {
                _logger.LogWarning("Request ya procesado (idempotencia) / Request already processed (idempotency). Key: {Key}", request.IdempotencyKey);
                return default!; // O devolver la respuesta cacheada / Or return cached response
            }

            var response = await next();
            await _store.SaveAsync(request.IdempotencyKey);
            return response;
        }
    }
}
`;
}
