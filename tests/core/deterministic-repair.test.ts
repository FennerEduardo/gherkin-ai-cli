import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultConfig } from '../../src/core/config';
import { planDeterministicRepair } from '../../src/core/deterministic-repair';

const config = (language: string, framework: string) => ({ ...defaultConfig, stack: { ...defaultConfig.stack, language, framework } });
let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const ctx = (c = config('typescript', 'nestjs')) => ({ projectDir: dir ?? (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-repair-'))), config: c });

describe('deterministic repair before the LLM (4.5)', () => {
  it('restores dependencies with the toolchain command for a missing module or an out-of-sync lockfile', () => {
    expect(planDeterministicRepair("Error: Cannot find module 'pg'\nRequire stack:", ctx())).toMatchObject({
      ruleId: 'missing-dependency', command: 'npm install --no-audit --no-fund --loglevel=error'
    });
    expect(planDeterministicRepair('go: updates to go.mod needed; to update it:\n\tgo mod tidy', ctx(config('go', 'chi')))?.ruleId).toBe('lockfile-out-of-sync');
    // A relative import is a code bug, not a missing package.
    expect(planDeterministicRepair("Cannot find module './domain/order'", ctx())).toBeUndefined();
  });

  it('stops the loop for failures that are not code bugs', () => {
    expect(planDeterministicRepair('Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md).', ctx())).toMatchObject({ ruleId: 'missing-services', stop: true });
    const c = ctx();
    fs.mkdirSync(path.join(c.projectDir, 'src'));
    fs.writeFileSync(path.join(c.projectDir, 'src', 'kernel.ts.ghk-new'), 'x');
    expect(planDeterministicRepair('error TS2339: Property does not exist', c)).toMatchObject({ ruleId: 'pending-generated-versions', stop: true });
  });

  it('fires each rule once per run, then leaves the failure to the agent', () => {
    const log = "Cannot find module 'pg'";
    expect(planDeterministicRepair(log, ctx(), new Set(['missing-dependency']))).toBeUndefined();
  });
});
