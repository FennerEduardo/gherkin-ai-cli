/* ==========================================================================
   gherkin-ai-cli - Logger Utility (English CLI Output)

   - Levels: silent < error < warn < info < verbose < debug
     (--quiet → warn, --verbose → verbose, GHK_LOG_LEVEL / logging.level override)
   - With --json, stdout is reserved for the JSON result: info/success are
     suppressed and warn/error go to stderr.
   - File logging is opt-in (logging.file / GHK_LOG_FILE), size-rotated and
     always redacted.
   - Honors NO_COLOR and non-TTY output.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { CLI_VERSION } from '../version';
import { redactSensitive } from '../core/security';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'verbose' | 'debug';

const LEVEL_RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, verbose: 4, debug: 5 };

export interface LoggerOptions {
  verbose?: boolean;
  debug?: boolean;
  quiet?: boolean;
  json?: boolean;
  level?: LogLevel;
  file?: string;
  maxSizeMb?: number;
  maxFiles?: number;
  executionId?: string;
}

function useColor(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb') return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY);
}

function paint(code: string, text: string, stream: NodeJS.WriteStream): string {
  return useColor(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function envLevel(): LogLevel | undefined {
  const raw = (process.env.GHK_LOG_LEVEL || process.env.LOG_LEVEL || '').toLowerCase();
  return raw in LEVEL_RANK ? (raw as LogLevel) : undefined;
}

export const logger = {
  verboseMode: false,
  debugMode: false,
  jsonMode: false,
  level: 'info' as LogLevel,
  file: undefined as string | undefined,
  maxSizeBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  executionId: undefined as string | undefined,

  configure(opts: LoggerOptions) {
    let level: LogLevel = opts.level ?? envLevel() ?? 'info';
    if (opts.quiet) level = 'warn';
    if (opts.verbose && LEVEL_RANK[level] < LEVEL_RANK.verbose) level = 'verbose';
    if (opts.debug) level = 'debug';
    this.level = level;
    this.verboseMode = LEVEL_RANK[level] >= LEVEL_RANK.verbose;
    this.debugMode = level === 'debug';
    this.jsonMode = opts.json ?? this.jsonMode;
    if (opts.file !== undefined) this.file = opts.file || undefined;
    if (opts.maxSizeMb) this.maxSizeBytes = opts.maxSizeMb * 1024 * 1024;
    if (opts.maxFiles) this.maxFiles = opts.maxFiles;
    if (opts.executionId !== undefined) this.executionId = opts.executionId;
  },

  enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    const effective = envLevel() === 'silent' ? 'silent' : this.level;
    return LEVEL_RANK[effective] >= LEVEL_RANK[level];
  },

  _rotateIfNeeded(file: string) {
    try {
      if (fs.statSync(file).size < this.maxSizeBytes) return;
    } catch {
      return;
    }
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i}`);
    }
  },

  _logToFile(level: string, message: string) {
    if (!this.file) return;
    try {
      const file = path.resolve(this.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this._rotateIfNeeded(file);
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        executionId: this.executionId,
        version: CLI_VERSION,
        level,
        message: redactSensitive(message)
      });
      fs.appendFileSync(file, entry + '\n', { mode: 0o600 });
    } catch {
      // Logging must never break the command.
    }
  },

  _out(level: Exclude<LogLevel, 'silent'>, prefix: string, color: string, message: string) {
    this._logToFile(level.toUpperCase(), message);
    if (!this.enabled(level)) return;
    const toStderr = level === 'error' || level === 'warn' || this.jsonMode;
    if (this.jsonMode && (level === 'info' || level === 'verbose' || level === 'debug')) return;
    const stream = toStderr ? process.stderr : process.stdout;
    const line = `${paint(color, prefix, stream)} ${message}`;
    if (toStderr) console.error(line);
    else console.log(line);
  },

  verbose(message: string): void {
    this._out('verbose', '[VERBOSE]', '90', message);
  },

  debug(message: string): void {
    this._out('debug', '[DEBUG]', '90', message);
  },

  info(message: string): void {
    this._out('info', 'ℹ', '36', message);
  },

  success(message: string): void {
    this._logToFile('SUCCESS', message);
    if (!this.enabled('info') || this.jsonMode) return;
    console.log(`${paint('32', '✔', process.stdout)} ${message}`);
  },

  warn(message: string): void {
    this._out('warn', '⚠', '33', message);
  },

  error(message: string): void {
    this._out('error', '✖', '31', message);
  },

  banner(): void {
    if (this.jsonMode || !this.enabled('info')) return;
    console.log(`
${paint('35', `🥒 gherkin-ai CLI v${CLI_VERSION}`, process.stdout)}
${paint('90', 'Executable Prompt & Contract Generator for AI Coding Agents', process.stdout)}
${paint('90', 'Website: https://fennereduardo.com/pages/GherkinIATool/', process.stdout)}
`);
  }
};
