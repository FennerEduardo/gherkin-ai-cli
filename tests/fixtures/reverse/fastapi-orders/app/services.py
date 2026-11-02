from app.events import bus
from app.models import Order, OrderStatus
from app.repository import orders


class OrderNotPendingError(Exception):
    pass


def place_order(request):
    order = Order(customer_email=request.customer_email, status=OrderStatus.PENDING)
    orders.save(order)
    bus.publish("OrderPlaced", {"order_id": order.id})
    return order


def find_order(order_id):
    return orders.get(order_id)


def cancel_order(order):
    if order.status != OrderStatus.PENDING:
        raise HTTPException(status_code=409, detail="Only pending orders can be cancelled")
    order.status = OrderStatus.CANCELLED
    orders.save(order)
    return order
