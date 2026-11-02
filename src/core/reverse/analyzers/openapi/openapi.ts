/* ==========================================================================
   gherkin-ai-cli - OpenAPI adapter for `ghk reverse` (PLAN-3.3.0 R-11, beta)

   Stack-independent evidence: operations, required request fields and the
   documented 4xx responses. It is the only reverse path for community-tier
   stacks (Django, Laravel, Rails, Phoenix, …), and for the core stacks it
   confirms what the code adapters found (contract + code = confirmed).
   Documents: `--openapi <file>` or any openapi/swagger .json/.yaml in the
   repository outside generated-specs/ and contracts/ (those are ghk's own).
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { makeEvidence, normalisePath, type EndpointMetadata, type SourceEvidence } from '../../evidence';
import type { AnalysisContext, SourceAnalyzer } from '../../registry';
import { failureKind } from '../typescript/ts-body';

const ID = 'openapi';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export function openApiDocuments(ctx: AnalysisContext): string[] {
  if (ctx.openapi?.length) return ctx.openapi.map(p => p.split(path.sep).join('/'));
  return ctx.files
    .filter(f => /(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(f.rel) && !/(^|\/)(generated-specs|contracts|node_modules)\//.test(f.rel))
    .map(f => f.rel);
}

function load(abs: string): any {
  const text = fs.readFileSync(abs, 'utf8');
  return /\.json$/i.test(abs) ? JSON.parse(text) : yaml.parse(text);
}

/** 1-based line of the first occurrence of `needle` (best effort, for the evidence location). */
function lineOf(text: string, needle: string, from = 0): number {
  const at = text.indexOf(needle, from);
  return at < 0 ? 1 : text.slice(0, at).split('\n').length;
}

function resolveRef(doc: any, schema: any): any {
  if (schema?.$ref && typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    return schema.$ref.slice(2).split('/').reduce((o: any, k: string) => o?.[k], doc);
  }
  return schema;
}

const openapi: SourceAnalyzer = {
  id: ID,
  language: 'any',
  frameworks: ['openapi'],
  maturity: 'beta',
  detect(ctx) {
    return openApiDocuments(ctx).length > 0;
  },
  async analyze(ctx) {
    const out: SourceEvidence[] = [];
    for (const rel of openApiDocuments(ctx)) {
      const abs = path.resolve(ctx.root, rel);
      let doc: any;
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); doc = load(abs); } catch { continue; }
      if (!doc?.paths || typeof doc.paths !== 'object') continue;
      const file = path.relative(ctx.root, abs).split(path.sep).join('/');
      for (const [rawPath, item] of Object.entries<any>(doc.paths)) {
        const pathLine = lineOf(text, `"${rawPath}"`) || lineOf(text, `${rawPath}:`);
        for (const m of METHODS) {
          const op = item?.[m];
          if (!op) continue;
          const method = m.toUpperCase() as EndpointMetadata['method'];
          const p = normalisePath(rawPath);
          const line = Math.max(pathLine, lineOf(text, `"${m}"`, text.indexOf(rawPath)));
          const location = { file, startLine: line, endLine: line };
          const endpoint = makeEvidence({
            kind: 'http-endpoint', extractor: ID, confidence: 'strong', location, description: `${method} ${p}`,
            symbol: op.operationId, key: `${method} ${p}`,
            metadata: { method, path: p, operationId: op.operationId, handler: op.operationId, summary: op.summary } as EndpointMetadata & { summary?: string }
          });
          out.push(endpoint);
          for (const [code, resp] of Object.entries<any>(op.responses ?? {})) {
            const status = Number(code);
            if (!Number.isFinite(status)) continue;
            if (status < 400) {
              out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'strong', references: [endpoint.id], location, description: `responds ${status}`, metadata: { status }, key: `${method} ${p} ${status}` }));
              continue;
            }
            const { kind, technical } = failureKind(status);
            const message = typeof resp?.description === 'string' ? resp.description : undefined;
            out.push(makeEvidence({ kind, extractor: ID, confidence: 'strong', references: [endpoint.id], location, description: `${message ?? `status ${status}`} (documented)`, metadata: { status, message, technical, documented: true }, key: `${method} ${p} ${status}` }));
          }
          const body = resolveRef(doc, op.requestBody?.content?.['application/json']?.schema);
          const required: string[] = Array.isArray(body?.required) ? body.required : [];
          for (const field of required) {
            out.push(makeEvidence({ kind: 'validation-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location, description: `${field} required`, metadata: { field, rule: 'required', status: 400, documented: true }, key: `${method} ${p} required ${field}` }));
          }
        }
      }
    }
    return out;
  }
};

export default openapi;
