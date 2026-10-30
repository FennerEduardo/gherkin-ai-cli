# Requirements: orders service (Java 17 and Spring Boot)

Build an HTTP service for customer orders with Java 17 and Spring Boot, from an empty directory.

## Contract

- The service listens on the port in the `PORT` environment variable (default 8080) and answers `GET /health` with 200.
- Every `/orders` route requires `Authorization: Bearer <token>`; any non-empty token is accepted. Without one: 401.
- `POST /orders` with `{"items": [{"sku": "BOOK-1", "quantity": 2}]}` creates an order and answers 201 with `{"id": "<string>", "status": "PENDING", "items": [...]}`. No items, or a quantity below 1: 422 with `{"detail": "<reason>"}`.
- `GET /orders/{id}` answers 200 with the order, or 404.
- `POST /orders/{id}/cancel` sets a PENDING order to CANCELLED and answers 200 with the order. An order that is not PENDING: 409. An unknown order: 404.
- Orders may be kept in memory.

## Build

A Maven project: `mvn -B package` builds an executable jar under `target/`.

Include unit tests; `mvn -B test` must pass.
