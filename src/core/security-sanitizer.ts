/* ==========================================================================
   gherkin-ai-cli - Security Sanitizer (Prompt Injection & Secret Defense)
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
  /curl\s+.*http/i,
  /wget\s+.*http/i,
  /print\s+your\s+instructions/i,
  /disregard\s+the\s+above/i
];

const SECRET_PATTERNS = [
  /-----BEGIN\s+[A-Z\s]+KEY-----/i,               // PEM / Private Keys
  /AKIA[0-9A-Z]{16}/,                              // AWS Access Key ID
  /sk-[a-zA-Z0-9_-]{32,}/,                          // OpenAI / Stripe Secret Key
  /sk-ant-api[a-zA-Z0-9_-]{32,}/,                   // Anthropic API Key
  /ghp_[a-zA-Z0-9]{36}/,                            // GitHub Personal Access Token
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}/,  // JWT Token string
  /mongodb(?:\+srv)?:\/\/[^\s"']+/i,                 // MongoDB Connection string with pass
  /postgres(?:ql)?:\/\/[^\s"']+/i                   // Postgres Connection string with pass
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

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return {
        isSafe: false,
        reason: `Potential hardcoded secret or token detected matching pattern -> ${pattern.toString()}`
      };
    }
  }

  return { isSafe: true };
}

export function calculateShannonEntropy(str: string): number {
  if (!str) return 0;
  const frequencies: Record<string, number> = {};
  for (const char of str) {
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in frequencies) {
    const p = frequencies[char] / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function isHighEntropySecret(token: string, threshold = 3.8): boolean {
  if (token.length < 20) return false;
  return calculateShannonEntropy(token) >= threshold;
}
