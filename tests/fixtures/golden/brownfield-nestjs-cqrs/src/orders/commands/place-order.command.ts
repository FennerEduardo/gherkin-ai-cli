import { BadRequestException } from '@nestjs/common';
import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { OrderRepository } from '../order.repository';
import { OrderPlacedEvent } from '../events';

export class PlaceOrderCommand {
  constructor(public readonly customerEmail: string, public readonly items: string[]) {}
}

@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand> {
  constructor(private readonly orders: OrderRepository, private readonly eventBus: EventBus) {}

  async execute(command: PlaceOrderCommand) {
    if (!command.items.length) throw new BadRequestException('An order needs at least one item');
    const order = { id: command.customerEmail, status: 'PLACED' };
    await this.orders.save(order);
    this.eventBus.publish(new OrderPlacedEvent(order.id));
    return order;
  }
}
