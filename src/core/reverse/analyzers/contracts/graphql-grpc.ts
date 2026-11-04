/* ==========================================================================
   gherkin-ai-cli - GraphQL and gRPC contracts for `ghk reverse`
   (PLAN-3.3.0-reverse-plus RV-14, experimental), for every stack

   Like OpenAPI, a schema states the operations a service offers whatever
   its language:
   - GraphQL SDL (`.graphql`, `.gql`, `.graphqls`): the fields of `type
     Mutation` (commands) and `type Query` (queries), `extend type …`
     included, with their arguments (`!` is required) and return type;
   - Protocol Buffers (`.proto`): `service OrderService { rpc PlaceOrder(…)
     returns (…); }`. An rpc named Get…/List…/Find…/Search… is a query.
   Each becomes `rpc-operation` evidence. Resolvers found in the code
   (NestJS @Mutation/@Query/@GrpcMethod, Spring @MutationMapping/
   @QueryMapping) emit the same operation, and the candidates merge both:
   the schema states it, the code says what it does.
   gherkin-ai's own `contracts/` and `generated-specs/` are skipped: they
   were derived from the features, as the OpenAPI adapter skips them.
   ========================================================================== */

import fs from 'fs';
import { isTestFile } from '../../discovery';
import { makeEvidence, type EntryMetadata, type SourceEvidence } from '../../evidence';
import type { SourceAnalyzer } from '../../registry';

const ID = 'contracts/graphql-grpc';
const SCHEMA = /\.(graphql|gql|graphqls|proto)$/i;
const OWN = /(^|\/)(contracts|generated-specs|node_modules|vendor|dist|build|target)\//;

const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

export interface RpcDeclaration {
  protocol: 'graphql' | 'grpc';
  kind: 'mutation' | 'query';
  operation: string;
  service?: string;
  /** Return type without list or non-null markers (Order for `[Order!]!`). */
  returns?: string;
  args: { name: string; type: string; required: boolean }[];
  line: number;
}

export function graphqlOperations(text: string): RpcDeclaration[] {
  const out: RpcDeclaration[] = [];
  const clean = text.replace(/#[^\n]*/g, m => ' '.repeat(m.length)).replace(/"""[\s\S]*?"""/g, m => m.replace(/[^\n]/g, ' '));
  for (const block of clean.matchAll(/(?:extend\s+)?type\s+(Mutation|Query)\s*(?:@\w+(?:\([^)]*\))?\s*)*\{([\s\S]*?)\}/g)) {
    const kind = block[1] === 'Mutation' ? 'mutation' : 'query';
    const start = block.index! + block[0].indexOf('{') + 1;
    for (const f of block[2].matchAll(/(\w+)\s*(\(([\s\S]*?)\))?\s*:\s*([[\]\w!]+)/g)) {
      const args = (f[3] ?? '').split(/[,\n]/).map(a => a.trim()).filter(Boolean).map(a => {
        const m = a.match(/^(\w+)\s*:\s*([[\]\w!]+)/);
        return m ? { name: m[1], type: m[2].replace(/[[\]!]/g, ''), required: /!$/.test(m[2]) } : undefined;
      }).filter((a): a is { name: string; type: string; required: boolean } => Boolean(a));
      out.push({ protocol: 'graphql', kind, operation: f[1], returns: f[4].replace(/[[\]!]/g, ''), args, line: lineAt(clean, start + f.index!) });
    }
  }
  return out;
}

export function protoOperations(text: string): RpcDeclaration[] {
  const out: RpcDeclaration[] = [];
  const clean = text.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  for (const svc of clean.matchAll(/service\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const start = svc.index! + svc[0].indexOf('{') + 1;
    for (const r of svc[2].matchAll(/rpc\s+(\w+)\s*\(\s*(?:stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([\w.]+)\s*\)/g)) {
      out.push({ protocol: 'grpc', kind: /^(Get|List|Find|Search|Count|Watch|Lookup)/.test(r[1]) ? 'query' : 'mutation', operation: r[1], service: svc[1], returns: r[3].split('.').pop(), args: [{ name: 'request', type: r[2].split('.').pop()!, required: true }], line: lineAt(clean, start + r.index!) });
    }
  }
  return out;
}

/** The evidence of one declared or implemented operation (the key is the same for the schema and the code). */
export function rpcEvidence(d: Omit<RpcDeclaration, 'line'>, location: { file: string; startLine: number; endLine: number }, extractor: string, owner?: string, handler?: string): SourceEvidence {
  const meta: EntryMetadata & Record<string, unknown> = { trigger: d.protocol, channel: d.service ? `${d.service}/${d.operation}` : `${d.kind === 'mutation' ? 'Mutation' : 'Query'}.${d.operation}`, handler: handler ?? d.operation, owner, operation: d.operation, service: d.service, kind: d.kind, returns: d.returns, args: d.args };
  return makeEvidence({
    kind: 'rpc-operation', extractor, confidence: 'strong', location, symbol: meta.channel,
    description: `${d.protocol === 'grpc' ? `rpc ${d.service}.${d.operation}` : `${d.kind} ${d.operation}`}${d.returns ? ` → ${d.returns}` : ''}`,
    metadata: meta, key: `${d.protocol}|${meta.channel}|${extractor}`
  });
}

const graphqlGrpc: SourceAnalyzer = {
  id: ID,
  language: 'any',
  frameworks: ['graphql', 'grpc'],
  maturity: 'experimental',
  detect(ctx) {
    return ctx.files.some(f => SCHEMA.test(f.rel) && !OWN.test(f.rel) && !isTestFile(f.rel));
  },
  async analyze(ctx) {
    const out: SourceEvidence[] = [];
    for (const f of ctx.files.filter(x => SCHEMA.test(x.rel) && !OWN.test(x.rel) && !isTestFile(x.rel))) {
      let text: string;
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      const decls = /\.proto$/i.test(f.rel) ? protoOperations(text) : graphqlOperations(text);
      for (const d of decls) out.push(rpcEvidence(d, { file: f.rel, startLine: d.line, endLine: d.line }, ID));
    }
    return out;
  }
};

export default graphqlGrpc;
