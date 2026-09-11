// --------------------------------------------------------------------------
// Generador de Pipelines de Resiliencia Polly v8 (Polly.Core) para .NET 8/9
// --------------------------------------------------------------------------

export function generateResiliencePipelines(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Polly v8 (Polly.Core) Resilience Pipeline Builders
// --------------------------------------------------------------------------
using System;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Polly;
using Polly.CircuitBreaker;
using Polly.Retry;
using Polly.Timeout;

namespace ${namespace}.Infrastructure.Resilience
{
    public static class ResiliencePipelineExtensions
    {
        public static IServiceCollection AddCustomResiliencePipelines(this IServiceCollection services)
        {
            services.AddResiliencePipeline("default-http-pipeline", (builder, context) =>
            {
                var logger = context.ServiceProvider.GetRequiredService<ILogger<ResiliencePipelineBuilder>>();

                builder
                    // 1. Retry Pipeline con Exponential Backoff + Jitter
                    .AddRetry(new RetryStrategyOptions
                    {
                        ShouldHandle = new PredicateBuilder().Handle<HttpRequestException>().Handle<TimeoutRejectedException>(),
                        MaxRetryAttempts = 4,
                        Delay = TimeSpan.FromSeconds(2),
                        BackoffType = DelayBackoffType.Exponential,
                        UseJitter = true,
                        OnRetry = args =>
                        {
                            logger.LogWarning("Reintento #{Attempt} tras error: {Message}", args.AttemptNumber, args.Outcome.Exception?.Message);
                            return ValueTask.CompletedTask;
                        }
                    })
                    // 2. Circuit Breaker Pipeline
                    .AddCircuitBreaker(new CircuitBreakerStrategyOptions
                    {
                        ShouldHandle = new PredicateBuilder().Handle<HttpRequestException>(),
                        FailureRatio = 0.5,
                        SamplingDuration = TimeSpan.FromSeconds(10),
                        MinimumThroughput = 8,
                        BreakDuration = TimeSpan.FromSeconds(30),
                        OnOpened = args =>
                        {
                            logger.LogError("Circuit Breaker ABIERTO por {Duration}s", args.BreakDuration.TotalSeconds);
                            return ValueTask.CompletedTask;
                        },
                        OnClosed = args =>
                        {
                            logger.LogInformation("Circuit Breaker CERRADO / Operativo");
                            return ValueTask.CompletedTask;
                        }
                    })
                    // 3. Timeout Pipeline (Per Request Deadline)
                    .AddTimeout(TimeSpan.FromSeconds(10));
            });

            return services;
        }
    }
}
`;
}
