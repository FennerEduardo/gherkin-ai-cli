Feature: Login
  As a registered user
  I want to sign in
  So that I can access my account

  Scenario: Successful login
    Given a registered user with email "ana@example.com"
    When the user signs in with valid credentials
    Then the user is authenticated
