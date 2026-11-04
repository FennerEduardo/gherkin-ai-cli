/* Redaction of secrets (always) and personal data (for capabilities tagged @pii) in what the agent receives
 * and in the audit log. The same families of patterns as gherkin-ai's own sanitizer. */

const SECRETS: RegExp[] = [
  /-----BEGIN\s+[A-Z\s]*PRIVATE KEY-----[\s\S]*?(?:-----END\s+[A-Z\s]*PRIVATE KEY-----|$)/g,
  /(?:AKIA|ASIA|A3T[A-Z0-9])[A-Z0-9]{16}/g,
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s'"/@:]*:[^\s'"/@]+@[^\s'"]+/gi,
  /(?:secret|password|passwd|pwd|api[_-]?key|token)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
  /(?:bearer|basic)\s+[A-Za-z0-9_.=+/-]{12,}/gi
];
const PII: RegExp[] = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
  /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g
];
const SECRET_KEYS = /^(password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api_?key|authorization|cookie|set-cookie|private_key)$/i;

export function redactText(text: string, pii: boolean): string {
  let out = text;
  for (const p of SECRETS) out = out.replace(new RegExp(p.source, p.flags), '[REDACTED]');
  if (pii) for (const p of PII) out = out.replace(new RegExp(p.source, p.flags), '[REDACTED:PII]');
  return out;
}

/** A deep copy with secrets (and personal data) replaced; keys that name a secret lose their value. */
export function redactValue(value: unknown, pii: boolean, depth = 0): unknown {
  if (depth > 32) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value, pii);
  if (Array.isArray(value)) return value.map(v => redactValue(v, pii, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : redactValue(v, pii, depth + 1)]));
  }
  return value;
}
