/* ==========================================================================
   gherkin-ai-cli - Unique constraints the database enforces
   (PLAN-3.3.0-reverse-plus RV-08, beta), for every stack

   Declarative and line-local, so read with patterns rather than a parser:
   - Prisma `@unique` / `@@unique([a, b])` in schema.prisma;
   - SQL migrations: `UNIQUE` columns and constraints in CREATE TABLE,
     `CREATE UNIQUE INDEX … ON table (…)`;
   - JPA `@Column(unique = true)` and `@Table(uniqueConstraints = …)`;
   - EF Core `HasIndex(x => x.Email).IsUnique()` on `Entity<T>()`;
   - Django `unique=True`, SQLAlchemy `unique=True`;
   - TypeORM `@Column({ unique: true })` and `@Unique([...])`.
   Each becomes `persistence-constraint` evidence with the entity and its
   fields. It is not tied to an endpoint: candidates attach it to the
   conflict (409) scenarios of the aggregate with the same name, which
   are then confirmed, or ask what happens on a duplicate.
   ========================================================================== */

import fs from 'fs';
import { isTestFile } from '../../discovery';
import { makeEvidence, type SourceEvidence } from '../../evidence';
import type { SourceAnalyzer } from '../../registry';

const ID = 'persistence/constraints';

const pascal = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
/** `order_items` → OrderItem, `users` → User, `Customer` → Customer. */
export function entityFromTable(table: string): string {
  const p = pascal(table.replace(/^["'`[]|["'`\]]$/g, '').split('.').pop()!);
  if (/ies$/.test(p)) return p.slice(0, -3) + 'y';
  if (/(ss|us)$/.test(p)) return p;
  if (/(sses|xes|ches|shes)$/.test(p)) return p.slice(0, -2);
  return p.replace(/s$/, '');
}

interface Found { entity: string; fields: string[]; line: number; how: string }

const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

/** The innermost class (or model/entity block) declared before an offset. */
function enclosing(text: string, offset: number, pattern: RegExp): string | undefined {
  let name: string | undefined;
  for (const m of text.slice(0, offset).matchAll(pattern)) name = m[1];
  return name;
}

export function constraintsIn(rel: string, text: string): Found[] {
  const out: Found[] = [];
  if (/\.prisma$/.test(rel)) {
    for (const m of text.matchAll(/^\s*(\w+)\s+\w+[?[\]]*[^\n]*@unique\b/gm)) out.push({ entity: enclosing(text, m.index!, /\bmodel\s+(\w+)\s*\{/g) ?? '?', fields: [m[1]], line: lineAt(text, m.index!), how: '@unique' });
    for (const m of text.matchAll(/@@unique\(\s*(?:fields:\s*)?\[([^\]]+)\]/g)) out.push({ entity: enclosing(text, m.index!, /\bmodel\s+(\w+)\s*\{/g) ?? '?', fields: m[1].split(',').map(s => s.trim()), line: lineAt(text, m.index!), how: '@@unique' });
  } else if (/\.sql$/i.test(rel)) {
    for (const t of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`[\]]+)\s*\(([\s\S]*?)\);/gi)) {
      const body = t[2];
      const start = t.index! + t[0].indexOf(body);
      for (const c of body.matchAll(/^\s*["`[]?(\w+)["`\]]?\s+[\w()]+[^,\n]*\bunique\b/gim)) {
        if (/^(unique|constraint|primary|foreign|check|index|key)$/i.test(c[1])) continue;
        out.push({ entity: entityFromTable(t[1]), fields: [c[1]], line: lineAt(text, start + c.index!), how: 'UNIQUE column' });
      }
      for (const c of body.matchAll(/unique\s*\(([^)]+)\)/gi)) out.push({ entity: entityFromTable(t[1]), fields: c[1].split(',').map(s => s.trim().replace(/["`[\]]/g, '')), line: lineAt(text, start + c.index!), how: 'UNIQUE constraint' });
    }
    for (const m of text.matchAll(/create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?[\w"`]+\s+on\s+([\w."`[\]]+)\s*\(([^)]+)\)/gi)) out.push({ entity: entityFromTable(m[1]), fields: m[2].split(',').map(s => s.trim().replace(/["`[\]]/g, '')), line: lineAt(text, m.index!), how: 'unique index' });
  } else if (/\.(java|kt)$/.test(rel)) {
    for (const m of text.matchAll(/@Column\s*\([^)]*\bunique\s*=\s*true[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:private|protected|public|val|var)?\s*(?:final\s+)?(?:[\w<>?,]+\s+)?(\w+)\s*[:;=]/g)) {
      out.push({ entity: enclosing(text, m.index!, /\bclass\s+(\w+)/g) ?? '?', fields: [m[1]], line: lineAt(text, m.index!), how: '@Column(unique = true)' });
    }
    for (const m of text.matchAll(/@UniqueConstraint\s*\([^)]*columnNames\s*=\s*[{[]([^}\]]+)[}\]]/g)) {
      const after = text.slice(m.index!).match(/\bclass\s+(\w+)/);
      out.push({ entity: after?.[1] ?? '?', fields: m[1].split(',').map(s => s.trim().replace(/"/g, '')), line: lineAt(text, m.index!), how: '@UniqueConstraint' });
    }
  } else if (/\.cs$/.test(rel)) {
    for (const m of text.matchAll(/Entity<(\w+)>\(\)[\s\S]{0,200}?HasIndex\(\s*\w+\s*=>\s*(?:new\s*\{\s*)?([^)}]+?)\s*\}?\s*\)\s*\.IsUnique\(\)/g)) out.push({ entity: m[1], fields: m[2].split(',').map(s => s.trim().split('.').pop()!), line: lineAt(text, m.index!), how: 'HasIndex().IsUnique()' });
    for (const m of text.matchAll(/\[Index\(([^)]*)IsUnique\s*=\s*true[^)]*\)\]\s*(?:\[[^\]]*\]\s*)*(?:public\s+)?(?:partial\s+)?class\s+(\w+)/g)) out.push({ entity: m[2], fields: [...m[1].matchAll(/(?:nameof\((?:\w+\.)?(\w+)\)|"(\w+)")/g)].map(x => x[1] ?? x[2]), line: lineAt(text, m.index!), how: '[Index(IsUnique = true)]' });
  } else if (/\.py$/.test(rel)) {
    for (const m of text.matchAll(/^\s*(\w+)\s*(?::\s*[\w[\]., ]+)?=\s*(?:models\.\w+|Column|mapped_column|db\.Column)\([^\n]*\bunique\s*=\s*True/gm)) out.push({ entity: enclosing(text, m.index!, /^class\s+(\w+)/gm) ?? '?', fields: [m[1]], line: lineAt(text, m.index!), how: 'unique=True' });
  } else if (/\.(ts|js)$/.test(rel)) {
    for (const m of text.matchAll(/@Column\(\s*\{[^}]*\bunique\s*:\s*true[^}]*\}\s*\)\s*(\w+)[!?]?\s*:/g)) out.push({ entity: enclosing(text, m.index!, /\bclass\s+(\w+)/g) ?? '?', fields: [m[1]], line: lineAt(text, m.index!), how: '@Column({ unique: true })' });
    for (const m of text.matchAll(/@Unique\(\s*(?:['"]\w+['"]\s*,\s*)?\[([^\]]+)\]\s*\)\s*(?:@\w+\([^)]*\)\s*)*(?:export\s+)?class\s+(\w+)/g)) out.push({ entity: m[2], fields: m[1].split(',').map(s => s.trim().replace(/['"]/g, '')), line: lineAt(text, m.index!), how: '@Unique' });
  }
  return out.filter(f => f.entity !== '?' && f.fields.length && !/^(id|uuid)$/i.test(f.fields.join('')));
}

const UNIQUE_HINT = /@@?unique\b|\bunique\s*[=:]\s*(true|True)|IsUnique|\bUNIQUE\b|@Unique\(|@UniqueConstraint/;
const relevant = (rel: string) => /\.(prisma|sql)$/i.test(rel) || /\.(java|kt|cs|py|ts|js)$/.test(rel);
const skipped = (rel: string) => isTestFile(rel) || /(^|\/)(node_modules|dist|build|target|generated|bin|obj)\//.test(rel);

const constraints: SourceAnalyzer = {
  id: ID,
  language: 'any',
  frameworks: ['prisma', 'sql', 'jpa', 'ef-core', 'django', 'sqlalchemy', 'typeorm'],
  maturity: 'beta',
  detect(ctx) {
    // Only when some file declares one: the analyzer is not listed for code without constraints.
    return ctx.files.filter(f => relevant(f.rel) && !skipped(f.rel)).slice(0, 4000).some(f => {
      try { return UNIQUE_HINT.test(fs.readFileSync(f.abs, 'utf8')); } catch { return false; }
    });
  },
  async analyze(ctx) {
    const out: SourceEvidence[] = [];
    for (const f of ctx.files.filter(x => relevant(x.rel) && !skipped(x.rel))) {
      let text: string;
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      if (!UNIQUE_HINT.test(text)) continue;
      for (const c of constraintsIn(f.rel, text)) {
        out.push(makeEvidence({
          kind: 'persistence-constraint', extractor: ID, confidence: 'confirmed',
          location: { file: f.rel, startLine: c.line, endLine: c.line },
          symbol: `${c.entity}.${c.fields.join('+')}`, description: `${c.entity} is unique on ${c.fields.join(', ')} (${c.how})`,
          metadata: { entity: c.entity, fields: c.fields, how: c.how }, key: `${c.entity}|${c.fields.join(',')}|${c.how}`
        }));
      }
    }
    return out;
  }
};

export default constraints;
