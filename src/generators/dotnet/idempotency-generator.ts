export function generateIdempotencyInfrastructure(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Idempotent Consumer & Interceptor Pattern (.NET 8/9)
// WITH TTL AND BACKGROUND CLEANUP
// --------------------------------------------------------------------------
using System;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.EntityFrameworkCore;

namespace ${namespace}.Application.Behaviors
{
    public interface IIdempotentRequest
    {
        string IdempotencyKey { get; }
    }

    public enum IdempotencyStatus
    {
        Processing = 0,
        Completed = 1,
        Failed = 2
    }

    public class IdempotencyRecord
    {
        public string IdempotencyKey { get; set; } = string.Empty;
        public string Path { get; set; } = string.Empty;
        public string? ResponsePayload { get; set; }
        public int StatusCode { get; set; }
        public IdempotencyStatus Status { get; set; } = IdempotencyStatus.Processing;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    }

    public interface IIdempotencyStore
    {
        Task<IdempotencyRecord?> GetAsync(string key);
        Task SaveAsync(IdempotencyRecord record);
        Task<bool> TryAddAsync(IdempotencyRecord record); // Atomic Insert for concurrency
    }

    public class IdempotentBehavior<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
        where TRequest : IRequest<TResponse>, IIdempotentRequest
    {
        private readonly IIdempotencyStore _store;
        private readonly ILogger<IdempotentBehavior<TRequest, TResponse>> _logger;

        // TTL in minutes. Processing keys older than this are considered stuck/failed.
        private const int ProcessingTtlMinutes = 2; 

        public IdempotentBehavior(IIdempotencyStore store, ILogger<IdempotentBehavior<TRequest, TResponse>> logger)
        {
            _store = store;
            _logger = logger;
        }

        public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
        {
            var initialRecord = new IdempotencyRecord 
            { 
                IdempotencyKey = request.IdempotencyKey, 
                Path = typeof(TRequest).Name,
                Status = IdempotencyStatus.Processing
            };

            var acquired = await _store.TryAddAsync(initialRecord);
            if (!acquired)
            {
                var existingRecord = await _store.GetAsync(request.IdempotencyKey);
                _logger.LogInformation("Idempotency key found: {Key}", request.IdempotencyKey);
                
                if (existingRecord != null)
                {
                    if (existingRecord.Status == IdempotencyStatus.Completed && !string.IsNullOrEmpty(existingRecord.ResponsePayload))
                    {
                        return JsonSerializer.Deserialize<TResponse>(existingRecord.ResponsePayload)!;
                    }
                    
                    if (existingRecord.Status == IdempotencyStatus.Processing)
                    {
                        var age = DateTime.UtcNow - existingRecord.UpdatedAt;
                        if (age.TotalMinutes < ProcessingTtlMinutes)
                        {
                            throw new InvalidOperationException("Request already in progress. Retry after a moment.");
                        }
                        else
                        {
                            _logger.LogWarning("Idempotency key {Key} was stuck in Processing for {Age} mins. Allowing retry.", request.IdempotencyKey, age.TotalMinutes);
                            // It's stuck. We'll proceed and overwrite it.
                            existingRecord.Status = IdempotencyStatus.Processing;
                            existingRecord.UpdatedAt = DateTime.UtcNow;
                            await _store.SaveAsync(existingRecord);
                        }
                    }
                }
            }

            try
            {
                var response = await next();
                
                var recordToUpdate = await _store.GetAsync(request.IdempotencyKey) ?? initialRecord;
                recordToUpdate.ResponsePayload = JsonSerializer.Serialize(response);
                recordToUpdate.Status = IdempotencyStatus.Completed;
                recordToUpdate.StatusCode = 200;
                recordToUpdate.UpdatedAt = DateTime.UtcNow;
                await _store.SaveAsync(recordToUpdate);

                return response;
            }
            catch (Exception ex)
            {
                var recordToFail = await _store.GetAsync(request.IdempotencyKey) ?? initialRecord;
                recordToFail.Status = IdempotencyStatus.Failed;
                recordToFail.ResponsePayload = JsonSerializer.Serialize(new { Error = ex.Message });
                recordToFail.StatusCode = 500;
                recordToFail.UpdatedAt = DateTime.UtcNow;
                await _store.SaveAsync(recordToFail);
                throw;
            }
        }
    }

    public class IdempotentHttpAttribute : Attribute, IAsyncActionFilter
    {
        private readonly string _headerName;
        private const int ProcessingTtlMinutes = 2;

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
            if (store == null)
            {
                await next();
                return;
            }

            var initialRecord = new IdempotencyRecord
            {
                IdempotencyKey = key,
                Path = context.HttpContext.Request.Path,
                Status = IdempotencyStatus.Processing
            };

            var acquired = await store.TryAddAsync(initialRecord);
            if (!acquired)
            {
                var existing = await store.GetAsync(key);
                if (existing != null)
                {
                    if (existing.Status == IdempotencyStatus.Completed)
                    {
                        context.Result = new ContentResult
                        {
                            StatusCode = existing.StatusCode,
                            ContentType = "application/json",
                            Content = existing.ResponsePayload ?? "{}"
                        };
                        return;
                    }
                    if (existing.Status == IdempotencyStatus.Processing)
                    {
                        var age = DateTime.UtcNow - existing.UpdatedAt;
                        if (age.TotalMinutes < ProcessingTtlMinutes)
                        {
                            context.Result = new ConflictObjectResult(new { Error = "Request already in progress. Retry after a moment." });
                            return;
                        }
                        else
                        {
                            existing.Status = IdempotencyStatus.Processing;
                            existing.UpdatedAt = DateTime.UtcNow;
                            await store.SaveAsync(existing);
                        }
                    }
                }
            }

            var executed = await next();
            
            var recordToUpdate = await store.GetAsync(key) ?? initialRecord;
            recordToUpdate.UpdatedAt = DateTime.UtcNow;

            if (executed.Exception != null)
            {
                recordToUpdate.Status = IdempotencyStatus.Failed;
                recordToUpdate.StatusCode = 500;
                recordToUpdate.ResponsePayload = JsonSerializer.Serialize(new { Error = executed.Exception.Message });
            }
            else if (executed.Result is ObjectResult objectResult)
            {
                recordToUpdate.Status = IdempotencyStatus.Completed;
                recordToUpdate.StatusCode = objectResult.StatusCode ?? 200;
                recordToUpdate.ResponsePayload = JsonSerializer.Serialize(objectResult.Value);
            }
            else if (executed.Result is StatusCodeResult statusCodeResult)
            {
                recordToUpdate.Status = IdempotencyStatus.Completed;
                recordToUpdate.StatusCode = statusCodeResult.StatusCode;
            }

            await store.SaveAsync(recordToUpdate);
        }
    }

    /// <summary>
    /// Background service that cleans up expired idempotency keys to prevent database bloat.
    /// </summary>
    public class IdempotencyCleanupService : BackgroundService
    {
        private readonly IServiceProvider _serviceProvider;
        private readonly ILogger<IdempotencyCleanupService> _logger;
        private readonly TimeSpan _retentionPeriod = TimeSpan.FromDays(1); // Keys live for 24 hours

        public IdempotencyCleanupService(IServiceProvider serviceProvider, ILogger<IdempotencyCleanupService> logger)
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
                    var dbContext = scope.ServiceProvider.GetRequiredService<DbContext>(); // Usually ApplicationDbContext

                    var cutoff = DateTime.UtcNow.Subtract(_retentionPeriod);
                    
                    var deleted = await dbContext.Database.ExecuteSqlInterpolatedAsync(
                        $"DELETE FROM \\"IdempotencyRecords\\" WHERE \\"CreatedAt\\" < {cutoff}", 
                        stoppingToken);

                    if (deleted > 0)
                    {
                        _logger.LogInformation("Cleaned up {Count} expired idempotency records.", deleted);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to run idempotency cleanup job.");
                }

                // Run every 1 hour
                await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
            }
        }
    }
}
`;
}
