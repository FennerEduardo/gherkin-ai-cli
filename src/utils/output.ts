/* ==========================================================================
   gherkin-ai-cli - Machine-readable output (--json)

   Contract: with --json, stdout carries exactly one JSON document.
   - Commands with structured results call emitJson(data).
   - All human output (console.log, banners, progress) is redirected to stderr.
   - If a command emits nothing, main() prints a standard envelope
     { ok, command, version, exitCode }.
   ========================================================================== */

import { format } from 'util';

let emitted = false;
let realStdoutWrite: typeof process.stdout.write | undefined;

function writeStdout(text: string): void {
  (realStdoutWrite ?? process.stdout.write.bind(process.stdout))(text);
}

/** Writes the command's structured result to stdout (exactly once per run). */
export function emitJson(data: unknown): void {
  if (emitted) return;
  emitted = true;
  writeStdout(JSON.stringify(data, null, 2) + '\n');
}

/** Writes non-JSON data (e.g. CSV/JSONL exports) to stdout and counts as the command's output. */
export function emitData(text: string): void {
  emitted = true;
  writeStdout(text);
}

export function hasEmittedOutput(): boolean {
  return emitted;
}

/** Test hook. */
export function resetOutputState(): void {
  emitted = false;
}

/**
 * Enters JSON mode: console.log/info/debug go to stderr so only emitJson/emitData reach stdout.
 * Returns a restore function.
 */
export function enterJsonMode(): () => void {
  realStdoutWrite = process.stdout.write.bind(process.stdout);
  const original = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...args: unknown[]) => { process.stderr.write(format(...args) + '\n'); };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return () => {
    Object.assign(console, original);
    realStdoutWrite = undefined;
  };
}
