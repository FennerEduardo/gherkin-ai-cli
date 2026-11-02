using System.ComponentModel.DataAnnotations;

namespace Orders.Domain;

public enum OrderStatus { Pending, Cancelled }

public class Order
{
    public Order(string id, string customerEmail) { Id = id; CustomerEmail = customerEmail; }
    public string Id { get; }
    public string CustomerEmail { get; }
    public OrderStatus Status { get; set; }
}

public record OrderPlacedEvent(string OrderId);

public record PlaceOrderRequest(
    [property: Required, EmailAddress] string CustomerEmail,
    [property: Range(1, 100)] int Quantity);

public interface IOrderRepository
{
    Task AddAsync(Order order);
    Task<Order?> FindAsync(string id);
    Task UpdateAsync(Order order);
}

public interface IEventPublisher { Task PublishAsync(object @event); }
