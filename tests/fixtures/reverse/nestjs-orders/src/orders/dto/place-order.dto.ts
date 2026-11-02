import { ArrayNotEmpty, IsEmail, IsInt, IsPositive } from 'class-validator';

export class PlaceOrderDto {
  @IsEmail()
  customerEmail!: string;

  @ArrayNotEmpty()
  items!: string[];

  @IsInt()
  @IsPositive()
  quantity!: number;
}
