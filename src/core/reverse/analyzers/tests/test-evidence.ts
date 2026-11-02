/* ==========================================================================
   gherkin-ai-cli - Tests as evidence for `ghk reverse` (PLAN-3.3.0 R-12)

   A test that calls an endpoint is the strongest evidence there is that the
   endpoint behaves as the test says: it raises the confidence of the
   matching candidate to `confirmed`. Only read with `--include-tests`
   (default on in `reverse scan`), and only for the HTTP calls a test makes:
   supertest (`request(app).post('/orders')`), MockMvc (`post("/orders")`),
   TestClient (`client.post("/orders")`), httptest (`"POST", "/orders"`).
   ========================================================================== */

import fs from 'fs';
import { isTestFile } from '../../discovery';
import { makeEvidence, normalisePath, type SourceEvidence } from '../../evidence';
import type { SourceAnalyzer } from '../../registry';

const ID = 'tests';
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.java', '.kt', '.cs', '.py', '.go']);

const CALLS: RegExp[] = [
  // supertest / axios / fetch-like clients and FastAPI TestClient: .post('/orders'
  /\.(get|post|put|patch|delete)\(\s*[`'"](\/[^`'"\s]*)[`'"]/gi,
  // MockMvc: perform(post("/orders")) ; RestAssured: .post("/orders")
  /\b(get|post|put|patch|delete)\(\s*"(\/[^"\s]*)"/gi,
  // .NET HttpClient: _client.PostAsync("/orders", …), GetFromJsonAsync("/orders/1"), PostAsJsonAsync(…)
  /\.(Get|Post|Put|Patch|Delete)(?:Async|AsJsonAsync|FromJsonAsync|StringAsync)\(\s*\$?"(\/[^"\s]*)"/g,
  // Go httptest / .NET HttpRequestMessage: ("POST", "/orders") / (HttpMethod.Post, "/orders")
  /(?:"|HttpMethod\.)(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)"?\s*,\s*"(\/[^"\s]*)"/g
];

/** The test name around a line: it('…'), test('…'), @Test void name(), def test_name, func TestName. */
function testNameBefore(lines: string[], index: number): string | undefined {
  for (let i = index; i >= Math.max(0, index - 40); i--) {
    const l = lines[i];
    const m = l.match(/\b(?:it|test|scenario)\s*\(\s*[`'"]([^`'"]+)[`'"]/) ?? l.match(/\bdef\s+(test_\w+)/) ?? l.match(/\bfunc\s+(Test\w+)/)
      ?? l.match(/\b(?:void|fun|async\s+Task|public\s+void|Task)\s+(\w+)\s*\(/);
    if (m) return m[1];
  }
  return undefined;
}

const testEvidence: SourceAnalyzer = {
  id: ID,
  language: 'any',
  frameworks: ['tests'],
  maturity: 'beta',
  detect(ctx) {
    return ctx.includeTests && ctx.files.some(f => isTestFile(f.rel) && CODE_EXT.has(f.ext));
  },
  async analyze(ctx) {
    const out: SourceEvidence[] = [];
    for (const f of ctx.files.filter(x => isTestFile(x.rel) && CODE_EXT.has(x.ext))) {
      let text = '';
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      const seen = new Set<string>();
      for (const re of CALLS) {
        for (const m of text.matchAll(re)) {
          const method = m[1].toUpperCase();
          const p = normalisePath(m[2].split('?')[0].replace(/\$\{[^}]+\}/g, '{id}'));
          const line = text.slice(0, m.index).split('\n').length;
          const key = `${method} ${p} ${line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const name = testNameBefore(lines, line - 1);
          out.push(makeEvidence({
            kind: 'test-case', extractor: ID, confidence: 'confirmed', location: { file: f.rel, startLine: line, endLine: line },
            symbol: name, description: `${name ?? 'test'} calls ${method} ${p}`, metadata: { method, path: p, test: name }, key
          }));
        }
      }
    }
    return out;
  }
};

export default testEvidence;
