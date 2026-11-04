@aggregate:PaymentExecution @command:ExecutePayment @event:PaymentExecuted
Feature: Payment execution between accounts
  As a debtor
  I want to transfer money to a creditor
  So that the payment settles exactly once

  Scenario: An accepted payment
    Given a payment order of 120 COP to a valid creditor
    When the debtor executes the payment with idempotency key "pay-001"
    Then the payment is accepted
    And a PaymentExecuted event is published

  Scenario: Insufficient funds
    Given a payment order of 900 COP to a valid creditor
    When the debtor executes the payment with idempotency key "pay-002"
    Then the payment is rejected with HTTP 422
