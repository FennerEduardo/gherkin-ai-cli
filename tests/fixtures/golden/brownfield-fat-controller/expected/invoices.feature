# Written by hand, from the product's point of view, before reading the proposals (golden G-R2).
Feature: Invoices
  As an accountant
  I want to issue, collect and void invoices
  So that what customers owe is always right

  Scenario: Issue an invoice
    Given a signed-in accountant
    When the accountant issues an invoice for 120.00
    Then the invoice is issued
    And the invoice status is "ISSUED"

  Scenario: Pay an issued invoice
    Given an invoice with status "ISSUED"
    When the customer pays the invoice
    Then the invoice is paid
    And the invoice status is "PAID"

  Scenario: A paid invoice cannot be voided
    Given an invoice with status "PAID"
    When the accountant voids the invoice
    Then the void is refused

  Scenario: Void an issued invoice
    Given an invoice with status "ISSUED"
    When the accountant voids the invoice
    Then the invoice is voided
    And the invoice status is "VOIDED"
