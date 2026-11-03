/* ==========================================================================
   gherkin-ai-cli - Go runtime kernel on MySQL 8 (stack.kernelDatabase
   "mysql"; PLAN-3.3.0 X-01b). chi.

   Same approach as the other kernels (typescript-mysql.ts, jvm-mysql.ts,
   python-mysql.ts, csharp-mysql.ts): the PostgreSQL kernel is generated,
   then adapted:
     - internal/runtime/db.go: database/sql + go-sql-driver/mysql (MPL-2.0)
       behind the small part of the pgx interface the kernel uses
       (Pool.Exec / Query / QueryRow / Begin, Tx.Commit / Rollback,
       CommandTag.RowsAffected, ErrNoRows). Statements keep PostgreSQL's
       $1..$n, which are bound as MySQL's positional ? in the order they
       appear (some statements use them out of order);
     - a schema is a MySQL database (the tests use one per test; "public"
       is the database of DATABASE_URL); migrations serialized with GET_LOCK
       on one connection;
     - ON CONFLICT DO NOTHING -> INSERT IGNORE; the aggregate upsert ->
       ON DUPLICATE KEY UPDATE; `key` quoted; now() -> CURRENT_TIMESTAMP(6);
     - the outbox claim (UPDATE ... RETURNING does not exist in MySQL):
       SELECT ... FOR UPDATE SKIP LOCKED, UPDATE the lease, read back, in
       one transaction;
     - go.mod requires go-sql-driver/mysql instead of pgx.
   Tenant isolation is the repository filter (tenant_id in every query):
   MySQL has no row-level security.
   ========================================================================== */

import { MYSQL_RUNTIME_TABLES, MYSQL_SCHEMA_TOKEN } from './typescript-mysql';

type File = { filename: string; content: string };

const go = (s: string) => JSON.stringify(s);

export const GO_MYSQL_REQUIRE = 'github.com/go-sql-driver/mysql v1.8.1';

const DB_GO = `package runtime

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-sql-driver/mysql"
)

// ErrNoRows is returned by Row.Scan when the query selected nothing.
var ErrNoRows = sql.ErrNoRows

// Pool is the database of the runtime kernel on MySQL (stack.kernelDatabase "mysql"): database/sql with
// go-sql-driver/mysql behind the small part of the pgx interface the kernel uses. Statements keep PostgreSQL's
// $1..$n parameters; they are bound as MySQL's positional ? in the order they appear.
type Pool struct {
	db       *sql.DB
	database string
}

// NewPool opens mysql://user:password@host:3306/database[?ssl-mode=REQUIRED]. Like pgxpool.New it connects lazily.
func NewPool(_ context.Context, databaseURL string) (*Pool, error) {
	u, err := url.Parse(databaseURL)
	if err != nil {
		return nil, err
	}
	cfg := mysql.NewConfig()
	cfg.Net = "tcp"
	port := u.Port()
	if port == "" {
		port = "3306"
	}
	cfg.Addr = u.Hostname() + ":" + port
	cfg.User = u.User.Username()
	cfg.Passwd, _ = u.User.Password()
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	cfg.ParseTime = true
	cfg.TLSConfig = "preferred"
	for key, values := range u.Query() {
		k := strings.ReplaceAll(strings.ToLower(key), "_", "-")
		if (k == "ssl-mode" || k == "sslmode") && len(values) > 0 {
			switch strings.ToLower(values[0]) {
			case "disable", "disabled":
				cfg.TLSConfig = "false"
			case "require", "required":
				cfg.TLSConfig = "skip-verify" // encrypt without verifying, as libpq's sslmode=require
			case "verify-ca", "verify-full", "verify-identity", "verify_identity":
				cfg.TLSConfig = "true"
			}
		}
	}
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, err
	}
	return &Pool{db: db, database: cfg.DBName}, nil
}

// Close closes the pool.
func (p *Pool) Close() { _ = p.db.Close() }

// CommandTag reports the rows a statement changed.
type CommandTag struct{ rows int64 }

// RowsAffected is the number of rows the statement inserted, updated or deleted.
func (t CommandTag) RowsAffected() int64 { return t.rows }

type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

var placeholder = regexp.MustCompile(\`\\$(\\d+)\`)

// bind turns $1..$n into ? and orders the arguments to match (a statement may use them out of order or twice).
func bind(query string, args []any) (string, []any) {
	var ordered []any
	text := placeholder.ReplaceAllStringFunc(query, func(m string) string {
		if i, err := strconv.Atoi(m[1:]); err == nil && i >= 1 && i <= len(args) {
			ordered = append(ordered, args[i-1])
		}
		return "?"
	})
	if ordered == nil {
		return text, args
	}
	return text, ordered
}

func execOn(ctx context.Context, q querier, query string, args []any) (CommandTag, error) {
	text, bound := bind(query, args)
	res, err := q.ExecContext(ctx, text, bound...)
	if err != nil {
		return CommandTag{}, err
	}
	n, err := res.RowsAffected()
	return CommandTag{n}, err
}

func queryOn(ctx context.Context, q querier, query string, args []any) (*sql.Rows, error) {
	text, bound := bind(query, args)
	return q.QueryContext(ctx, text, bound...)
}

func queryRowOn(ctx context.Context, q querier, query string, args []any) *sql.Row {
	text, bound := bind(query, args)
	return q.QueryRowContext(ctx, text, bound...)
}

func (p *Pool) Exec(ctx context.Context, query string, args ...any) (CommandTag, error) {
	return execOn(ctx, p.db, query, args)
}

func (p *Pool) Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return queryOn(ctx, p.db, query, args)
}

func (p *Pool) QueryRow(ctx context.Context, query string, args ...any) *sql.Row {
	return queryRowOn(ctx, p.db, query, args)
}

// Begin starts a transaction.
func (p *Pool) Begin(ctx context.Context) (*Tx, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	return &Tx{tx: tx}, nil
}

// Tx is a transaction (pgx.Tx's methods the kernel uses).
type Tx struct{ tx *sql.Tx }

func (t *Tx) Exec(ctx context.Context, query string, args ...any) (CommandTag, error) {
	return execOn(ctx, t.tx, query, args)
}

func (t *Tx) Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return queryOn(ctx, t.tx, query, args)
}

func (t *Tx) QueryRow(ctx context.Context, query string, args ...any) *sql.Row {
	return queryRowOn(ctx, t.tx, query, args)
}

func (t *Tx) Commit(_ context.Context) error { return t.tx.Commit() }

// Rollback is a no-op after Commit.
func (t *Tx) Rollback(_ context.Context) error {
	if err := t.tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		return err
	}
	return nil
}
`;

