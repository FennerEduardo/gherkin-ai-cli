import { ConflictException, Controller } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GrpcMethod } from '@nestjs/microservices';
import { EventEmitter } from 'node:events';

class Order {
  id = '';
  status = 'PENDING';
}

const eventBus = new EventEmitter();

@Resolver(() => Order)
export class OrderResolver {
  private readonly orders = new Map<string, Order>();

  @Query(() => [Order])
  orders() {
    return [...this.orders.values()];
  }

  @Mutation(() => Order)
  placeOrder(@Args('customerEmail') customerEmail: string) {
    const order = { id: customerEmail, status: 'PENDING' };
    this.orders.set(order.id, order);
    eventBus.emit('order.placed', order);
    return order;
  }

  @Mutation(() => Order)
  cancelOrder(@Args('id') id: string) {
    const order = this.orders.get(id)!;
    if (order.status !== 'PENDING') throw new ConflictException('Only pending orders can be cancelled');
    order.status = 'CANCELLED';
    return order;
  }
}

@Controller()
export class PaymentsGrpcController {
  @GrpcMethod('PaymentService', 'AuthorizePayment')
  authorize(request: { orderId: string }) {
    const payment = { id: request.orderId, status: 'PENDING' };
    payment.status = 'AUTHORIZED';
    return payment;
  }
}
