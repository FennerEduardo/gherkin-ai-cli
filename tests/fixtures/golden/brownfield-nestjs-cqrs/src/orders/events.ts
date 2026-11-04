import { EventBus, EventsHandler, IEventHandler } from '@nestjs/cqrs';

export class OrderPlacedEvent {
  constructor(public readonly orderId: string) {}
}

export class OrderCancelledEvent {
  constructor(public readonly orderId: string) {}
}

export class StockReservedEvent {
  constructor(public readonly orderId: string) {}
}

/** Stock is reserved as soon as an order is placed. */
@EventsHandler(OrderPlacedEvent)
export class ReserveStockWhenOrderPlaced implements IEventHandler<OrderPlacedEvent> {
  constructor(private readonly eventBus: EventBus) {}

  handle(event: OrderPlacedEvent) {
    const reservation = { orderId: event.orderId, status: 'PENDING' };
    reservation.status = 'RESERVED';
    this.eventBus.publish(new StockReservedEvent(event.orderId));
  }
}
