const { parseGherkinText } = require('../src/core/gherkin-parser');
const advancedSpec = `Feature: Registration
Scenario: Register
  Given an email "test@test.com" @validate:email
  And an age "25" @range(18,100)`;

const parsed = parseGherkinText(advancedSpec);
console.log(JSON.stringify(parsed.scenarios[0].steps, null, 2));
console.log("FIELDS:");
console.log(JSON.stringify(parsed.domainAnalysis.fields, null, 2));
