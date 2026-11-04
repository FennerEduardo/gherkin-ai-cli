<?php

use App\Http\Controllers\OrderController;
use App\Http\Controllers\TagController;
use Illuminate\Support\Facades\Route;

Route::get('/tags', [TagController::class, 'index']);

Route::middleware('auth:sanctum')->prefix('v1')->group(function () {
    Route::apiResource('orders', OrderController::class)->only(['index', 'store', 'show']);
    Route::post('/orders/{order}/cancel', [OrderController::class, 'cancel']);
    Route::middleware('role:manager')->group(function () {
        Route::post('/orders/{order}/refund', [OrderController::class, 'refund']);
    });
});
