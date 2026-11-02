using Orders.Domain;

namespace Orders.Application;

public interface IOrderService
{
    Task<Order> PlaceAsync(PlaceOrderRequest request);
    Task<Order?> FindAsync(string id);
    Task<Order> CancelAsync(string id);
}

public class OrderService : IOrderService
{
    private readonly IOrderRepository _repository;
    private readonly IEventPublisher _publisher;

    public OrderService(IOrderRepository repository, IEventPublisher publisher)
    {
        _repository = repository;
        _publisher = publisher;
    }

    public async Task<Order> PlaceAsync(PlaceOrderRequest request)
    {
        var order = new Order(Guid.NewGuid().ToString(), request.CustomerEmail) { Status = OrderStatus.Pending };
        await _repository.AddAsync(order);
        await _publisher.PublishAsync(new OrderPlacedEvent(order.Id));
        return order;
    }

    public Task<Order?> FindAsync(string id) => _repository.FindAsync(id);

    public async Task<Order> CancelAsync(string id)
    {
        var order = await _repository.FindAsync(id);
        if (order == null)
        {
            throw new KeyNotFoundException("Order not found");
        }
        if (order.Status != OrderStatus.Pending)
        {
            throw new InvalidOperationException("Only pending orders can be cancelled");
        }
        order.Status = OrderStatus.Cancelled;
        await _repository.UpdateAsync(order);
        return order;
    }
}
