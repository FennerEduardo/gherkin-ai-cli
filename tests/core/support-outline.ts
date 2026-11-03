/* Test helper: the scenario names of a candidate, with each row of a validation Scenario Outline expanded to the
   name of the case it stands for ("Placing an order is rejected when items are missing"), so assertions on the
   fields and rules read the same whether they are separate scenarios or rows of one outline (RV-07). */
import type { ScenarioCandidate } from '../../src/core/reverse/candidates';

export function expandedNames(scenarios: ScenarioCandidate[] | undefined): string[] {
  return (scenarios ?? []).flatMap(s => {
    if (!s.examples) return [s.name];
    const prefix = s.name.replace(/ a field is invalid$/, '');
    return s.examples.rows.map(r => {
      const [field, problem] = r.cells;
      return `${prefix} ${field} ${/s$/.test(field) ? 'are' : 'is'} ${problem.replace(/ \((at least|at most) [^)]+\)$/, '')}`;
    });
  });
}
