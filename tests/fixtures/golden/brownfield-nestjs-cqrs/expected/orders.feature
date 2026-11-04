# Written by hand, from the product's point of view, before reading the proposals (golden G-R1).
Feature: Orders
  As a customer
  I want to place and cancel orders
  So that I get what I buy and can change my mind before it ships

  Scenario: Place an order
    Given a signed-in customer
    When the customer places an order with two items
    Then the order is placed
    And the order status is "PLACED"

  Scenario: An order needs at least one item
    Given a signed-in customer
    When the customer places an order with no items
    Then the order is rejected

  Scenario: Cancel an order
    Given an order with status "PLACED"
    When the customer cancels the order
    Then the order is cancelled
    And the order status is "CANCELLED"

  Scenario: A shipped order cannot be cancelled
    Given an order with status "SHIPPED"
    When the customer cancels the order
    Then the cancellation is refused
