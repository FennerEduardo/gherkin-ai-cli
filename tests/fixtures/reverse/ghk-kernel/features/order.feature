@aggregate:Order @command:PlaceOrder @command:CancelOrder @event:OrderPlaced @event:OrderCancelled
Feature: Order
  As a customer
  I want to place and cancel orders

  Scenario: Place an order
    Given a signed-in customer
    When the customer places an order
    Then the order is placed

  Scenario: Cancel an order
    Given a placed order
    When the customer cancels the order
    Then the order is cancelled
