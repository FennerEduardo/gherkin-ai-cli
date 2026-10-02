Feature: Checkout
  As a customer
  I want to pay for my cart
  So that I receive my order

  Scenario: Successful payment
    Given a cart with 2 items
    When the customer pays with a valid card
    Then the order is confirmed
