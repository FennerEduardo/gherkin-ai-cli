/* ==========================================================================
   gherkin-ai-cli - Logger Utility (English CLI Output)
   ========================================================================== */

export const logger = {
  info(message: string): void {
    console.log(`\x1b[36mℹ\x1b[0m ${message}`);
  },
  
  success(message: string): void {
    console.log(`\x1b[32m✔\x1b[0m ${message}`);
  },
  
  warn(message: string): void {
    console.warn(`\x1b[33m⚠\x1b[0m ${message}`);
  },
  
  error(message: string): void {
    console.error(`\x1b[31m✖\x1b[0m ${message}`);
  },

  banner(): void {
    console.log(`
\x1b[35m🥒 gherkin-ai CLI v1.0.0\x1b[0m
\x1b[90mExecutable Prompt & Contract Generator for AI Coding Agents\x1b[0m
\x1b[90mWebsite: https://fennereduardo.com/pages/GherkinIATool/\x1b[0m
`);
  }
};
