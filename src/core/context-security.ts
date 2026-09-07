/* ==========================================================================
   gherkin-ai-cli - Context Security Layer
   
   Scans context before sending to LLMs. Detects secrets, PII, and
   classifies data sensitivity. Enforces LLM provider policies.
   ========================================================================== */

// ---------------------------------------------------------------------------
// Secret Detection
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'AWS Access Key', pattern: /(?:AKIA|A3T[A-Z0-9])[A-Z0-9]{16}/g },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|secretAccessKey)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/gi },
  { name: 'Generic Secret', pattern: /(?:secret|password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi },
  { name: 'Generic Token', pattern: /(?:token|bearer)\s*[=:]\s*['"]?[A-Za-z0-9_.\-]{20,}['"]?/gi },
  { name: 'Private Key', pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/g },
  { name: 'Database URL', pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+/gi },
  { name: 'JWT Token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'OpenAI API Key', pattern: /sk-[a-zA-Z0-9]{32,}/g },
  { name: 'GitHub Token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g },
  { name: 'Slack Token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Anthropic Key', pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
];

// ---------------------------------------------------------------------------
// PII Detection
// ---------------------------------------------------------------------------

const PII_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'Email Address', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'Phone Number', pattern: /(?:\+?1?\s*\(?[0-9]{3}\)?[\s.-]?)?[0-9]{3}[\s.-]?[0-9]{4}/g },
  { name: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'Credit Card', pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g },
  { name: 'IP Address', pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g },
  { name: 'National ID (CO)', pattern: /\b[0-9]{6,10}\b/g }, // Basic heuristic
];

// ---------------------------------------------------------------------------
// Interfaces
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

// ---------------------------------------------------------------------------
// Context Scanner
// ---------------------------------------------------------------------------

export function scanContextSecurity(
  content: string,
  options?: {
    detectSecrets?: boolean;
    detectPII?: boolean;
    redact?: boolean;
  }
): ContextSecurityReport {
  const detectSecrets = options?.detectSecrets ?? true;
  const detectPII = options?.detectPII ?? true;
  const redact = options?.redact ?? false;

  const findings: SecurityFinding[] = [];
  let redactedContent = content;

  // Scan for secrets
  if (detectSecrets) {
    for (const sp of SECRET_PATTERNS) {
      const matches = content.match(sp.pattern);
      if (matches) {
        for (const match of matches) {
          findings.push({
            type: 'secret',
            name: sp.name,
            matched: match.substring(0, 10) + '***REDACTED***',
            severity: 'critical',
          });
          if (redact) {
            redactedContent = redactedContent.replace(match, `[REDACTED:${sp.name}]`);
          }
        }
      }
    }
  }

  // Scan for PII
  if (detectPII) {
    for (const pp of PII_PATTERNS) {
      // Skip overly broad patterns on short content
      if (pp.name === 'National ID (CO)' && content.length < 100) continue;
      
      const matches = content.match(pp.pattern);
      if (matches) {
        // Filter out common false positives
        const filtered = matches.filter(m => {
          if (pp.name === 'Phone Number' && m.length < 7) return false;
          if (pp.name === 'National ID (CO)' && m.length < 8) return false;
          return true;
        });
        
        for (const match of filtered.slice(0, 5)) { // Limit to 5 per type
          findings.push({
            type: 'pii',
            name: pp.name,
            matched: match.substring(0, 5) + '***',
            severity: 'high',
          });
          if (redact) {
            redactedContent = redactedContent.replace(match, `[REDACTED:${pp.name}]`);
          }
        }
      }
    }
  }

  // Determine data classification
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
    redactedContent: redact ? redactedContent : undefined,
  };
}

// ---------------------------------------------------------------------------
// Re-export prompt injection detection (enhanced)
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+above/i,
  /system\s+prompt/i,
  /you\s+are\s+now/i,
  /new\s+instructions/i,
  /forget\s+(all\s+)?previous/i,
  /bypass\s+rules/i,
  /rm\s+-rf/i,
  /curl\s+.*\|.*sh/i,
  /wget\s+.*\|.*sh/i,
  /print\s+your\s+instructions/i,
  /disregard\s+the\s+above/i,
  /reveal\s+your\s+(system\s+)?prompt/i,
  /act\s+as\s+if\s+you/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /sudo\s+/i,
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i,
  /require\s*\(\s*['"]child_process['"]\s*\)/i,
];

export function detectPromptInjection(text: string): { isSafe: boolean; reason?: string } {
  if (!text) return { isSafe: true };
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return {
        isSafe: false,
        reason: `Potential Prompt Injection detected: Input matches forbidden pattern -> ${pattern.toString()}`,
      };
    }
  }
  return { isSafe: true };
}
