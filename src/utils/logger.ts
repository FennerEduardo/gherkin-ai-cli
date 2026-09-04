/* ==========================================================================
   gherkin-ai-cli - Logger Utility (English CLI Output)
   ========================================================================== */

const pkg = require('../../package.json');

export const logger = {
  verboseMode: false,
  debugMode: false,
  jsonMode: false,

  configure(opts: { verbose?: boolean; debug?: boolean; json?: boolean }) {
    this.verboseMode = opts.verbose || false;
    this.debugMode = opts.debug || false;
    this.jsonMode = opts.json || false;
  },

  verbose(message: string): void {
    if (this.verboseMode && !this.jsonMode) console.log(`\x1b[90m[VERBOSE] ${message}\x1b[0m`);
  },

  debug(message: string): void {
    if (this.debugMode && !this.jsonMode) console.log(`\x1b[90m[DEBUG] ${message}\x1b[0m`);
  },

  info(message: string): void {
    if (!this.jsonMode) console.log(`\x1b[36mℹ\x1b[0m ${message}`);
  },
  
  success(message: string): void {
    if (!this.jsonMode) console.log(`\x1b[32m✔\x1b[0m ${message}`);
  },
  
  warn(message: string): void {
    if (!this.jsonMode) console.warn(`\x1b[33m⚠\x1b[0m ${message}`);
  },
  
  error(message: string): void {
    if (!this.jsonMode) console.error(`\x1b[31m✖\x1b[0m ${message}`);
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
