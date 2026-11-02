import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { PlaceOrderDto } from './dto/place-order.dto';
import { OrdersService } from './orders.service';

@Controller('api/v1/orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  placeOrder(@Body() dto: PlaceOrderDto) {
    return this.ordersService.place(dto);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles('manager')
  approve(@Param('id') id: string) {
    return this.ordersService.approve(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Get()
  findAll() {
    return this.ordersService.findAll();
  }
}
