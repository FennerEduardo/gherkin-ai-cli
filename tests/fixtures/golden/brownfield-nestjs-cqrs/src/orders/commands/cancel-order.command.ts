import { ConflictException, NotFoundException } from '@nestjs/common';
import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { OrderRepository } from '../order.repository';
import { OrderCancelledEvent } from '../events';

export class CancelOrderCommand {
  constructor(public readonly orderId: string) {}
}

@CommandHandler(CancelOrderCommand)
export class CancelOrderHandler implements ICommandHandler<CancelOrderCommand> {
  constructor(private readonly orders: OrderRepository, private readonly eventBus: EventBus) {}

  async execute(command: CancelOrderCommand) {
    const order = await this.orders.findOne(command.orderId);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'SHIPPED') throw new ConflictException('Shipped orders cannot be cancelled');
    order.status = 'CANCELLED';
    await this.orders.save(order);
    this.eventBus.publish(new OrderCancelledEvent(order.id));
    return order;
  }
}
