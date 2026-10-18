import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePrompts } from '../../src/generators/prompts';

let dir: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('step definitions dictionary in the QA prompt', () => {
  it('names step files relative to the project, never by the local absolute path', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-steps-'));
    fs.mkdirSync(path.join(dir, 'tests', 'steps'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'steps', 'cart.steps.ts'), "Given('the cart is empty', () => {});\n");
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const parsed = parseGherkinText(['Feature: Cart', '  Scenario: Empty', '    Given the cart is empty', '    Then nothing is due'].join('\n'));
    const qa = generatePrompts(parsed, defaultConfig)['qa-agent.md'];
    expect(qa).toContain('the cart is empty` (found in tests/steps/cart.steps.ts)');
    expect(qa).not.toContain(dir);
  });
});
