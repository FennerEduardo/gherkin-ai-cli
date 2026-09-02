Feature: User Authentication

  As a registered user
  I want to log into the application
  So that I can access my dashboard

  Scenario: Successful login with valid credentials
    Given I navigate to the login page
    When I type my credentials
      | email             | password     |
      | user@example.com  | SecureP@ss1  |
    And I click the "Login" button
    Then I should be redirected to the dashboard
    And I should see a welcome message "Welcome, user!"

  Scenario: Unsuccessful login with invalid password
    Given I navigate to the login page
    When I type my credentials
      | email             | password     |
      | user@example.com  | wrongpass    |
    And I click the "Login" button
    Then I should see an error message "Invalid email or password"
