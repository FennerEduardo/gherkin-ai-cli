@aggregate:Order @event:OrderPlaced
Feature: Order placement
  As a customer
  I want to place and cancel orders
  So that I can buy products

  @command:PlaceOrder @pii
  Scenario: The customer places an order
    Given a cart with 2 items
    When the customer places an order with:
      | sku     | quantity | email             |
      | SKU-001 | 2        | ana@example.com   |
    Then the order is placed
    And an OrderPlaced event is published

  @command:PlaceOrder
  Scenario: An order without items is rejected
    Given an empty cart
    When the customer places an order
    Then the order is rejected with HTTP 422

  @command:CancelOrder @role:support @rate:30/min
  Scenario: Support cancels a placed order
    Given a placed order
    When support cancels the order
    Then the order is cancelled
