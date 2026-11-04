<?php

namespace App\Http\Controllers;

use App\Events\OrderCancelled;
use App\Events\OrderPlaced;
use App\Http\Requests\StoreOrderRequest;
use App\Models\Order;

class OrderController extends Controller
{
    public function index()
    {
        return Order::all();
    }

    public function store(StoreOrderRequest $request)
    {
        $order = Order::create(['email' => $request->email, 'status' => 'PENDING']);
        event(new OrderPlaced($order));
        return response()->json($order, 201);
    }

    public function show(Order $order)
    {
        return $order;
    }

    public function cancel(Order $order)
    {
        if ($order->status !== 'PENDING') {
            return response()->json(['message' => 'Only pending orders can be cancelled'], 409);
        }
        $order->status = 'CANCELLED';
        $order->save();
        OrderCancelled::dispatch($order);
        return response()->json($order, 200);
    }

    public function refund(Order $order)
    {
        abort_if($order->status !== 'PAID', 409, 'Only paid orders can be refunded');
        $order->update(['status' => 'REFUNDED']);
        return response()->json($order, 200);
    }
}
