import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { StepIndexer } from '../../src/core/step-indexer';
import { stepPatternToRegExp, undefinedSteps } from '../../src/core/step-coverage';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'golden', 'implemented-spring-service');
const stepsOf = (text: string) => {
  const parsed = parseGherkinText(text);
  return [...(parsed.background ? [parsed.background] : []), ...parsed.scenarios].flatMap(s => s.steps);
};

describe('step coverage (E-11)', () => {
  it('converts Cucumber expressions and regular expressions', () => {
    const cases: [string, string, boolean][] = [
      ['the teacher {string} grades {string}', 'the teacher "t-7" grades "sub-1"', true],
      ['a score of {int} out of {int}', 'a score of 87 out of 100', true],
      ['a score of {int} out of {int}', 'a score of high out of 100', false],
      ['the grade(s) is/are published', 'the grades are published', true],
      ['the grade(s) is/are published', 'the grade is published', true],
      ['^the order is (\\w+)$', 'the order is PAID', true],
      ['/^the cart has (\\d+) items?$/', 'the cart has 3 items', true],
      ['an amount of {float}', 'an amount of 12.50', true]
    ];
    for (const [pattern, text, matches] of cases) expect(stepPatternToRegExp(pattern)!.test(text), `${pattern} ~ ${text}`).toBe(matches);
  });

  it('every step of the LMS assessment feature has a definition (its suite passes 7/7)', () => {
    const feature = fs.readFileSync(path.join(FIXTURE, 'features', 'grade_publication.feature'), 'utf8');
    const definitions = new StepIndexer().getAllSteps(FIXTURE);
    expect(definitions.length).toBeGreaterThan(0);
    expect(undefinedSteps(stepsOf(feature), definitions)).toEqual([]);
  });

  it('reports a step reworded in the feature only', () => {
    const feature = fs.readFileSync(path.join(FIXTURE, 'features', 'grade_publication.feature'), 'utf8')
      .replace('When the teacher publishes the grade of "sub-1"', 'When the teacher releases the grade of "sub-1"');
    expect(undefinedSteps(stepsOf(feature), new StepIndexer().getAllSteps(FIXTURE))).toEqual(['When the teacher releases the grade of "sub-1"']);
  });

  it('does not apply without step definitions', () => {
    expect(undefinedSteps([{ keyword: 'Given', text: 'a cart' }], [])).toBeUndefined();
  });
});
