@aggregate:Order
Feature: Order handling
  As a customer
  I want to place and refund orders
  So that I can buy products and get my money back

  @command:PlaceOrder
  Scenario: The customer places an order
    Given a cart with 2 items
    When the customer places an order
    Then the order is placed
    And an OrderPlaced event is published

  @command:RefundOrder
  Scenario: Support refunds a placed order
    Given a placed order
    When support refunds the order
    Then the order is refunded
    And an OrderRefunded event is published