const SCHEMA_GO = `package runtime

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

var statements = []string{
${MYSQL_RUNTIME_TABLES.map(s => `\t${go(s)},`).join('\n')}
}

// Tenant isolation is the repository filter (tenant_id in every query): MySQL has no row-level security.

var schemaPattern = regexp.MustCompile(\`^[A-Za-z0-9_$-]{1,64}$\`)

func (p *Pool) plain(schema string) string {
	if schema == "" || schema == "public" {
		if p.database != "" {
			return p.database
		}
		return "app"
	}
	return schema
}

// SchemaName validates a schema, which on MySQL is a database, and quotes it; "public" is the pool's database.
func (p *Pool) SchemaName(schema string) (string, error) {
	s := p.plain(schema)
	if !schemaPattern.MatchString(s) {
		return "", fmt.Errorf("invalid schema name: %s", s)
	}
	return "\`" + s + "\`", nil
}

// Migrate creates the runtime tables (idempotent); replicas starting together are serialized with a named lock.
// Another database than the pool's (tests) is created first; the service's own is never created here, so its user
// needs no global CREATE privilege.
func Migrate(ctx context.Context, pool *Pool, schema string) error {
	s, err := pool.SchemaName(schema)
	if err != nil {
		return err
	}
	conn, err := pool.db.Conn(ctx) // GET_LOCK belongs to one connection
	if err != nil {
		return err
	}
	defer conn.Close()
	var locked sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK('ghk_runtime_schema', 60)").Scan(&locked); err != nil {
		return err
	}
	defer func() {
		var released sql.NullInt64
		_ = conn.QueryRowContext(context.Background(), "SELECT RELEASE_LOCK('ghk_runtime_schema')").Scan(&released)
	}()
	if pool.plain(schema) != pool.database {
		if _, err := conn.ExecContext(ctx, "CREATE DATABASE IF NOT EXISTS "+s); err != nil {
			return err
		}
	}
	for _, statement := range statements {
		if _, err := conn.ExecContext(ctx, strings.ReplaceAll(statement, ${go(MYSQL_SCHEMA_TOKEN)}, s)); err != nil {
			return err
		}
	}
	return nil
}
`;

/** The outbox claim in one transaction: MySQL's UPDATE returns no rows. */
const CLAIM = `	// MySQL has no UPDATE ... RETURNING: lock the next batch (SKIP LOCKED), lease it and read it back.
	type claimed struct{ id, tenant, eventType, payload, traceparent string }
	var batch []claimed
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	rows, err := tx.Query(ctx, "SELECT id FROM "+r.s+".ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL "+
		"AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(6)) ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED", limit)
	if err != nil {
		return 0, err
	}
	var due []any
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		due = append(due, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(due) > 0 {
		marks := strings.TrimSuffix(strings.Repeat("?, ", len(due)), ", ")
		lease := append([]any{workerID, r.LeaseSeconds}, due...)
		if _, err := tx.Exec(ctx, "UPDATE "+r.s+".ghk_outbox SET claimed_by = ?, claimed_until = CURRENT_TIMESTAMP(6) + INTERVAL ? SECOND, "+
			"attempts = attempts + 1 WHERE id IN ("+marks+")", lease...); err != nil {
			return 0, err
		}
		claimedRows, err := tx.Query(ctx, "SELECT id, tenant_id, event_type, payload, traceparent FROM "+r.s+".ghk_outbox WHERE id IN ("+marks+") ORDER BY created_at", due...)
		if err != nil {
			return 0, err
		}
		for claimedRows.Next() {
			var c claimed
			var tp *string
			if err := claimedRows.Scan(&c.id, &c.tenant, &c.eventType, &c.payload, &tp); err != nil {
				claimedRows.Close()
				return 0, err
			}
			if tp != nil {
				c.traceparent = *tp
			}
			batch = append(batch, c)
		}
		claimedRows.Close()
		if err := claimedRows.Err(); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
`;

