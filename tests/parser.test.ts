/* ==========================================================================
   gherkin-ai-cli - Unit Tests for Parser & Engine
   ========================================================================== */

import assert from 'assert';
import { parseGherkinText } from '../src/core/gherkin-parser';
import { generateContracts } from '../src/generators/contracts';
import { defaultConfig } from '../src/core/config';

const sampleSpec = `Feature: User Login Feature
  As an authenticated user
  I want to login with email and password

  Scenario: Login success
    Given a user with email "test@example.com" exists
    When user submits email "test@example.com" and password "Pass123!"
    Then response is 200 OK
    And emits "UserLoggedIn" event
`;

console.log('Running gherkin-ai CLI unit tests...');

const parsed = parseGherkinText(sampleSpec);
assert.strictEqual(parsed.featureName, 'User Login Feature');
assert.strictEqual(parsed.scenarios.length, 1);
assert.strictEqual(parsed.scenarios[0].name, 'Login success');
assert.strictEqual(parsed.scenarios[0].steps.length, 4);

console.log('✔ AST Parser test passed!');

const { contractsTs, adrMd } = generateContracts(parsed, defaultConfig);
assert(contractsTs.includes('UserLoginFeatureCommandSchema'));
assert(adrMd.includes('ADR 001'));

console.log('✔ Contracts generator test passed!');
console.log('All tests passed successfully!');
