/* ==========================================================================
   gherkin-ai-cli - MCP stdout guard

   On a stdio MCP server, stdout carries JSON-RPC frames only. Command
   handlers print with console.log, which would corrupt the protocol stream.
   The guard:
   - gives the MCP transport a private writer bound to the real stdout,
   - redirects every other stdout write to stderr, or into a capture buffer
     while a tool is running, so the output can be returned to the client.
   Tool runs are serialized so captures never interleave.
   ========================================================================== */

import { Writable } from 'stream';
import { format } from 'util';

type WriteFn = typeof process.stdout.write;

export interface StdoutGuard {
  /** Writable for the MCP transport; writes straight to the real stdout. */
  transportStdout: Writable;
  /** Runs `fn` exclusively, capturing everything it prints to stdout/console. Never rejects. */
  capture<T>(fn: () => Promise<T>): Promise<CaptureResult<T>>;
  restore(): void;
}

export type CaptureResult<T> = { ok: true; result: T; output: string } | { ok: false; error: unknown; output: string };

const ANSI = /\x1b\[[0-9;]*m/g;

export function installStdoutGuard(): StdoutGuard {
  const realWrite: WriteFn = process.stdout.write.bind(process.stdout);
  const stderrWrite: WriteFn = process.stderr.write.bind(process.stderr);
  let buffer: string[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const guardedWrite = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    const callback = (typeof encodingOrCb === 'function' ? encodingOrCb : cb) as ((err?: Error) => void) | undefined;
    if (buffer) {
      buffer.push(text);
      callback?.();
      return true;
    }
    return stderrWrite(text, callback as never);
  }) as WriteFn;

  // stderr (warnings/errors) is captured too so the client sees why a tool failed, and still mirrored to the real stderr.
  const guardedStderr = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
    if (buffer) buffer.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return stderrWrite(chunk as string, encodingOrCb as never, cb as never);
  }) as WriteFn;

  process.stdout.write = guardedWrite;
  process.stderr.write = guardedStderr;

  // Console methods may be bound to other sinks (test runners, embedders); route them explicitly.
  const originalConsole = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  const toStdout = (...args: unknown[]) => { guardedWrite(format(...args) + '\n'); };
  const toStderr = (...args: unknown[]) => { guardedStderr(format(...args) + '\n'); };
  console.log = toStdout;
  console.info = toStdout;
  console.debug = toStdout;
  console.warn = toStderr;
  console.error = toStderr;

  const transportStdout = new Writable({
    write(chunk, _encoding, callback) {
      realWrite(chunk, callback as never);
    }
  });

  return {
    transportStdout,
    capture<T>(fn: () => Promise<T>) {
      const run = async (): Promise<CaptureResult<T>> => {
        buffer = [];
        const output = () => (buffer ?? []).join('').replace(ANSI, '');
        try {
          const result = await fn();
          return { ok: true, result, output: output() };
        } catch (error) {
          return { ok: false, error, output: output() };
        } finally {
          buffer = null;
        }
      };
      const next = queue.then(run, run);
      queue = next;
      return next;
    },
    restore() {
      process.stdout.write = realWrite;
      process.stderr.write = stderrWrite;
      Object.assign(console, originalConsole);
    }
  };
}
