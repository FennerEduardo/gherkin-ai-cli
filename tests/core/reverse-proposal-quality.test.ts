/* ==========================================================================
   `ghk reverse` proposal quality (PLAN-3.3.0-reverse-plus RV-05)

   On the RealWorld apps the proposals scored 69–79 on lint, all from GHK004
   (duplicated scenarios). The causes, each tested here:
   - two endpoints of one aggregate got the same operation name;
   - failures that render the same steps were two scenarios;
   - code was read as an error message (`&& errors.Is(err, …) {`);
   - "an user", "the from user".
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { buildCandidates, isProse, operationName } from '../../src/core/reverse/candidates';
import { makeEvidence, type EndpointMetadata, type SourceEvidence } from '../../src/core/reverse/evidence';
import { renderProposals } from '../../src/core/reverse/renderer';

const endpoint = (meta: EndpointMetadata, line: number): SourceEvidence => makeEvidence({
  kind: 'http-endpoint', description: `${meta.method} ${meta.path}`, symbol: meta.handler,
  location: { file: 'src/app.ts', startLine: line, endLine: line }, extractor: 'typescript/express', confidence: 'strong',
  metadata: meta as unknown as Record<string, unknown>
});
const related = (kind: SourceEvidence['kind'], to: SourceEvidence, line: number, metadata: Record<string, unknown>): SourceEvidence => makeEvidence({
  kind, description: `${kind} ${line}`, location: { file: 'src/app.ts', startLine: line, endLine: line },
  extractor: 'typescript/express', confidence: 'strong', references: [to.id], metadata
});

describe('reverse proposals: no duplicated scenarios (GHK004)', () => {
  it('tells apart two endpoints of one aggregate that map to the same operation name', () => {
    const del = endpoint({ method: 'DELETE', path: '/articles/{slug}', handler: 'deleteArticle' }, 1);
    const unfav = endpoint({ method: 'DELETE', path: '/articles/{slug}/favorite', handler: 'deleteArticle' }, 2);
    const list = endpoint({ method: 'GET', path: '/articles' }, 3);
    const feed = endpoint({ method: 'GET', path: '/articles/feed' }, 4);
    const ev = [del, unfav, list, feed, ...[del, unfav, list, feed].map((e, i) => related('success-response', e, 10 + i, { status: 200 }))];
    const names = buildCandidates(ev).candidates.map(c => c.operation.name).sort();
    expect(names).toEqual(['DeleteArticle', 'DeleteArticleFavorite', 'ListArticles', 'ListFeedArticles']);
    const [proposal] = renderProposals(buildCandidates(ev).candidates, ev);
    expect(proposal.lint.diagnostics.filter(d => d.ruleId === 'GHK004')).toEqual([]);
    expect(proposal.roundTrip.ok).toBe(true);
  });

  it('merges failures that render the same steps into one scenario with the evidence of both', () => {
    const put = endpoint({ method: 'PUT', path: '/user', handler: 'updateUser' }, 1);
    const ev = [put, related('success-response', put, 2, { status: 200 }),
      related('validation-rule', put, 3, { status: 422, condition: 'a' }), related('validation-rule', put, 4, { status: 422, condition: 'b' })];
    const [c] = buildCandidates(ev).candidates;
    const invalid = c.scenarios.filter(s => s.category === 'validation');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].steps.find(s => s.keyword === 'Then')!.evidence).toHaveLength(2);
    expect(invalid[0].name).not.toMatch(/\(2\)/);
  });

  it('never quotes code as an error message', () => {
    expect(isProse('Article not found')).toBe(true);
    expect(isProse('&& errors.Is(err, gorm.ErrDuplicatedKey) { finalSlug = makeUniqueSlug(newSlugBase)')).toBe(false);
    const put = endpoint({ method: 'PUT', path: '/articles/{slug}', handler: 'updateArticle' }, 1);
    const ev = [put, related('success-response', put, 2, { status: 200 }),
      related('error-condition', put, 3, { status: 409, message: '&& errors.Is(err, gorm.ErrDuplicatedKey) {' })];
    const text = renderProposals(buildCandidates(ev).candidates, ev)[0].text;
    expect(text).not.toMatch(/errors\.Is/);
    expect(text).toMatch(/fails as a conflict/);
  });

  it('writes "a user" and drops leading prepositions of a handler name', () => {
    const reg = endpoint({ method: 'POST', path: '/users', handler: 'registerUser' }, 1);
    const unsub = endpoint({ method: 'DELETE', path: '/profiles/{username}/follow', handler: 'unsubscribeFromUser' }, 2);
    const ev = [reg, unsub, related('success-response', reg, 3, { status: 201 }), related('success-response', unsub, 4, { status: 200 })];
    const phrases = buildCandidates(ev).candidates.map(c => c.operation.phrase).sort();
    expect(phrases).toEqual(['registers a user', 'unsubscribes the user']);
  });

  it('reads a trailing verb as the action (POST /users/login) and a bare Get on a collection as a list', () => {
    expect(operationName({ method: 'POST', path: '/users/login' }, 'User').name).toBe('LoginUser');
    expect(operationName({ method: 'GET', path: '/articles', handler: 'Get' }, 'Article').name).toBe('ListArticles');
    expect(operationName({ method: 'GET', path: '/articles/{slug}', handler: 'Get' }, 'Article').name).toBe('GetArticle');
  });
});
