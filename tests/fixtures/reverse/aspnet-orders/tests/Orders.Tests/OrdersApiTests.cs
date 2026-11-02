public class OrdersApiTests
{
    [Fact]
    public async Task CancelsAPendingOrder()
    {
        var response = await _client.PostAsync("/api/orders/o-1/cancel", null);
    }
}
