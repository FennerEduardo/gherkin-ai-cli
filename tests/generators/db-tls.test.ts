import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { renderDeploymentTargets } from '../../src/generators/deploy/targets';

const parsed = parseGherkinText(['Feature: Order checkout', '  Scenario: Pay', '    Given a cart', '    When the customer pays', '    Then the order is paid'].join('\n'));
const generated = (language: string, framework: string, extra: Record<string, string> = {}) =>
  generatePresets(parsed, { ...defaultConfig, stack: { ...defaultConfig.stack, language, framework, ...extra } }).map(f => f.content).join('\n');

// Managed PostgreSQL (RDS, Cloud SQL, Azure) is reached with DATABASE_URL=...?sslmode=require: every runtime must keep it.
describe('database TLS from DATABASE_URL (sslmode)', () => {
  it('JVM: the JDBC URL keeps the query (pgjdbc reads sslmode) in the runtime, Spring and Quarkus', () => {
    for (const [language, framework] of [['java', 'spring'], ['kotlin', 'spring'], ['java', 'quarkus']]) {
      const code = generated(language, framework);
      expect(code).toContain('uri.getRawQuery()');
      expect(code).not.toContain('"jdbc:postgresql://" + uri.getHost() + ":" + (uri.getPort() > 0 ? uri.getPort() : 5432) + uri.getPath()');
    }
    expect(generated('java', 'spring')).toContain('.url(ConnectionFactory.jdbcUrl(uri))');
    expect(generated('java', 'quarkus')).toContain('"quarkus.datasource.jdbc.url", ConnectionFactory.jdbcUrl(uri)');
  });

  it('.NET maps sslmode and sslrootcert onto Npgsql', () => {
    const code = generated('csharp', 'dotnet');
    expect(code).toContain('builder.SslMode = Enum.Parse<SslMode>');
    expect(code).toContain('builder.RootCertificate = value');
  });

  it('Node asks node-postgres for libpq semantics, so sslmode=require does not reject private CAs', () => {
    for (const framework of ['nestjs', 'express']) {
      const code = generated('typescript', framework);
      expect(code).toContain('uselibpqcompat=true');
      expect(code).toContain('new Pool({ connectionString: pgConnectionString() })');
      // The generated tests too: they run against the same TLS-only database.
      expect(code).not.toMatch(/new Pool\(\{ connectionString: (process\.env\.)?DATABASE_URL/);
    }
    expect(generated('typescript', 'nestjs', { ormVersion: '7' })).toContain('&uselibpqcompat=true` : process.env.DATABASE_URL })');
  });

  it('Terraform connects with sslmode=require and makes the database refuse plaintext by default', () => {
    for (const cloud of ['aws', 'gcp', 'azure'] as const) {
      const tf = renderDeploymentTargets({ ...defaultConfig, stack: { ...defaultConfig.stack, language: 'typescript', framework: 'nestjs' }, deploy: { cloud } })
        .map(f => f.content).join('\n');
      expect(tf, cloud).toMatch(/postgres:\/\/[^"]*\?sslmode=require"/);
      expect(tf, cloud).toMatch(/variable "db_require_tls" \{[^}]*default\s+= true/);
    }
  });

  it('Elixir, PHP and Rust honour sslmode', () => {
    expect(generated('elixir', 'phoenix')).toContain('"require" -> [ssl: [verify: :verify_none]]');
    expect(generated('php', 'laravel')).toContain("TLS_PARAMETERS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']");
    expect(generated('rust', 'axum')).toContain('"tls-rustls"');
  });
});
