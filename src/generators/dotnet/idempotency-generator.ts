export function generateIdempotencyInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Patrón de Consumidor e Interceptor Idempotente / Idempotent Pattern (.NET 8/9)
// --------------------------------------------------------------------------
using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;

namespace ${namespace}.Application.Behaviors
{
    public interface IIdempotentRequest
    {
        string IdempotencyKey { get; }
    }

    public class IdempotencyRecord
    {
        public string IdempotencyKey { get; set; } = string.Empty;
        public string Path { get; set; } = string.Empty;
        public string? ResponsePayload { get; set; }
        public int StatusCode { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    }

    public interface IIdempotencyStore
    {
        Task<IdempotencyRecord?> GetAsync(string key);
        Task SaveAsync(IdempotencyRecord record);
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
            var existingRecord = await _store.GetAsync(request.IdempotencyKey);
            if (existingRecord != null)
            {
                _logger.LogWarning("Petición idempotente previamente procesada. Key: {Key}", request.IdempotencyKey);
                if (!string.IsNullOrEmpty(existingRecord.ResponsePayload))
                {
                    return JsonSerializer.Deserialize<TResponse>(existingRecord.ResponsePayload)!;
                }
                return default!;
            }

            var response = await next();
            var record = new IdempotencyRecord
            {
                IdempotencyKey = request.IdempotencyKey,
                Path = typeof(TRequest).Name,
                ResponsePayload = JsonSerializer.Serialize(response),
                StatusCode = 200
            };
            await _store.SaveAsync(record);

            return response;
        }
    }

    public class IdempotentHttpAttribute : Attribute, IAsyncActionFilter
    {
        private readonly string _headerName;

        public IdempotentHttpAttribute(string headerName = "X-Idempotency-Key")
        {
            _headerName = headerName;
        }

        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (!context.HttpContext.Request.Headers.TryGetValue(_headerName, out var keyValues))
            {
                await next();
                return;
            }

            var key = keyValues.ToString();
            var store = context.HttpContext.RequestServices.GetService(typeof(IIdempotencyStore)) as IIdempotencyStore;
            if (store != null)
            {
                var existing = await store.GetAsync(key);
                if (existing != null)
                {
                    context.Result = new ContentResult
                    {
                        StatusCode = existing.StatusCode,
                        ContentType = "application/json",
                        Content = existing.ResponsePayload ?? "{}"
                    };
                    return;
                }
            }

            var executed = await next();
            if (store != null && executed.Result is ObjectResult objectResult)
            {
                var record = new IdempotencyRecord
                {
                    IdempotencyKey = key,
                    Path = context.HttpContext.Request.Path,
                    StatusCode = objectResult.StatusCode ?? 200,
                    ResponsePayload = JsonSerializer.Serialize(objectResult.Value)
                };
                await store.SaveAsync(record);
            }
        }
    }
}
`;
}
