Feature: Orders
  As a customer
  I want to place and cancel orders
  So that I only pay for what I still want

  Scenario: Customer places an order
    Given a signed-in customer
    When the customer places an order for 2 items
    Then the order is created with status "PENDING"

  Scenario: An order without items is rejected
    Given a signed-in customer
    When the customer places an order with no items
    Then the request is rejected because items are required

  Scenario: An anonymous visitor cannot place an order
    Given a visitor who is not signed in
    When the visitor places an order for 1 item
    Then the request is denied as unauthorized

  Scenario: Customer cancels a pending order
    Given a pending order
    When the customer cancels the order
    Then the order status is "CANCELLED"

  Scenario: Cancelling an unknown order fails
    When the customer cancels an order that does not exist
    Then the request fails with order not found
