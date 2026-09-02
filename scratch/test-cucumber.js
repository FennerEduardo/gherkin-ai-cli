const { generateMessages } = require('@cucumber/gherkin');
const { IdGenerator } = require('@cucumber/messages');

const gherkinText = `
Feature: Test
  Scenario: Simple
    Given a thing
`;

try {
  const options = {
    includeSource: false,
    includeGherkinDocument: true,
    includePickles: true,
    newId: IdGenerator.uuid(),
  };

  const msgs = generateMessages(gherkinText, 'test.feature', 'text/x.cucumber.gherkin+plain', options);
  console.log("Success:", JSON.stringify(msgs[0].gherkinDocument.feature, null, 2));
} catch (e) {
  console.log("Error:", e.stack);
}
