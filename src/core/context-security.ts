/* Deprecated path: kept for backwards compatibility. Use `./security`. */
import { detectPromptInjection as detect, SecuritySanitizationResult } from './security';

export { scanContextSecurity } from './security';
export type { SecurityFinding, ContextSecurityReport } from './security';

/** Injection-phrase check only (MCP historically did not flag secrets here). */
export function detectPromptInjection(text: string): SecuritySanitizationResult {
  return detect(text, { checkSecrets: false });
}
