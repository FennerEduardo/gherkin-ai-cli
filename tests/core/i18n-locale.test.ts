import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getProjectLocale, resolveLocale, tf } from '../../src/utils/i18n-cli';
import { validateFinancialGates } from '../../src/core/validators/financial-gates';

describe('CLI locale', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-locale-'));
    cwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('honours the project locale when GHK_LOCALE is not set', () => {
    fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ locale: 'es' }));
    vi.stubEnv('GHK_LOCALE', '');
    expect(getProjectLocale(process.cwd())).toBe('es');
    expect(resolveLocale()).toBe('es');
    expect(tf('valFinancialCardData', { line: 3, file: 'a.ts' })).toContain('línea 3 de a.ts');
  });

  it('GHK_LOCALE wins over the project locale', () => {
    fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ locale: 'es' }));
    vi.stubEnv('GHK_LOCALE', 'en');
    expect(resolveLocale()).toBe('en');
  });

  it('validators speak one language at a time', () => {
    const result = validateFinancialGates({ files: [{ path: 'pay.ts', content: 'const cardNumber = req.body.cardNumber;' }], rules: ['financial'] } as any);
    for (const msg of [...result.errors, ...result.warnings]) {
      expect(msg).not.toMatch(/ \/ /);
    }
  });
});
