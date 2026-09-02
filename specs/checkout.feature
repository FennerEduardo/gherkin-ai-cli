Feature: Checkout Process

  As a customer
  I want to checkout my shopping cart
  So that I can purchase the items I selected

  Scenario: Complete checkout with credit card
    Given I have items in my shopping cart
    And I proceed to the checkout page
    When I fill in my shipping details
    And I select "Credit Card" as payment method
    And I confirm the order
    Then my payment should be processed successfully
    And I should see an order confirmation page
