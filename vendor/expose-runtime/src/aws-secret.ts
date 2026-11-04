/* Credentials by reference on AWS: GHK_UPSTREAM_JWT_SECRET_ARN (or GHK_UPSTREAM_TOKEN_ARN) names a Secrets
 * Manager secret that the runtime reads at start with its execution role, so the value is never in the
 * Terraform state, the runtime's configuration or this image. Signed with SigV4 over node:crypto (no AWS SDK).
 * Credentials come from the standard chain: environment, the container credentials endpoint, then IMDSv2. */

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

/** SigV4 Authorization for a request (headers must include host and x-amz-date). */
export function signV4(input: {
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
}): string {
  const amzDate = input.headers['x-amz-date'];
  const date = amzDate.slice(0, 8);
  const names = Object.keys(input.headers).map(h => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map(n => n + ':' + String(lower[n]).trim().replace(/\s+/g, ' ') + '\n').join('');
  const signedHeaders = names.join(';');
  const canonical = [input.method, input.path, input.query ?? '', canonicalHeaders, signedHeaders, sha256(input.body)].join('\n');
  const scope = date + '/' + input.region + '/' + input.service + '/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + input.credentials.secretAccessKey, date), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return 'AWS4-HMAC-SHA256 Credential=' + input.credentials.accessKeyId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!res.ok) throw new Error('credentials endpoint answered ' + res.status);
  return res.json();
}

export async function awsCredentials(env: NodeJS.ProcessEnv = process.env): Promise<AwsCredentials> {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined };
  }
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (full || relative) {
    const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE ? readFileSync(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, 'utf8').trim() : env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    const c = await getJson(full ?? 'http://169.254.170.2' + relative, token ? { authorization: token } : {});
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token };
  }
  const imds = 'http://169.254.169.254/latest';
  const tokenRes = await fetch(imds + '/api/token', { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '300' }, signal: AbortSignal.timeout(2000) });
  const token = await tokenRes.text();
  const role = (await (await fetch(imds + '/meta-data/iam/security-credentials/', { headers: { 'x-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(2000) })).text()).split('\n')[0];
  const c = await getJson(imds + '/meta-data/iam/security-credentials/' + role, { 'x-aws-ec2-metadata-token': token });
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token };
}

/** The value of a Secrets Manager secret (a JSON key of it when `jsonKey` is given). */
export async function getSecret(arn: string, options: { jsonKey?: string; env?: NodeJS.ProcessEnv; endpoint?: string } = {}): Promise<string> {
  const m = /^arn:aws[a-z-]*:secretsmanager:([a-z0-9-]+):\d{12}:secret:.+$/.exec(arn);
  if (!m) throw new Error('Not a Secrets Manager secret ARN.');
  const region = m[1];
  const credentials = await awsCredentials(options.env);
  const url = new URL(options.endpoint ?? 'https://secretsmanager.' + region + '.amazonaws.com/');
  const body = JSON.stringify({ SecretId: arn });
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const headers: Record<string, string> = {
    host: url.host,
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-date': amzDate,
    'x-amz-target': 'secretsmanager.GetSecretValue',
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {})
  };
  const authorization = signV4({ method: 'POST', path: url.pathname, headers, body, region, service: 'secretsmanager', credentials });
  const res = await fetch(url, { method: 'POST', headers: { ...headers, authorization }, body, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!res.ok) throw new Error('GetSecretValue answered ' + res.status + '.');
  const value = ((await res.json()) as { SecretString?: unknown }).SecretString;
  if (typeof value !== 'string') throw new Error('The secret has no SecretString.');
  if (!options.jsonKey) return value;
  const field = JSON.parse(value)[options.jsonKey];
  if (typeof field !== 'string') throw new Error('The secret has no key ' + options.jsonKey + '.');
  return field;
}

/** Fills GHK_UPSTREAM_JWT_SECRET / GHK_UPSTREAM_TOKEN from their *_ARN references (never logged). */
export async function resolveSecretReferences(env: NodeJS.ProcessEnv): Promise<void> {
  for (const name of ['GHK_UPSTREAM_JWT_SECRET', 'GHK_UPSTREAM_TOKEN']) {
    const arn = env[name + '_ARN'];
    if (!arn || env[name]) continue;
    env[name] = await getSecret(arn, { jsonKey: env[name + '_JSON_KEY'] || undefined, env });
  }
}
