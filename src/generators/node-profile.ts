/* ==========================================================================
   gherkin-ai-cli - NestJS / Prisma version profile for generated Node backends

   stack.frameworkVersion (NestJS)   11 (default, CommonJS) | 12 (ESM-only)
   stack.ormVersion       (Prisma)   6  (default, prisma-client-js)
                                     7  (prisma-client generator, prisma.config.ts,
                                         driver adapter per database)

   NestJS 12 ships only as ES modules, so its projects are generated as
   "type": "module" with .js import specifiers. Every combination is verified by
   a golden build (scripts/golden-stacks.js): nestjs, nestjs-12, nestjs-prisma7,
   nestjs-12-prisma6, express, express-prisma7.
   ========================================================================== */

import path from 'path';
import type { GherkinAIConfig } from '../core/config';
import { ConfigError } from '../core/errors';

export const NEST_MAJORS = ['11', '12'] as const;
export const PRISMA_MAJORS = ['6', '7'] as const;
export type NestMajor = (typeof NEST_MAJORS)[number];
export type PrismaMajor = (typeof PRISMA_MAJORS)[number];
export type PrismaDatabase = 'postgresql' | 'mysql' | 'sqlite';

export interface NodeProfile {
  /** NestJS major (only meaningful for NestJS projects). */
  nest: NestMajor;
  /** Prisma major (only meaningful when stack.orm is prisma). */
  prisma: PrismaMajor;
  /** Generate an ES module project ("type": "module"). */
  esm: boolean;
  /** Suffix for relative import specifiers: ESM requires the emitted file extension. */
  ext: '' | '.js';
  database: PrismaDatabase;
}

export interface PrismaAdapter {
  pkg: string;
  className: string;
  /** Constructor expression for the adapter. */
  create: string;
}

const lower = (v: string | undefined) => (v || '').trim().toLowerCase();
const isNest = (framework: string) => framework === 'nestjs' || framework === 'nest';

/** "12", "12.1.0", "^12", "v12.x" -> "12" */
export function majorOf(version: string | undefined): string | undefined {
  const m = /^[\s^~=v]*(\d+)/.exec(version ?? '');
  return m?.[1];
}

/** Prisma datasource provider for stack.database (unknown engines fall back to SQLite). */
export function prismaDatabase(database: string | undefined): PrismaDatabase {
  const db = lower(database);
  if (db.startsWith('postgres')) return 'postgresql';
  if (db === 'mysql' || db === 'mariadb') return 'mysql';
  return 'sqlite';
}

export function resolveNodeProfile(config: Pick<GherkinAIConfig, 'stack'>): NodeProfile {
  const framework = lower(config.stack.framework);
  const nestProject = isNest(framework);

  const nest = (nestProject ? majorOf(config.stack.frameworkVersion) : undefined) ?? '11';
  if (!(NEST_MAJORS as readonly string[]).includes(nest)) {
    throw new ConfigError(`stack.frameworkVersion "${config.stack.frameworkVersion}" is not supported for NestJS.`, {
      hint: `Supported NestJS majors: ${NEST_MAJORS.join(', ')} (default 11).`
    });
  }

  const prismaProject = lower(config.stack.orm) === 'prisma';
  const prisma = (prismaProject ? majorOf(config.stack.ormVersion) : undefined) ?? '6';
  if (!(PRISMA_MAJORS as readonly string[]).includes(prisma)) {
    throw new ConfigError(`stack.ormVersion "${config.stack.ormVersion}" is not supported for Prisma.`, {
      hint: `Supported Prisma majors: ${PRISMA_MAJORS.join(', ')} (default 6).`
    });
  }
  if (prisma === '7' && lower(config.stack.database) === 'mongodb') {
    throw new ConfigError('Prisma 7 does not support MongoDB.', { hint: 'Use stack.ormVersion "6" with MongoDB.' });
  }

  const esm = nestProject && nest === '12';
  return { nest: nest as NestMajor, prisma: prisma as PrismaMajor, esm, ext: esm ? '.js' : '', database: prismaDatabase(config.stack.database) };
}

/** Dependency ranges per major (newest minor verified by the golden builds). */
export const NEST_DEPENDENCIES: Record<NestMajor, Record<string, string>> = {
  '11': {
    '@nestjs/common': '^11.1.0',
    '@nestjs/core': '^11.1.0',
    '@nestjs/cqrs': '^11.0.0',
    '@nestjs/platform-express': '^11.1.0',
    '@nestjs/schedule': '^6.0.0'
  },
  '12': {
    '@nestjs/common': '^12.1.0',
    '@nestjs/core': '^12.1.0',
    '@nestjs/cqrs': '^12.1.0',
    '@nestjs/platform-express': '^12.1.0',
    '@nestjs/schedule': '^12.0.0'
  }
};

export const PRISMA_VERSION: Record<PrismaMajor, string> = { '6': '^6.19.0', '7': '^7.10.0' };

/** Prisma 7 driver adapter for the configured database. */
export function prismaAdapter(database: PrismaDatabase): PrismaAdapter {
  switch (database) {
    case 'postgresql':
      return { pkg: '@prisma/adapter-pg', className: 'PrismaPg', create: 'new PrismaPg({ connectionString: process.env.DATABASE_URL })' };
    case 'mysql':
      // Accepts mysql:// URLs as well as mariadb://.
      return { pkg: '@prisma/adapter-mariadb', className: 'PrismaMariaDb', create: "new PrismaMariaDb(process.env.DATABASE_URL ?? '')" };
    default:
      return { pkg: '@prisma/adapter-better-sqlite3', className: 'PrismaBetterSqlite3', create: "new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? 'file:./dev.db' })" };
  }
}

/** Where the Prisma 7 client is generated, relative to the project root (compiled with the sources). */
export const PRISMA7_CLIENT_DIR = 'src/generated/prisma';

/** The `generator` and `datasource` blocks of schema.prisma. */
export function renderPrismaHeader(profile: NodeProfile): string {
  if (profile.prisma === '7') {
    return `generator client {
  provider     = "prisma-client"
  output       = "../${PRISMA7_CLIENT_DIR}"
  moduleFormat = "${profile.esm ? 'esm' : 'cjs'}"
}

// Prisma 7 reads the connection URL from prisma.config.ts.
datasource db {
  provider = "${profile.database}"
}
`;
  }
  return `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${profile.database}"
  url      = env("DATABASE_URL")
}
`;
}

export function renderPrismaConfig(): string {
  return `import { defineConfig } from 'prisma/config';

// Prisma 7 configuration: schema location and the connection URL (no longer in schema.prisma).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' }
});
`;
}

/**
 * Module specifier of the Prisma client, as imported from `fromDir` (a project-relative directory).
 * Prisma 6: '@prisma/client'. Prisma 7: the generated client inside the sources.
 */
export function prismaClientImport(profile: NodeProfile, fromDir: string): string {
  if (profile.prisma !== '7') return '@prisma/client';
  const rel = path.posix.relative(fromDir, `${PRISMA7_CLIENT_DIR}/client`);
  return `${rel.startsWith('.') ? rel : `./${rel}`}${profile.ext}`;
}

/** Adds the ".js" extension that Node's ESM resolver requires to relative import specifiers. */
export function withEsmImportExtensions(source: string): string {
  return source.replace(/(\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"]+?)\2/gm, (match, lead, quote, spec) =>
    /\.(c|m)?js$|\.json$/.test(spec) ? match : `${lead}${quote}${spec}.js${quote}`
  );
}
