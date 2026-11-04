// An orders service written by hand with @nestjs/cqrs: the controller only dispatches commands.
import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { AuthGuard } from '../auth.guard';
import { PlaceOrderCommand } from './commands/place-order.command';
import { CancelOrderCommand } from './commands/cancel-order.command';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post()
  place(@Body() body: { customerEmail: string; items: string[] }) {
    return this.commandBus.execute(new PlaceOrderCommand(body.customerEmail, body.items));
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.commandBus.execute(new CancelOrderCommand(id));
  }
}
