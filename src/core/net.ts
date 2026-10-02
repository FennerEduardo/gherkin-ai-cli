/* ==========================================================================
   gherkin-ai-cli - Corporate network support (proxy + custom CA)

   Node's built-in fetch ignores HTTPS_PROXY. We install an undici
   EnvHttpProxyAgent as the global dispatcher, which:
   - honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY (or network.proxy / noProxy),
   - trusts the system roots plus network.caFile (TLS-inspecting proxies).
   NODE_EXTRA_CA_CERTS keeps working as usual because Node applies it globally.

   The global dispatcher is shared with Node's fetch, so every SDK that uses
   global fetch (Anthropic, Gemini, and OpenAI via the `fetch` option) goes
   through it.
   ========================================================================== */

import fs from 'fs';
import tls from 'tls';
import { EnvHttpProxyAgent, setGlobalDispatcher, getGlobalDispatcher, Dispatcher } from 'undici';
import { ConfigError } from './errors';

export interface NetworkSettings {
  proxy?: string;
  noProxy?: string;
  caFile?: string;
}

let installedKey: string | undefined;
let originalDispatcher: Dispatcher | undefined;

function proxyFromEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

/** Builds the TLS CA list: Node's bundled roots + the extra corporate bundle. */
export function loadCaBundle(caFile: string): string[] {
  let pem: string;
  try {
    pem = fs.readFileSync(caFile, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read network.caFile at ${caFile}: ${(err as Error).message}`);
  }
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new ConfigError(`network.caFile at ${caFile} does not contain a PEM certificate.`);
  }
  return [...tls.rootCertificates, pem];
}

/**
 * Installs the proxy/CA-aware dispatcher once per distinct configuration.
 * No-op when no proxy and no CA file are configured, so default behavior is unchanged.
 */
export function configureNetwork(settings: NetworkSettings = {}, env: NodeJS.ProcessEnv = process.env): boolean {
  const wantsProxy = Boolean(settings.proxy) || proxyFromEnv(env);
  if (!wantsProxy && !settings.caFile) return false;

  const key = JSON.stringify([settings, env.HTTPS_PROXY, env.HTTP_PROXY, env.NO_PROXY, env.https_proxy, env.http_proxy, env.no_proxy]);
  if (installedKey === key) return true;

  const ca = settings.caFile ? loadCaBundle(settings.caFile) : undefined;
  const agent = new EnvHttpProxyAgent({
    ...(settings.proxy ? { httpProxy: settings.proxy, httpsProxy: settings.proxy } : {}),
    ...(settings.noProxy ? { noProxy: settings.noProxy } : {}),
    ...(ca ? { connect: { ca }, requestTls: { ca }, proxyTls: { ca } } : {})
  });

  originalDispatcher ??= getGlobalDispatcher();
  setGlobalDispatcher(agent);
  installedKey = key;
  return true;
}

/** Test hook. */
export function resetNetwork(): void {
  if (originalDispatcher) setGlobalDispatcher(originalDispatcher);
  installedKey = undefined;
}
