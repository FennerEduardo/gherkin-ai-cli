import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { kernelPendingMerge, planWrites, sha256, IMPLEMENTED_MARKER } from '../../src/core/write-protection';

describe('planWrites', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-protect-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const put = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  const plan = (artifacts: { filePath: string; content: string }[], extra: Partial<Parameters<typeof planWrites>[1]> = {}) =>
    Object.fromEntries(planWrites(artifacts, { cwd: dir, outputDir: 'out', inventory: [], ...extra }).map(p => [p.filePath, p]));

  it('creates new files and skips identical ones', () => {
    put('out/same.ts', 'x');
    const p = plan([{ filePath: 'new.ts', content: 'a' }, { filePath: 'same.ts', content: 'x' }]);
    expect(p['new.ts'].action).toBe('create');
    expect(p['same.ts'].action).toBe('unchanged');
  });

  it('updates a file that still matches its recorded checksum', () => {
    put('out/a.ts', 'v1');
    const p = plan([{ filePath: 'a.ts', content: 'v2' }], { inventory: [{ filePath: 'a.ts', checksum: sha256('v1') }] });
    expect(p['a.ts'].action).toBe('update');
    expect(p['a.ts'].target).toBe(path.join(dir, 'out', 'a.ts'));
  });

  it('updates a generated file that git checked out with CRLF line endings (autocrlf)', () => {
    put('out/a.ts', 'line 1\r\nline 2\r\n');
    const p = plan([{ filePath: 'a.ts', content: 'v2' }], { inventory: [{ filePath: 'a.ts', checksum: sha256('line 1\nline 2\n') }] });
    expect(p['a.ts'].action).toBe('update');
  });

  it('keeps an edited file and writes the new version beside it', () => {
    put('out/a.ts', 'v1 + implementation');
    const p = plan([{ filePath: 'a.ts', content: 'v2' }], { inventory: [{ filePath: 'a.ts', checksum: sha256('v1') }] });
    expect(p['a.ts'].action).toBe('side-by-side');
    expect(p['a.ts'].target).toBe(path.join(dir, 'out', 'a.ts.ghk-new'));
  });

  it('--force overwrites edited files', () => {
    put('out/a.ts', 'edited');
    expect(plan([{ filePath: 'a.ts', content: 'v2' }], { force: true, inventory: [{ filePath: 'a.ts', checksum: sha256('v1') }] })['a.ts'].action).toBe('overwrite');
  });

  it('honours generation.protect globs from the project root', () => {
    put('out/src/domain/order.ts', 'v1');
    const p = plan([{ filePath: 'src/domain/order.ts', content: 'v2' }], { protect: ['./out/src/domain/**'], inventory: [{ filePath: 'src/domain/order.ts', checksum: sha256('v1') }] });
    expect(p['src/domain/order.ts'].action).toBe('side-by-side');
    expect(p['src/domain/order.ts'].reason).toContain('generation.protect');
  });

  it('honours the .ghk-implemented marker for files it cannot prove unedited', () => {
    put(IMPLEMENTED_MARKER, 'implemented');
    put('out/a.ts', 'v1');
    put('out/c.ts', 'implemented by hand');
    const p = plan([{ filePath: 'a.ts', content: 'v2' }, { filePath: 'b.ts', content: 'new' }, { filePath: 'c.ts', content: 'v2' }],
      { inventory: [{ filePath: 'a.ts', checksum: sha256('v1') }] });
    expect(p['a.ts'].action).toBe('update'); // checksum proves it is still the generated version
    expect(p['b.ts'].action).toBe('skipped'); // scaffolding is not created in an implemented project
    expect(p['c.ts'].action).toBe('side-by-side');
    expect(p['c.ts'].reason).toContain('.ghk-implemented');
  });

  it('in an implemented project creates only the kernel and the contracts, unless --include-scaffold', () => {
    put(IMPLEMENTED_MARKER, 'implemented');
    const files = [
      'src/main/java/acme/runtime/OutboxRelay.java',
      'src/main/java/acme/domain/OrderAggregate.java',
      'contracts/orders/openapi.json',
      'src/main/java/acme/runtime/RuntimeConfiguration.java',
      'src/main/java/acme/api/HealthController.java',
      'src/main/resources/application.properties'
    ].map(filePath => ({ filePath, content: 'x' }));
    const actions = (extra = {}) => Object.values(plan(files, extra)).map(p => `${p.action} ${p.role} ${p.filePath}`);
    expect(actions()).toEqual([
      'create kernel src/main/java/acme/runtime/OutboxRelay.java',
      'create kernel src/main/java/acme/domain/OrderAggregate.java',
      'create contract contracts/orders/openapi.json',
      'skipped wiring src/main/java/acme/runtime/RuntimeConfiguration.java',
      'skipped scaffold src/main/java/acme/api/HealthController.java',
      'skipped scaffold src/main/resources/application.properties'
    ]);
    expect(actions({ includeScaffold: true }).every(a => a.startsWith('create'))).toBe(true);
  });

  it('does not create application.properties next to an application.yml (#7)', () => {
    put('out/src/main/resources/application.yml', 'server:\n  port: 8080\n');
    const p = plan([{ filePath: 'src/main/resources/application.properties', content: 'server.port=9090' }, { filePath: 'other/application.properties', content: 'a=1' }]);
    expect(p['src/main/resources/application.properties']).toMatchObject({ action: 'skipped', reason: expect.stringContaining('application.yml') });
    expect(p['other/application.properties'].action).toBe('create');
  });

  it('generation.exclude skips creates, updates and side-by-side versions', () => {
    put('out/gen/a.ts', 'v1');
    put('out/gen/b.ts', 'edited');
    const p = plan([{ filePath: 'gen/a.ts', content: 'v2' }, { filePath: 'gen/b.ts', content: 'v2' }, { filePath: 'gen/c.ts', content: 'new' }, { filePath: 'other.ts', content: 'new' }],
      { exclude: ['out/gen/**'], inventory: [{ filePath: 'gen/a.ts', checksum: sha256('v1') }, { filePath: 'gen/b.ts', checksum: sha256('v1') }] });
    for (const f of ['gen/a.ts', 'gen/b.ts', 'gen/c.ts']) expect(p[f].action, f).toBe('skipped');
    expect(p['other.ts'].action).toBe('create');
  });

  it('holds new and updated source files as .ghk-new while a kernel file is kept', () => {
    put('out/src/runtime/relay.ts', 'edited kernel');
    put('out/src/api/routes.ts', 'v1');
    const p = plan([
      { filePath: 'src/runtime/relay.ts', content: 'new kernel' },
      { filePath: 'src/runtime/broker.ts', content: 'new kernel file' },
      { filePath: 'src/api/routes.ts', content: 'v2' },
      { filePath: 'seed.sql', content: 'insert' }
    ], { inventory: [{ filePath: 'src/runtime/relay.ts', checksum: sha256('kernel v1') }, { filePath: 'src/api/routes.ts', checksum: sha256('v1') }] });
    expect(p['src/runtime/relay.ts'].action).toBe('side-by-side');
    expect(p['src/runtime/relay.ts'].held).toBeUndefined();
    expect(p['src/runtime/broker.ts']).toMatchObject({ action: 'side-by-side', held: true, target: path.join(dir, 'out', 'src/runtime/broker.ts.ghk-new') });
    expect(p['src/api/routes.ts']).toMatchObject({ action: 'side-by-side', held: true });
    expect(p['seed.sql'].action).toBe('create'); // not source code: cannot break the build
    expect(kernelPendingMerge(Object.values(p)).map(x => x.filePath)).toEqual(['src/runtime/relay.ts']);
  });

  it('without a checksum, overwrites only files that carry the generated header (when headers are trusted)', () => {
    put('out/gen.ts', '// Generated by gherkin-ai CLI v2.6.0\nold');
    put('out/mine.ts', 'hand written');
    const p = plan([{ filePath: 'gen.ts', content: 'new' }, { filePath: 'mine.ts', content: 'new' }], { trustHeaders: true });
    expect(p['gen.ts'].action).toBe('overwrite');
    expect(p['mine.ts'].action).toBe('side-by-side');
  });

  it('in a fresh clone without an inventory, a generated header is not proof enough (M-09)', () => {
    put('out/gen.ts', '// Generated by gherkin-ai CLI v3.1.0\nedited after generation');
    expect(plan([{ filePath: 'gen.ts', content: 'new' }])['gen.ts']).toMatchObject({ action: 'side-by-side', reason: expect.stringContaining('no inventory') });
    // With an inventory, a file it does not list (generated before checksums) still goes by its header.
    expect(plan([{ filePath: 'gen.ts', content: 'new' }], { inventory: [{ filePath: 'other.ts', checksum: sha256('x') }] })['gen.ts'].action).toBe('overwrite');
    expect(plan([{ filePath: 'gen.ts', content: 'new' }], { force: true })['gen.ts'].action).toBe('overwrite');
  });
});
