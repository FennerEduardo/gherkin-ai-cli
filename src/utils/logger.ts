/* ==========================================================================
   gherkin-ai-cli - Logger Utility (English CLI Output)
   ========================================================================== */

const pkg = require('../../package.json');

export const logger = {
  verboseMode: false,
  debugMode: false,
  jsonMode: false,
  executionId: undefined as string | undefined,

  configure(opts: { verbose?: boolean; debug?: boolean; json?: boolean; executionId?: string }) {
    this.verboseMode = opts.verbose || false;
    this.debugMode = opts.debug || false;
    this.jsonMode = opts.json || false;
    this.executionId = opts.executionId;
  },

  _logToFile(level: string, message: string) {
    try {
      const fs = require('fs');
      const path = require('path');
      const logDir = path.resolve(process.cwd(), '.ghe', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'execution.log.jsonl');
      const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        executionId: this.executionId,
        level,
        message
      });
      fs.appendFileSync(logFile, logEntry + '\n');
    } catch (e) {
      // Silently fail if cannot log to file
    }
  },

  verbose(message: string): void {
    this._logToFile('VERBOSE', message);
    if (this.verboseMode && !this.jsonMode) console.log(`\x1b[90m[VERBOSE] ${message}\x1b[0m`);
  },

  debug(message: string): void {
    this._logToFile('DEBUG', message);
    if (this.debugMode && !this.jsonMode) console.log(`\x1b[90m[DEBUG] ${message}\x1b[0m`);
  },

  info(message: string): void {
    this._logToFile('INFO', message);
    if (!this.jsonMode && process.env.LOG_LEVEL !== 'silent') console.log(`\x1b[36mℹ\x1b[0m ${message}`);
  },
  
  success(message: string): void {
    this._logToFile('SUCCESS', message);
    if (!this.jsonMode && process.env.LOG_LEVEL !== 'silent') console.log(`\x1b[32m✔\x1b[0m ${message}`);
  },
  
  warn(message: string): void {
    this._logToFile('WARN', message);
    if (!this.jsonMode && process.env.LOG_LEVEL !== 'silent') console.warn(`\x1b[33m⚠\x1b[0m ${message}`);
  },
  
  error(message: string): void {
    this._logToFile('ERROR', message);
    if (!this.jsonMode && process.env.LOG_LEVEL !== 'silent') console.error(`\x1b[31m✖\x1b[0m ${message}`);
  },

  banner(): void {
    if (this.jsonMode) return;
    console.log(`
\x1b[35m🥒 gherkin-ai CLI v${pkg.version || '1.1.0'}\x1b[0m
\x1b[90mExecutable Prompt & Contract Generator for AI Coding Agents\x1b[0m
\x1b[90mWebsite: https://fennereduardo.com/pages/GherkinIATool/\x1b[0m
`);
  }
};
