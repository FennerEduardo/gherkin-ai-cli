import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';
import { renderRailsApp } from '../../src/generators/kernel/ruby';
import { renderGoKernel } from '../../src/generators/kernel/go';
import { renderElixirProject } from '../../src/generators/kernel/elixir';

const STEP = 'un cliente realiza POST a `/api/v1/users/sign_in` con a|b y {x}';
const m = buildDomainModel(parseGherkinText([
  '# language: es',
  'Característica: Autenticación',
  '  Escenario: Login',
  `    Dado ${STEP}`,
  '    Entonces responde 200'
].join('\n')));
const all = (files: { content: string }[]) => files.map(f => f.content).join('\n');
// The literal's body must be a regex (same escape syntax in JS for these characters) that matches the step text.
const matchesStep = (body: string) => expect(new RegExp(body).test(STEP), body).toBe(true);
// A delimiter inside the body must be preceded by an odd number of backslashes.
const delimiterEscaped = (body: string, d: string) => {
  for (const hit of body.matchAll(new RegExp(`(\\\\*)\\${d}`, 'g'))) expect(hit[1].length % 2, body).toBe(1);
};

describe('step regex literals survive special characters in step text', () => {
  it('Ruby /…/ literal', () => {
    const body = all(renderRailsApp(m, 'Demo')).match(/Given\(\/(.*)\/\) do/)![1];
    delimiterEscaped(body, '/');
    matchesStep(body);
  });

  it('Elixir ~r|…| sigil', () => {
    const body = all(renderElixirProject(m, { otp: 'demo', mod: 'Demo' }, 'features/a.feature')).match(/~r\|(\^un cliente.*?\$)\|/)![1];
    delimiterEscaped(body, '|');
    matchesStep(body);
  });

  it('Go raw-string literal', () => {
    const body = all(renderGoKernel(m, 'example.com/demo')).match(/sc\.Step\(`(\^un cliente[^`]*)`/)![1];
    matchesStep(body);
  });
});
