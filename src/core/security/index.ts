/* ==========================================================================
   gherkin-ai-cli - Security: secret/PII detection, redaction, prompt-injection

   Single source of truth for detection patterns. Used by:
   - the LLM layer (redact before sending prompts to any provider)
   - the logger (redact before writing log files)
   - generate / autopilot / MCP (prompt-injection checks on spec input)
   ========================================================================== */

export interface NamedPattern {
  name: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: NamedPattern[] = [
  { name: 'Private Key', pattern: /-----BEGIN\s+[A-Z\s]*PRIVATE KEY-----[\s\S]*?(?:-----END\s+[A-Z\s]*PRIVATE KEY-----|$)/g },
  { name: 'AWS Access Key', pattern: /(?:AKIA|ASIA|A3T[A-Z0-9])[A-Z0-9]{16}/g },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|secretAccessKey)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  { name: 'Anthropic Key', pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  { name: 'OpenAI API Key', pattern: /sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g },
  { name: 'Google API Key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'GitHub Token', pattern: /(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { name: 'Slack Token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'JWT Token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g },
  // Only URLs that embed credentials (user:password@ or :password@) are secrets; amqp://rabbitmq:5672 is not.
  { name: 'Database URL', pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s'"/@:]*:[^\s'"/@]+@[^\s'"]+/gi },
  { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"]?[A-Za-z0-9_-]{20,}['"]?/gi },
  { name: 'Generic Secret', pattern: /(?:secret|password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi },
  { name: 'Generic Token', pattern: /(?:token|bearer)\s*[=:]\s*['"]?[A-Za-z0-9_.-]{20,}['"]?/gi },
  { name: 'Authorization Header', pattern: /authorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9_.=+/-]{12,}/gi }
];

export const PII_PATTERNS: NamedPattern[] = [
  { name: 'Email Address', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'Phone Number', pattern: /(?:\+?1?\s*\(?[0-9]{3}\)?[\s.-]?)?[0-9]{3}[\s.-]?[0-9]{4}/g },
  { name: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'Credit Card', pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g },
  { name: 'IP Address', pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g },
  { name: 'National ID (CO)', pattern: /\b[0-9]{6,10}\b/g } // Basic heuristic
];

const INJECTION_PATTERNS: RegExp[] = [
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
  /disregard\s+the\s+above/i,
  /reveal\s+your\s+(system\s+)?prompt/i,
  /act\s+as\s+if\s+you/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /sudo\s+/i,
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i
];

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function freshRegex(pattern: RegExp): RegExp {
  // Patterns are shared module-level /g regexes; never reuse their lastIndex state.
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
}

/** Replaces every secret (and optionally PII) occurrence with `[REDACTED:<type>]`. */
export function redactSensitive(text: string, options: { pii?: boolean } = {}): string {
  if (!text) return text;
  let out = text;
  for (const { name, pattern } of SECRET_PATTERNS) {
    out = out.replace(freshRegex(pattern), `[REDACTED:${name}]`);
  }
  if (options.pii) {
    for (const { name, pattern } of PII_PATTERNS) {
      if (name === 'National ID (CO)' || name === 'Phone Number') continue; // too broad to rewrite blindly
      out = out.replace(freshRegex(pattern), `[REDACTED:${name}]`);
    }
  }
  return out;
}

export function containsSecret(text: string): NamedPattern | undefined {
  if (!text) return undefined;
  return SECRET_PATTERNS.find(({ pattern }) => freshRegex(pattern).test(text));
}

// ---------------------------------------------------------------------------
// Context scanner (MCP `scan_security`, risk engine)
// ---------------------------------------------------------------------------

export interface SecurityFinding {
  type: 'secret' | 'pii' | 'sensitive-data';
  name: string;
  matched: string;
  line?: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface ContextSecurityReport {
  isSafe: boolean;
  findings: SecurityFinding[];
  secretCount: number;
  piiCount: number;
  dataClassification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  redactedContent?: string;
}

export function scanContextSecurity(
  content: string,
  options?: { detectSecrets?: boolean; detectPII?: boolean; redact?: boolean }
): ContextSecurityReport {
  const detectSecrets = options?.detectSecrets ?? true;
  const detectPII = options?.detectPII ?? true;
  const redact = options?.redact ?? false;

  const findings: SecurityFinding[] = [];
  let redactedContent = content;

  if (detectSecrets) {
    for (const sp of SECRET_PATTERNS) {
      const matches = content.match(freshRegex(sp.pattern));
      if (!matches) continue;
      for (const match of matches) {
        findings.push({ type: 'secret', name: sp.name, matched: match.substring(0, 10) + '***REDACTED***', severity: 'critical' });
        if (redact) redactedContent = redactedContent.split(match).join(`[REDACTED:${sp.name}]`);
      }
    }
  }

  if (detectPII) {
    for (const pp of PII_PATTERNS) {
      // Skip overly broad patterns on short content
      if (pp.name === 'National ID (CO)' && content.length < 100) continue;
      const matches = content.match(freshRegex(pp.pattern));
      if (!matches) continue;
      const filtered = matches.filter(m => {
        if (pp.name === 'Phone Number' && m.length < 7) return false;
        if (pp.name === 'National ID (CO)' && m.length < 8) return false;
        return true;
      });
      for (const match of filtered.slice(0, 5)) { // Limit to 5 per type
        findings.push({ type: 'pii', name: pp.name, matched: match.substring(0, 5) + '***', severity: 'high' });
        if (redact) redactedContent = redactedContent.split(match).join(`[REDACTED:${pp.name}]`);
      }
    }
  }

  const secretCount = findings.filter(f => f.type === 'secret').length;
  const piiCount = findings.filter(f => f.type === 'pii').length;

  let dataClassification: ContextSecurityReport['dataClassification'] = 'PUBLIC';
  if (secretCount > 0) dataClassification = 'RESTRICTED';
  else if (piiCount > 0) dataClassification = 'CONFIDENTIAL';
  else if (/\b(internal|private|confidential|proprietary)\b/i.test(content)) dataClassification = 'INTERNAL';

  return {
    isSafe: secretCount === 0 && piiCount === 0,
    findings,
    secretCount,
    piiCount,
    dataClassification,
    redactedContent: redact ? redactedContent : undefined
  };
}

// ---------------------------------------------------------------------------
// Prompt injection
// ---------------------------------------------------------------------------

export interface SecuritySanitizationResult {
  isSafe: boolean;
  reason?: string;
}

/**
 * Flags specification text that tries to steer the agent, or that embeds a hardcoded secret.
 * Pass `{ checkSecrets: false }` to only check for injection phrases.
 */
export function detectPromptInjection(text: string, options: { checkSecrets?: boolean } = {}): SecuritySanitizationResult {
  if (!text) return { isSafe: true };

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { isSafe: false, reason: `Potential Prompt Injection detected: Input matches forbidden pattern -> ${pattern.toString()}` };
    }
  }

  if (options.checkSecrets ?? true) {
    const secret = containsSecret(text);
    if (secret) {
      return { isSafe: false, reason: `Potential hardcoded secret or token detected (${secret.name}) matching pattern -> ${secret.pattern.toString()}` };
    }
  }

  return { isSafe: true };
}

// ---------------------------------------------------------------------------
// Entropy helpers
// ---------------------------------------------------------------------------

export function calculateShannonEntropy(str: string): number {
  if (!str) return 0;
  const frequencies: Record<string, number> = {};
  for (const char of str) frequencies[char] = (frequencies[char] || 0) + 1;
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
