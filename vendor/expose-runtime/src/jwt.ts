/* Caller identity: an OIDC/JWT bearer token verified with the issuer's JWKS (node:crypto only).
 * Checked on every request: signature, issuer, audience (or client id), expiry and not-before. The tenant
 * comes from a claim of the verified token and never from the tool's arguments or a header. */

import { createPublicKey, verify, constants, type KeyObject } from 'node:crypto';

export interface Identity {
  subject: string;
  tenant: string;
  scopes: string[];
  roles: string[];
  clientId?: string;
}

export interface ClaimNames {
  tenantClaim: string;
  scopesClaim: string;
  rolesClaim: string;
}

export class AuthError extends Error {
  /** 401: no valid token; 403: a valid token that may not use this server. */
  constructor(message: string, readonly status: 401 | 403 = 401) {
    super(message);
  }
}

type Jwk = { kid?: string; kty: string; alg?: string; use?: string; [k: string]: unknown };

const ALGORITHMS: Record<string, { hash: string | null; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, PS384: { hash: 'sha384', pss: true }, PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
  EdDSA: { hash: null }
};
const SKEW_SECONDS = 60;
const KEYS_TTL_MS = 10 * 60 * 1000;
const REFRESH_MIN_MS = 30 * 1000;

const b64 = (s: string) => Buffer.from(s, 'base64url');

function json(part: string): Record<string, unknown> {
  try {
    const value = JSON.parse(b64(part).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* fall through */ }
  throw new AuthError('Malformed token.');
}

async function fetchJson(url: string, insecure: boolean): Promise<any> {
  if (!url.startsWith('https://') && !insecure) throw new AuthError('The issuer keys must be served over https.');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('GET ' + url + ': ' + res.status);
  return res.json();
}

export class JwksVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private loading?: Promise<void>;

  constructor(
    private readonly issuer: string,
    private readonly audiences: string[],
    private readonly claims: ClaimNames,
    private readonly options: { jwksUrl?: string; allowInsecure?: boolean; now?: () => number } = {}
  ) {}

  private async jwksUrl(): Promise<string> {
    if (this.options.jwksUrl) return this.options.jwksUrl;
    const doc = await fetchJson(this.issuer + '/.well-known/openid-configuration', Boolean(this.options.allowInsecure));
    if (typeof doc?.jwks_uri !== 'string') throw new Error('The issuer publishes no jwks_uri.');
    if (doc.issuer && String(doc.issuer).replace(/\/+$/, '') !== this.issuer) throw new Error('The discovery document names another issuer.');
    return doc.jwks_uri;
  }

  private async load(): Promise<void> {
    const doc = await fetchJson(await this.jwksUrl(), Boolean(this.options.allowInsecure));
    const keys = new Map<string, KeyObject>();
    for (const jwk of (Array.isArray(doc?.keys) ? doc.keys : []) as Jwk[]) {
      if (jwk.use && jwk.use !== 'sig') continue;
      try {
        keys.set(jwk.kid ?? '', createPublicKey({ key: jwk as any, format: 'jwk' }));
      } catch { /* a key this runtime cannot use */ }
    }
    this.keys = keys;
    this.fetchedAt = Date.now();
  }

  private async key(kid: string): Promise<KeyObject | undefined> {
    const stale = Date.now() - this.fetchedAt > KEYS_TTL_MS;
    const unknown = !this.keys.has(kid) && Date.now() - this.fetchedAt > REFRESH_MIN_MS;
    if (stale || unknown || !this.fetchedAt) {
      this.loading ??= this.load().finally(() => { this.loading = undefined; });
      try {
        await this.loading;
      } catch {
        if (!this.keys.size) throw new AuthError('The issuer keys are unavailable.', 401);
      }
    }
    return this.keys.get(kid) ?? (kid === '' && this.keys.size === 1 ? [...this.keys.values()][0] : undefined);
  }

  async verify(token: string): Promise<Identity> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('Malformed token.');
    const header = json(parts[0]);
    const alg = ALGORITHMS[String(header.alg)];
    if (!alg) throw new AuthError('Unsupported token algorithm.');
    const key = await this.key(typeof header.kid === 'string' ? header.kid : '');
    if (!key) throw new AuthError('Unknown signing key.');
    const data = Buffer.from(parts[0] + '.' + parts[1]);
    const signature = b64(parts[2]);
    const ok = alg.hash === null
      ? verify(null, data, key, signature)
      : verify(alg.hash, data, alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : alg.ec ? { key, dsaEncoding: 'ieee-p1363' } : key, signature);
    if (!ok) throw new AuthError('Invalid token signature.');

    const c = json(parts[1]);
    const now = (this.options.now ?? (() => Date.now() / 1000))();
    if (String(c.iss ?? '').replace(/\/+$/, '') !== this.issuer) throw new AuthError('Token from another issuer.');
    if (typeof c.exp !== 'number' || now > c.exp + SKEW_SECONDS) throw new AuthError('Expired token.');
    if (typeof c.nbf === 'number' && now + SKEW_SECONDS < c.nbf) throw new AuthError('Token not valid yet.');
    const aud = Array.isArray(c.aud) ? c.aud.map(String) : c.aud === undefined ? [] : [String(c.aud)];
    const clientId = typeof c.client_id === 'string' ? c.client_id : typeof c.azp === 'string' ? c.azp : undefined;
    if (!this.audiences.some(a => aud.includes(a) || a === clientId)) throw new AuthError('Token for another audience.');

    const subject = typeof c.sub === 'string' && c.sub ? c.sub : undefined;
    if (!subject) throw new AuthError('Token without a subject.');
    const tenant = c[this.claims.tenantClaim];
    if (typeof tenant !== 'string' || !tenant.trim()) throw new AuthError('Token without a tenant (' + this.claims.tenantClaim + ').', 403);
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\s,]+/) : []).filter(Boolean);
    const scopes = list(c[this.claims.scopesClaim] ?? c.scp);
    const roles = list(c[this.claims.rolesClaim]);
    return { subject, tenant: tenant.trim(), scopes, roles, ...(clientId ? { clientId } : {}) };
  }
}
