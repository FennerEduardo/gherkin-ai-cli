/* ==========================================================================
   gherkin-ai-cli - IR builder: Deterministic ids and the phrase patterns of the extractors
   ========================================================================== */

// ---------------------------------------------------------------------------
// Deterministic ID Generator
// ---------------------------------------------------------------------------

let idCounter = 0;
export function generateId(prefix: string): string {
  idCounter++;
  return `${prefix}-${String(idCounter).padStart(4, '0')}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

// ---------------------------------------------------------------------------
// NLP-lite Semantic Extraction Helpers
// ---------------------------------------------------------------------------

export const VERB_PATTERNS: Record<string, RegExp> = {
  create: /\b(creates?|registers?|adds?|inserts?|crea|registra|agrega)\b/i,
  update: /\b(updates?|modifies?|edits?|changes?|actualiza|modifica|edita)\b/i,
  delete: /\b(deletes?|removes?|eliminates?|elimina|remueve|borra)\b/i,
  cancel: /\b(cancels?|cancela)\b/i,
  approve: /\b(approves?|accepts?|aprueba|acepta)\b/i,
  reject: /\b(rejects?|denies?|rechaza|niega)\b/i,
  login: /\b(logs?\s*in|authenticat(es?|ion)|sign\s*in|inicia\s*sesión|autentica)\b/i,
  logout: /\b(logs?\s*out|sign\s*out|cierra\s*sesión)\b/i,
  send: /\b(sends?|dispatches?|envía|despacha)\b/i,
  search: /\b(searches?|finds?|queries?|looks?\s*up|busca|encuentra|consulta)\b/i,
  process: /\b(process(es|ing)?|procesa|procesando|handles?|maneja)\b/i,
  pay: /\b(pays?|charges?|paga|cobra)\b/i,
  calculate: /\b(calculat(es?|ion)|comput(es?|ation)|calcula)\b/i,
  assign: /\b(assigns?|allocat(es?|ion)|asigna)\b/i,
  verify: /\b(verif(ies?|y)|validat(es?|ion)|verifica|valida)\b/i,
  publish: /\b(publishes?|emits?|broadcasts?|publica|emite)\b/i,
  upload: /\b(uploads?|sube|carga)\b/i,
  download: /\b(downloads?|descarga|baja)\b/i,
};

export const STATE_PATTERNS: Record<string, RegExp> = {
  PENDING: /\b(pending|pendiente|awaiting|esperando)\b/i,
  ACTIVE: /\b(active|activo|enabled|habilitado)\b/i,
  CONFIRMED: /\b(confirmed|confirmado|approved|aprobado)\b/i,
  CANCELLED: /\b(cancelled|canceled|cancelado)\b/i,
  COMPLETED: /\b(completed|completado|finished|finalizado|done)\b/i,
  SHIPPED: /\b(shipped|enviado|dispatched|despachado)\b/i,
  DELIVERED: /\b(delivered|entregado)\b/i,
  REJECTED: /\b(rejected|rechazado|denied|denegado)\b/i,
  SUSPENDED: /\b(suspended|suspendido|blocked|bloqueado)\b/i,
  DRAFT: /\b(draft|borrador)\b/i,
  PUBLISHED: /\b(published|publicado)\b/i,
  ARCHIVED: /\b(archived|archivado)\b/i,
  FAILED: /\b(failed|fallido|error)\b/i,
  PROCESSING: /\b(processing|procesando|in.?progress|en.?proceso)\b/i,
  PAID: /\b(paid|pagado)\b/i,
};

export const ACTOR_PATTERNS = [
  /\b(?:as (?:a|an)|como (?:un|una))\s+(.+)/i,
  /\b(?:the|el|la|un|una)\s+(user|admin|customer|manager|operator|system|agent|usuario|administrador|cliente|gerente|operador|sistema|agente)\b/i,
  /\b(authenticated|authorized|unauthenticated|unauthorized|autenticado|autorizado)\s+(user|usuario)\b/i,
];

export const AUTH_PATTERNS = [
  /\b(authenticated|authorized|unauthenticated|unauthori[sz]ed|logged.?in|not.?logged|autenticado|autorizado|no.?autorizado|con.?sesión|sin.?sesión)\b/i,
  /\b(permissions?|permisos?|roles?|has.?role|tiene.?rol|is.?admin|es.?admin|privileges?|privilegios?)\b/i,
  /\b(token|jwt|session|sesión|cookie|bearer|login|sign.?in|iniciar.?sesión)\b/i,
  /\b(access.?denied|acceso.?denegado|forbidden|prohibido)\b/i,
  /\b(status|http|code|código|estado)\s*(401|403)\b/i,
];

export const ERROR_PATTERNS = [
  /\b(error|fail(s|ed|ure)?|invalid|denied|forbidden|not.?found|fallo|inválido|denegado|prohibido|no.?encontrado)\b/i,
  /\b(?:HTTP|status|code|código|estado)\s*(?:status\s*)?(?:4\d{2}|5\d{2})\b/i,
  /\b(reject(s|ed)?|rechazad[oa]|cannot|can.?not|no.?puede|not.?allowed|no.?permitid[oa])\b/i,
  /\b(exception|timeout|unavailable|excepción|tiempo.?agotado|no.?disponible)\b/i,
];
