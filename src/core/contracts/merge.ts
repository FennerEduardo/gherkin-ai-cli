/* ==========================================================================
   gherkin-ai-cli - Service-wide contracts merged from per-feature contracts

   Each feature owns contracts/<feature>/openapi.json and asyncapi.json. The
   service's root openapi.json / asyncapi.json are the union of all of them, so
   generating feature B no longer replaces feature A's routes and channels.
   ========================================================================== */

import fs from 'fs';
import path from 'path';

export const CONTRACTS_DIR = 'contracts';

type Doc = Record<string, any>;

/** Directory name of a feature's contracts: the feature file name, or the kebab-cased feature name. */
export function featureContractSlug(sourceFile: string | undefined, featureName: string): string {
  const fromFile = sourceFile && /\.feature$/i.test(sourceFile) ? path.basename(sourceFile).replace(/\.feature$/i, '') : '';
  const base = fromFile || featureName;
  return base
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'feature';
}

/** Shallow union of object maps; for the same key the later document wins, except nested method maps which are merged. */
function unionMaps(target: Doc, source: Doc | undefined, deep = false): Doc {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = deep && target[key] && typeof target[key] === 'object' && typeof value === 'object'
      ? { ...target[key], ...value }
      : value;
  }
  return target;
}

function unionComponents(docs: Doc[]): Doc | undefined {
  const components: Doc = {};
  for (const d of docs) {
    for (const [section, entries] of Object.entries(d.components ?? {})) {
      components[section] = unionMaps(components[section] ?? {}, entries as Doc);
    }
  }
  return Object.keys(components).length ? components : undefined;
}

function unionTags(docs: Doc[]): Doc[] | undefined {
  const byName = new Map<string, Doc>();
  for (const d of docs) for (const tag of d.tags ?? []) if (tag?.name && !byName.has(tag.name)) byName.set(tag.name, tag);
  return byName.size ? [...byName.values()] : undefined;
}

const title = (projectName: string, kind: string) => `${projectName} ${kind}`;

/** OpenAPI: union of paths (methods merged per path), components and tags. */
export function mergeOpenApi(docs: Doc[], projectName: string): Doc {
  if (!docs.length) return {};
  const last = docs[docs.length - 1];
  const paths: Doc = {};
  for (const d of docs) unionMaps(paths, d.paths, true);
  const merged: Doc = {
    ...last,
    info: { ...(last.info ?? {}), title: title(projectName, 'API'), description: `Service API of ${projectName}, merged from ${docs.length} feature contract(s) in ${CONTRACTS_DIR}/.` },
    paths
  };
  const components = unionComponents(docs);
  if (components) merged.components = components;
  const tags = unionTags(docs);
  if (tags) merged.tags = tags;
  return merged;
}

/** AsyncAPI (2.x and 3.x): union of channels, operations, components and tags. */
export function mergeAsyncApi(docs: Doc[], projectName: string): Doc {
  if (!docs.length) return {};
  const last = docs[docs.length - 1];
  const channels: Doc = {};
  const operations: Doc = {};
  for (const d of docs) {
    unionMaps(channels, d.channels);
    unionMaps(operations, d.operations);
  }
  const merged: Doc = {
    ...last,
    info: { ...(last.info ?? {}), title: title(projectName, 'Events'), description: `Events of ${projectName}, merged from ${docs.length} feature contract(s) in ${CONTRACTS_DIR}/.` },
    channels
  };
  if (Object.keys(operations).length) merged.operations = operations;
  const components = unionComponents(docs);
  if (components) merged.components = components;
  const tags = unionTags(docs);
  if (tags) merged.tags = tags;
  return merged;
}

const readJson = (file: string): Doc | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

/**
 * The per-feature documents named `fileName` under <outDir>/contracts/*, with `current` replacing the
 * one of `currentSlug` (it is about to be written). Sorted by feature for a stable result.
 */
export function collectFeatureContracts(outDir: string, fileName: string, currentSlug: string, current: Doc | undefined): Doc[] {
  const root = path.join(outDir, CONTRACTS_DIR);
  const bySlug = new Map<string, Doc>();
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* no contracts yet */ }
  for (const slug of dirs) {
    if (slug === currentSlug) continue;
    const doc = readJson(path.join(root, slug, fileName));
    if (doc) bySlug.set(slug, doc);
  }
  if (current) bySlug.set(currentSlug, current);
  return [...bySlug.keys()].sort().map(slug => bySlug.get(slug) as Doc);
}
