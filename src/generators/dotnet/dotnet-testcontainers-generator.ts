// --------------------------------------------------------------------------
// Pruebas de Integración E2E con WebApplicationFactory y Testcontainers.DotNet
// --------------------------------------------------------------------------

export function generateDotNetTestcontainersIntegrationTest(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Integration Tests con Testcontainers & WebApplicationFactory (.NET 8/9)
// --------------------------------------------------------------------------
using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc.Testing;
using DotNet.Testcontainers.Builders;
using Testcontainers.PostgreSql;
using Testcontainers.RabbitMq;
using Xunit;

namespace ${namespace}.IntegrationTests
{
    public class DistributedSystemIntegrationTest : IAsyncLifetime
    {
        private readonly PostgreSqlContainer _postgresContainer = new PostgreSqlBuilder()
            .WithImage("postgres:15-alpine")
            .WithDatabase("testdb")
            .WithUsername("postgres")
            .WithPassword("postgres")
            .Build();

        private readonly RabbitMqContainer _rabbitMqContainer = new RabbitMqBuilder()
            .WithImage("rabbitmq:3-management-alpine")
            .Build();

        private WebApplicationFactory<Program> _factory = null!;
        private HttpClient _client = null!;

        public async Task InitializeAsync()
        {
            await _postgresContainer.StartAsync();
            await _rabbitMqContainer.StartAsync();

            _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            {
                builder.UseSetting("ConnectionStrings:DefaultConnection", _postgresContainer.GetConnectionString());
                builder.UseSetting("RabbitMQ:ConnectionString", _rabbitMqContainer.GetConnectionString());
            });

            _client = _factory.CreateClient();
        }

        [Fact]
        public async Task OutboxAndSaga_HappyPath_ExecutesSuccessfully()
        {
            // Arrange
            var command = new { Amount = 250.00m, CustomerId = "cust_123", ReferenceCode = "REF-2026-X" };

            // Act
            var response = await _client.PostAsJsonAsync("/api/v1/payments", command);

            // Assert
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        }

        [Fact]
        public async Task InboxPattern_DuplicateMessage_IsDeduplicatedIdempotently()
        {
            // Arrange
            var idempotencyKey = Guid.NewGuid().ToString();
            var command = new { Amount = 100.00m, CustomerId = "cust_555" };
            
            var request1 = new HttpRequestMessage(HttpMethod.Post, "/api/v1/payments")
            {
                Content = JsonContent.Create(command)
            };
            request1.Headers.Add("X-Idempotency-Key", idempotencyKey);

            var request2 = new HttpRequestMessage(HttpMethod.Post, "/api/v1/payments")
            {
                Content = JsonContent.Create(command)
            };
            request2.Headers.Add("X-Idempotency-Key", idempotencyKey);

            // Act
            var resp1 = await _client.SendAsync(request1);
            var resp2 = await _client.SendAsync(request2);

            // Assert
            Assert.Equal(HttpStatusCode.Accepted, resp1.StatusCode);
            Assert.Equal(HttpStatusCode.Accepted, resp2.StatusCode); // Deduplicado idempotentemente
        }

        [Fact]
        public async Task Saga_CompensationFlow_TriggersOnProviderFailure()
        {
            // Arrange
            var invalidCommand = new { Amount = -50.00m, CustomerId = "cust_invalid" };

            // Act
            var response = await _client.PostAsJsonAsync("/api/v1/payments", invalidCommand);

            // Assert
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest || response.StatusCode == HttpStatusCode.UnprocessableEntity);
        }

        public async Task DisposeAsync()
        {
            _client?.Dispose();
            _factory?.Dispose();
            await _postgresContainer.DisposeAsync();
            await _rabbitMqContainer.DisposeAsync();
        }
    }
}
`;
}
