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

/** The first line of a test: it('…'), test('…'), def test_…, @Test, [Fact], func Test…. */
const TEST_START = /\b(?:it|test|scenario)\s*\(\s*[`'"]|\bdef\s+test_|@Test\b|\[(?:Fact|Theory|Test|TestMethod)\]|\bfunc\s+Test\w+/;

const NAMED_STATUS: Record<string, number> = {
  ok: 200, created: 201, accepted: 202, nocontent: 204, badrequest: 400, unauthorized: 401, forbidden: 403, notfound: 404,
  conflict: 409, gone: 410, preconditionfailed: 412, unprocessableentity: 422, unprocessablecontent: 422, toomanyrequests: 429
};

/**
 * The status a test asserts right after its call (PLAN-3.3.0-reverse-plus RV-09): supertest `.expect(201)`,
 * `expect(res.status).toBe(404)`, MockMvc `status().isNotFound()` / `status().is(409)`, RestAssured
 * `.statusCode(200)`, pytest `status_code == 404`, xUnit `HttpStatusCode.NotFound`, Go `http.StatusOK`.
 */
export function expectedStatusIn(window: string): number | undefined {
  const m = window.match(/\.expect\(\s*(\d{3})\b/) ?? window.match(/\b(?:status|statusCode|status_code|StatusCode|Code)\)?\s*(?:\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(|==\s*|,\s*)(\d{3})\b/)
    ?? window.match(/\.(?:toBe|toEqual)\(\s*(\d{3})\s*\)/) ?? window.match(/status\(\)\.is\(\s*(\d{3})\s*\)|\.statusCode\(\s*(\d{3})\s*\)/);
  if (m) return Number(m[1] ?? m[2]);
  const named = window.match(/status\(\)\.is([A-Z]\w+)\(\)|HttpStatusCode\.([A-Z]\w+)|http\.Status([A-Z]\w+)|HTTPStatus\.([A-Z_]+)|status\.HTTP_(\d{3})/);
  if (!named) return undefined;
  if (named[5]) return Number(named[5]);
  const key = (named[1] ?? named[2] ?? named[3] ?? named[4]!).replace(/_/g, '').toLowerCase();
  return NAMED_STATUS[key];
}

/** Event names a test mentions near its call: 'order.placed', "OrderPlaced" (a quoted past-tense name). */
export function eventsNamedIn(window: string): string[] {
  const out = new Set<string>();
  for (const m of window.matchAll(/['"`]([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.(?:[a-z0-9]+[._-])*[a-z0-9]*ed)['"`]/g)) out.add(m[1]);
  for (const m of window.matchAll(/['"`]([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*(?:ed|Event))['"`]/g)) out.add(m[1]);
  return [...out].sort();
}

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
          // What the test asserts: the status in the next lines (up to the next call), and the events it names.
          // The window ends where the next test starts, so one test's assertions are never read as another's.
          let end = Math.min(lines.length, line + 8);
          for (let i = line; i < end; i++) if (TEST_START.test(lines[i])) { end = i; break; }
          const window = lines.slice(line - 1, end).join('\n');
          const expectedStatus = expectedStatusIn(window);
          const events = eventsNamedIn(window);
          out.push(makeEvidence({
            kind: 'test-case', extractor: ID, confidence: 'confirmed', location: { file: f.rel, startLine: line, endLine: line },
            symbol: name, description: `${name ?? 'test'} calls ${method} ${p}${expectedStatus ? ` and expects ${expectedStatus}` : ''}`,
            metadata: { method, path: p, test: name, ...(expectedStatus ? { expectedStatus } : {}), ...(events.length ? { events } : {}) }, key
          }));
        }
      }
    }
    return out;
  }
};

export default testEvidence;
