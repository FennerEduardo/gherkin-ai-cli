# Written by hand (golden G-R1).
Feature: Stock
  As the warehouse
  I want stock reserved for every placed order
  So that what is sold can be shipped

  Scenario: Reserve stock for a placed order
    Given an order was placed
    When the warehouse reserves stock for the order
    Then the stock is reserved
    And the stock status is "RESERVED"
