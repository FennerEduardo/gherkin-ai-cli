/* ==========================================================================
   gherkin-ai-cli - Security Sanitizer (Prompt Injection Defense)
   ========================================================================== */

export interface SecuritySanitizationResult {
  isSafe: boolean;
  reason?: string;
}

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+above/i,
  /system\s+prompt/i,
  /you\s+are\s+now/i,
  /new\s+instructions/i,
  /forget\s+(all\s+)?previous/i,
  /bypass\s+rules/i,
  /rm\s+-rf/i,
  /curl\s+/i,
  /wget\s+/i,
  /print\s+your\s+instructions/i,
  /disregard\s+the\s+above/i
];

export function detectPromptInjection(text: string): SecuritySanitizationResult {
  if (!text) return { isSafe: true };

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return {
        isSafe: false,
        reason: `Potential Prompt Injection detected: Input matches forbidden pattern -> ${pattern.toString()}`
      };
    }
  }

  return { isSafe: true };
}
