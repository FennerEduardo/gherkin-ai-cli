Feature: Refund Processing
  As a support agent
  I want to refund a paid order
  So that the customer gets the money back

  Scenario: Approved refund
    Given a paid order of 80
    When the agent issues a refund for the order
    Then the refund is issued
    And a RefundIssued event is published
