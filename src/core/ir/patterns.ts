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

/**
 * Business verbs the core list above does not know. They only name a command whose verb would otherwise be
 * unknown (an `unknown_*` IR command, or the generator's `Process<Feature>` default), so a feature that already
 * produces commands does not gain new ones. Many of these words are also nouns ("the request", "a review"), so
 * they match only as a third-person verb ("the customer places", "submits") or after "I" / "we" ("I place").
 * Spanish forms are the third person singular ("el docente revoca"), without the ones that are also common nouns.
 */
const EXTENDED_VERB_FORMS: Record<string, { en: string; es?: string }> = {
  place: { en: 'places' }, submit: { en: 'submits' }, book: { en: 'books' }, reserve: { en: 'reserves' },
  enroll: { en: 'enroll?s', es: 'inscribe|matricula' }, subscribe: { en: 'subscribes', es: 'suscribe' }, unsubscribe: { en: 'unsubscribes' },
  grant: { en: 'grants', es: 'otorga|concede' }, revoke: { en: 'revokes', es: 'revoca' }, invite: { en: 'invites', es: 'invita' },
  refund: { en: 'refunds', es: 'reembolsa' }, transfer: { en: 'transfers', es: 'transfiere' }, withdraw: { en: 'withdraws', es: 'retira' },
  deposit: { en: 'deposits', es: 'deposita' }, schedule: { en: 'schedules' }, reschedule: { en: 'reschedules', es: 'reprograma' },
  close: { en: 'closes', es: 'cierra' }, open: { en: 'opens', es: 'abre' }, activate: { en: 'activates', es: 'activa' },
  deactivate: { en: 'deactivates', es: 'desactiva' }, suspend: { en: 'suspends', es: 'suspende' }, resume: { en: 'resumes', es: 'reanuda' },
  archive: { en: 'archives', es: 'archiva' }, restore: { en: 'restores', es: 'restaura' }, ship: { en: 'ships' }, deliver: { en: 'delivers' },
  confirm: { en: 'confirms', es: 'confirma' }, complete: { en: 'completes', es: 'completa' }, start: { en: 'starts', es: 'inicia' },
  finish: { en: 'finishes', es: 'finaliza|termina' }, rate: { en: 'rates', es: 'califica' }, review: { en: 'reviews', es: 'revisa' },
  share: { en: 'shares', es: 'comparte' }, join: { en: 'joins' }, issue: { en: 'issues' }, renew: { en: 'renews', es: 'renueva' },
  request: { en: 'requests', es: 'solicita' }, claim: { en: 'claims', es: 'reclama' }, redeem: { en: 'redeems', es: 'redime|canjea' },
  reset: { en: 'resets', es: 'restablece' }, lock: { en: 'locks', es: 'bloquea' }, unlock: { en: 'unlocks', es: 'desbloquea' },
  apply: { en: 'applies', es: 'aplica|postula' }, import: { en: 'imports', es: 'importa' }, export: { en: 'exports', es: 'exporta' },
  grade: { en: 'grades' }, record: { en: 'records' }, return: { en: 'returns', es: 'devuelve' }, accept: { en: 'accepts' }
};

export const EXTENDED_VERB_PATTERNS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(EXTENDED_VERB_FORMS).map(([verb, { en, es }]) => [
    verb,
    new RegExp(`\\b(?:${en}${es ? `|${es}` : ''})\\b|\\b(?:I|we)\\s+${verb}\\b`, 'i')
  ])
);

/** One word of a step that is the extended verb (any of its forms), to find the noun phrase after it. */
export const EXTENDED_VERB_WORDS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(EXTENDED_VERB_FORMS).map(([verb, { en, es }]) => [verb, new RegExp(`^(?:${verb}|${en}${es ? `|${es}` : ''})$`, 'i')])
);

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
  /\b(authenticat(?:ed|es|ing)|authori[sz](?:ed|es|ing|ation)|unauthenticated|unauthori[sz]ed|logged.?in|not.?logged|signed.?in|not.?signed.?in|autenticad[oa]|autorizad[oa]|no.?autorizad[oa]|con.?sesión|sin.?sesión)\b/i,
  /\b(permissions?|permisos?|roles?|has.?role|tiene.?rol|is.?admin|es.?admin|privileges?|privilegios?)\b/i,
  /\b(token|jwt|session|sesión|cookie|bearer|login|sign.?in|iniciar.?sesión)\b/i,
  /\b(access.?denied|acceso.?denegado|forbid(?:den|s)?|prohibid[oa]|den(?:y|ies|ied)\s+(?:access|the\s+request)|denied\s+as\s+unauthori[sz]ed)\b/i,
  /\b(status|http|code|código|estado)\s*(401|403)\b/i,
];

export const ERROR_PATTERNS = [
  /\b(error|fail(s|ed|ure)?|invalid|denied|forbidden|not.?found|fallo|inválido|denegado|prohibido|no.?encontrado)\b/i,
  /\b(?:HTTP|status|code|código|estado)\s*(?:status\s*)?(?:4\d{2}|5\d{2})\b/i,
  /\b(reject(s|ed)?|rechazad[oa]|cannot|can.?not|no.?puede|not.?allowed|no.?permitid[oa])\b/i,
  /\b(exception|timeout|unavailable|excepción|tiempo.?agotado|no.?disponible)\b/i,
];