const CLAIM_BLOCK = /\trows, err := r\.pool\.Query\(ctx, "UPDATE "\+r\.s\+"\.ghk_outbox SET claimed_by[\s\S]*?\trows\.Close\(\)\n\tif err := rows\.Err\(\); err != nil \{\n\t\treturn 0, err\n\t\}\n/;

/** [PostgreSQL text, MySQL text] pairs as they appear in the generated Go sources. */
const STATEMENTS: [string, string][] = [
  [`".ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING"`,
    `".ghk_idempotency (tenant_id, \`key\`, status) VALUES ($1, $2, 'PROCESSING')"`],
  [`tx.Exec(ctx, "INSERT INTO "+svc.s+".ghk_idempotency`, `tx.Exec(ctx, "INSERT IGNORE INTO "+svc.s+".ghk_idempotency`],
  [`ghk_idempotency WHERE tenant_id = $1 AND key = $2`, `ghk_idempotency WHERE tenant_id = $1 AND \`key\` = $2`],
  [`WHERE tenant_id = $1 AND key = $2", req.TenantID, req.IdempotencyKey, string(response))`, `WHERE tenant_id = $1 AND \`key\` = $2", req.TenantID, req.IdempotencyKey, string(response))`],
  [`"ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()"`,
    `"AS incoming ON DUPLICATE KEY UPDATE state = incoming.state, version = incoming.version, updated_at = CURRENT_TIMESTAMP(6)"`],
  [`"INSERT INTO "+c.s+".ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"`,
    `"INSERT IGNORE INTO "+c.s+".ghk_inbox (consumer, message_id) VALUES ($1, $2)"`],
  [`"INSERT INTO "+o.s+".ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING"`,
    `"INSERT IGNORE INTO "+o.s+".ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING')"`],
  ['s, err := SchemaName(schema)', 's, err := pool.SchemaName(schema)'],
  ['pgx.ErrNoRows', 'ErrNoRows'],
  ['Tx        pgx.Tx', 'Tx        *Tx'],
  // Runtime integration tests: a schema is a database.
  [`"DROP SCHEMA IF EXISTS "+e.schema+" CASCADE"`, `"DROP DATABASE IF EXISTS "+e.schema`],
  [`"ghk_idempotency", "key = $1"`, `"ghk_idempotency", "\`key\` = $1"`],
  ['against PostgreSQL', 'against MySQL'],
  // go.mod
  ['github.com/jackc/pgx/v5 v5.7.1', GO_MYSQL_REQUIRE]
];

/** Adapts a generated Go project (PostgreSQL kernel) to MySQL; also its go.mod (contracts.ts). */
export function mysqlizeGoProject(files: File[]): File[] {
  const out = files.map(f => {
    if (f.filename === 'internal/runtime/schema.go') return { ...f, content: SCHEMA_GO };
    if (!/(\.go|(^|\/)go\.mod)$/.test(f.filename)) return f;
    let content = f.content;
    for (const [pg, my] of STATEMENTS) content = content.split(pg).join(my);
    if (f.filename.endsWith('.go')) {
      // By package, not directory: internal/runtime holds external tests (package runtime_test) too.
      const inRuntime = /^package runtime$/m.test(content);
      if (CLAIM_BLOCK.test(content)) {
        content = content.replace(CLAIM_BLOCK, () => CLAIM).replace(/^import \(\n\t"context"\n/m, 'import (\n\t"context"\n\t"strings"\n');
      }
      content = content
        .replace(/^\t"github\.com\/jackc\/pgx\/v5(\/pgxpool)?"\n/gm, '')
        .replace(/\bpgxpool\.New\(/g, inRuntime ? 'NewPool(' : 'runtime.NewPool(')
        .replace(/\*pgxpool\.Pool\b/g, inRuntime ? '*Pool' : '*runtime.Pool')
        .replace(/(?<![.\w])now\(\)/g, 'CURRENT_TIMESTAMP(6)');
    }
    return { ...f, content };
  });
  return out.some(f => f.filename === 'internal/runtime/schema.go') ? [...out, { filename: 'internal/runtime/db.go', content: DB_GO }] : out;
}
