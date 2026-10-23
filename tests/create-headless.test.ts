import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseGherkinText } from '../src/core/gherkin-parser';

// A Spanish CLI locale, without saving it to the user's global configuration.
vi.mock('../src/utils/i18n-cli', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/utils/i18n-cli')>()),
  ensureCliLanguage: async () => 'es'
}));

import { handleCreateCommand } from '../src/commands/create';

describe('ghk create --headless', () => {
  let dir: string;
  const write = (name: string, data: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
  };

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-create-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes English Gherkin by default, whatever the CLI locale', async () => {
    const config = write('en.json', {
      featureName: 'Two-factor authentication',
      actor: 'authenticated user', action: 'verify a one-time code', outcome: 'my account is protected',
      scenarioName: 'Verify a one-time code',
      steps: [{ keyword: 'Given', text: 'the user has signed in' }, { keyword: 'When', text: 'the user enters a valid code' }, { keyword: 'Then', text: 'the session is verified' }]
    });
    const output = path.join(dir, 'en.feature');
    await handleCreateCommand({ headless: true, config, output });

    const text = fs.readFileSync(output, 'utf8');
    expect(text.startsWith('Feature: Two-factor authentication')).toBe(true);
    const parsed = parseGherkinText(text);
    expect(parsed.featureName).toBe('Two-factor authentication');
    expect(parsed.scenarios[0].steps).toHaveLength(3);
  });

  it('writes a Spanish feature with its dialect header when the JSON asks for it', async () => {
    const config = write('es.json', {
      language: 'es', featureName: 'Ejecución de pagos', actor: 'Debtor', action: 'ejecutar un pago', outcome: 'se liquide una vez',
      scenarioName: 'Pago aceptado',
      steps: [{ keyword: 'Dado', text: 'una cuenta con saldo' }, { keyword: 'Cuando', text: 'el Debtor ejecuta el pago' }, { keyword: 'Entonces', text: 'el pago queda aceptado' }]
    });
    const output = path.join(dir, 'es.feature');
    await handleCreateCommand({ headless: true, config, output });

    const text = fs.readFileSync(output, 'utf8');
    expect(text.startsWith('# language: es\nCaracterística: Ejecución de pagos')).toBe(true);
    const parsed = parseGherkinText(text);
    expect(parsed.featureName).toBe('Ejecución de pagos');
    expect(parsed.scenarios[0].steps).toHaveLength(3);
  });
});
