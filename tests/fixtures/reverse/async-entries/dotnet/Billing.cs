using MassTransit;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Shop.Billing;

public record OrderShipped(string OrderId);

public class Invoice
{
    public string Id { get; set; } = "";
    public string Number { get; set; } = "";
    public string Status { get; set; } = "DRAFT";
}

public class BillingDb : DbContext
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>().HasIndex(i => i.Number).IsUnique();
    }
}

public class OrderShippedConsumer : IConsumer<OrderShipped>
{
    public Task Consume(ConsumeContext<OrderShipped> context)
    {
        var invoice = new Invoice();
        invoice.Status = "ISSUED";
        return Task.CompletedTask;
    }
}

public class OverdueInvoiceReminder : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var invoice = new Invoice();
        invoice.Status = "OVERDUE";
        await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
    }
}
