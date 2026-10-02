Feature: Payment Processing
  As a customer
  I want to pay my order
  So that the order is confirmed

  Scenario: Successful card payment
    Given an order with amount 100
    When the customer pays with a valid card
    Then the payment is approved
    And a PaymentApproved event is published

  Scenario: Declined card
    Given an order with amount 250
    When the customer pays with an expired card
    Then the payment is rejected with HTTP 422
