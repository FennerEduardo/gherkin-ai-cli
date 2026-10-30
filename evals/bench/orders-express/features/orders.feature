@aggregate:Order @command:PlaceOrder @command:CancelOrder @event:OrderPlaced @event:OrderCancelled
Feature: Orders
  As a signed-in customer
  I want to place and cancel orders
  So that I only pay for what I still want

  Scenario: The customer places an order
    Given a signed-in customer
    When the customer places an order for 2 units of "BOOK-1"
    Then the order is created with status "PENDING"

  Scenario: An order without items is rejected
    Given a signed-in customer
    When the customer places an order with no items
    Then the request is rejected as invalid with status 422

  Scenario: A quantity of zero is rejected
    Given a signed-in customer
    When the customer places an order for 0 units of "BOOK-1"
    Then the request is rejected as invalid with status 422

  Scenario: An anonymous caller cannot place an order
    Given a caller without a bearer token
    When the caller places an order for 1 unit of "BOOK-1"
    Then the request is denied with status 401

  Scenario: The customer cancels a pending order
    Given a "PENDING" order
    When the customer cancels the order
    Then the order status is "CANCELLED"

  Scenario: A cancelled order cannot be cancelled again
    Given a "CANCELLED" order
    When the customer cancels the order
    Then the request fails with status 409

  Scenario: Cancelling an unknown order fails
    When the customer cancels an order that does not exist
    Then the request fails with status 404
