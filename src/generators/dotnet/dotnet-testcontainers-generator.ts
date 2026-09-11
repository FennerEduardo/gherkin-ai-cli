// --------------------------------------------------------------------------
// Pruebas de Integración con WebApplicationFactory y Testcontainers.DotNet
// --------------------------------------------------------------------------

export function generateDotNetTestcontainersIntegrationTest(namespace: string): string {
  return `// --------------------------------------------------------------------------
// Integration Tests con Testcontainers & WebApplicationFactory
// --------------------------------------------------------------------------
using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc.Testing;
using DotNet.Testcontainers.Builders;
import Testcontainers.PostgreSql;
import Testcontainers.RabbitMq;
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
            var command = new { Amount = 150.00m, CustomerId = "cust_123" };

            // Act
            var response = await _client.PostAsJsonAsync("/api/v1/payments", command);

            // Assert
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
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
