@aggregate:Invoice @command:PayInvoice @event:InvoicePaid
Feature: Invoice
  As a customer
  I want to pay an invoice

  Scenario: Pay an invoice
    Given an open invoice
    When the customer pays the invoice
    Then the invoice is paid
