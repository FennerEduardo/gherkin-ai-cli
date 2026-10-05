/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for Go (chi)
   pgx + amqp091-go + OpenTelemetry. Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface GoRuntimeFile {
  filename: string;
  content: string;
}

const goStr = (s: string) => JSON.stringify(s);

export function renderGoRuntime(m: DomainModel, module: string): GoRuntimeFile[] {
  const t = topology(m);
  const A = `domain.${m.pascal}Aggregate`;
  const statements = RUNTIME_SCHEMA_SQL.map(s => `\t${goStr(s)},`).join('\n');

  const schema = `// Package runtime is the verified persistence, messaging and tracing path (docs/RUNTIME-KERNEL.md).
package runtime

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

var statements = []string{
${statements}
}

${RLS_NOTE.split('\n').map(l => l.replace(/^-- ?/, '// ')).join('\n')}

var schemaPattern = regexp.MustCompile(\`^[a-z_][a-z0-9_]*$\`)

// SchemaName validates a PostgreSQL schema identifier.
func SchemaName(schema string) (string, error) {
	if schema == "" {
		schema = "public"
	}
	if !schemaPattern.MatchString(schema) {
		return "", fmt.Errorf("invalid schema name: %s", schema)
	}
	return schema, nil
}

// Migrate creates the runtime tables (idempotent).
func Migrate(ctx context.Context, pool *pgxpool.Pool, schema string) error {
	s, err := SchemaName(schema)
	if err != nil {
		return err
	}
	for _, statement := range statements {
		if _, err := pool.Exec(ctx, strings.ReplaceAll(statement, ${goStr(SCHEMA_TOKEN)}, s)); err != nil {
			return err
		}
	}
	return nil
}
`;

  const telemetry = `package runtime

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

var propagator = propagation.TraceContext{}

// Tracer uses the globally registered provider (configure exporters with the OTEL_* variables).
func Tracer() trace.Tracer { return otel.Tracer(${goStr(m.kebab)}) }

// ContextFrom returns a context whose parent is the span described by an incoming traceparent.
func ContextFrom(ctx context.Context, traceparent string) context.Context {
	if traceparent == "" {
		return ctx
	}
	return propagator.Extract(ctx, propagation.MapCarrier{"traceparent": traceparent})
}

// TraceparentOf returns the traceparent header value for a context ("" when it carries no span).
func TraceparentOf(ctx context.Context) string {
	carrier := propagation.MapCarrier{}
	propagator.Inject(ctx, carrier)
	return carrier["traceparent"]
}
`;

  const commandService = `package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"${module}/internal/domain"
)

const aggregateType = ${goStr(m.pascal)}

var commands = map[string]func(*${A}, domain.Command) (domain.DomainEvent, error){
${m.commands.map(c => `\t${goStr(c.snake)}: func(a *${A}, c domain.Command) (domain.DomainEvent, error) { return a.${c.name}(c) },`).join('\n')}
}

type CommandRequest struct {
	TenantID       string
	AggregateID    string
	Command        string
	Payload        map[string]any
	IdempotencyKey string
	// Traceparent is the incoming W3C trace context (e.g. from the HTTP request).
	Traceparent string
}

type CommandResult struct {
	Status      string \`json:"status"\`
	AggregateID string \`json:"aggregateId"\`
	EventType   string \`json:"eventType,omitempty"\`
	Version     int64  \`json:"version,omitempty"\`
}

// CommandService executes a command in one transaction: idempotency claim, aggregate load
// (FOR UPDATE), domain logic, aggregate save and outbox insert. A domain error rolls back everything.
type CommandService struct {
	pool *pgxpool.Pool
	s    string
}

func NewCommandService(pool *pgxpool.Pool, schema string) (*CommandService, error) {
	s, err := SchemaName(schema)
	if err != nil {
		return nil, err
	}
	return &CommandService{pool: pool, s: s}, nil
}

func (svc *CommandService) Handle(ctx context.Context, req CommandRequest) (result CommandResult, err error) {
	if req.TenantID == "" {
		return result, fmt.Errorf("%w: tenant id is required", domain.ErrValidation)
	}
	ctx, span := Tracer().Start(ContextFrom(ctx, req.Traceparent), ${goStr(m.pascal + '.')}+req.Command,
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(attribute.String("tenant.id", req.TenantID), attribute.String("aggregate.id", req.AggregateID)))
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		span.End()
	}()

	tx, err := svc.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	if req.IdempotencyKey != "" {
		tag, err := tx.Exec(ctx, "INSERT INTO "+svc.s+".ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING", req.TenantID, req.IdempotencyKey)
		if err != nil {
			return result, err
		}
		if tag.RowsAffected() == 0 {
			var status string
			var response *string
			if err := tx.QueryRow(ctx, "SELECT status, response FROM "+svc.s+".ghk_idempotency WHERE tenant_id = $1 AND key = $2", req.TenantID, req.IdempotencyKey).Scan(&status, &response); err != nil {
				return result, err
			}
			if err := tx.Commit(ctx); err != nil {
				return result, err
			}
			if status == "COMPLETED" && response != nil {
				if err := json.Unmarshal([]byte(*response), &result); err != nil {
					return result, err
				}
				result.Status = "replayed"
				return result, nil
			}
			return CommandResult{Status: "in-progress", AggregateID: req.AggregateID}, nil
		}
	}

	var state string
	var version int64
	var aggregate *${A}
	err = tx.QueryRow(ctx, "SELECT state, version FROM "+svc.s+".ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE", req.TenantID, aggregateType, req.AggregateID).Scan(&state, &version)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		aggregate, err = domain.New${m.pascal}Aggregate(req.AggregateID)
	case err == nil:
		aggregate, err = domain.Restore${m.pascal}Aggregate(req.AggregateID, domain.State(state), version)
	}
	if err != nil {
		return result, err
	}
	handler, ok := commands[req.Command]
	if !ok {
		return result, fmt.Errorf("%w: unknown command %s", domain.ErrValidation, req.Command)
	}
	event, err := handler(aggregate, domain.Command{ID: req.AggregateID, Payload: req.Payload})
	if err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO "+svc.s+".ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5) "+
		"ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
		req.TenantID, aggregateType, req.AggregateID, string(aggregate.State), aggregate.Version); err != nil {
		return result, err
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return result, err
	}
	var traceparent *string
	if tp := TraceparentOf(ctx); tp != "" {
		traceparent = &tp
	}
	if _, err = tx.Exec(ctx, "INSERT INTO "+svc.s+".ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES ($1, $2, $3, $4, $5, $6)",
		uuid.NewString(), req.TenantID, req.AggregateID, string(event.Type), string(payload), traceparent); err != nil {
		return result, err
	}
	result = CommandResult{Status: "created", AggregateID: req.AggregateID, EventType: string(event.Type), Version: event.Version}
	if req.IdempotencyKey != "" {
		response, _ := json.Marshal(result)
		if _, err = tx.Exec(ctx, "UPDATE "+svc.s+".ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND key = $2", req.TenantID, req.IdempotencyKey, string(response)); err != nil {
			return result, err
		}
	}
	return result, tx.Commit(ctx)
}

// Snapshot is an aggregate as stored for a tenant.
type Snapshot struct {
	State   string
	Version int64
}

// Load returns the aggregate as tenantID sees it (nil for other tenants' aggregates).
func (svc *CommandService) Load(ctx context.Context, tenantID, aggregateID string) (*Snapshot, error) {
	var snap Snapshot
	err := svc.pool.QueryRow(ctx, "SELECT state, version FROM "+svc.s+".ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3", tenantID, aggregateType, aggregateID).Scan(&snap.State, &snap.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &snap, err
}
`;

  const relay = `package runtime

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type Topology struct{ Exchange, Queue, DLX, DLQ string }

// TopologyFor returns the topology for a prefix (use one per environment or test).
func TopologyFor(prefix string) Topology {
	return Topology{prefix + ".events", prefix + ".consumer", prefix + ".dlx", prefix + ".dlq"}
}

var DefaultTopology = Topology{${goStr(t.exchange)}, ${goStr(t.queue)}, ${goStr(t.dlx)}, ${goStr(t.dlq)}}

// DeclareTopology declares a topic exchange -> consumer queue that dead-letters to a fanout DLX -> DLQ.
func DeclareTopology(ch *amqp.Channel, t Topology) error {
	if err := ch.ExchangeDeclare(t.Exchange, "topic", true, false, false, false, nil); err != nil {
		return err
	}
	if err := ch.ExchangeDeclare(t.DLX, "fanout", true, false, false, false, nil); err != nil {
		return err
	}
	if _, err := ch.QueueDeclare(t.DLQ, true, false, false, false, nil); err != nil {
		return err
	}
	if err := ch.QueueBind(t.DLQ, "", t.DLX, false, nil); err != nil {
		return err
	}
	if _, err := ch.QueueDeclare(t.Queue, true, false, false, false, amqp.Table{"x-dead-letter-exchange": t.DLX}); err != nil {
		return err
	}
	return ch.QueueBind(t.Queue, "#", t.Exchange, false, nil)
}

// OutboxRelay publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a
// lease, so concurrent relays never publish the same row; publisher confirms guarantee delivery to
// the broker before a row is marked published. Use one relay (and channel) per goroutine.
type OutboxRelay struct {
	pool         *pgxpool.Pool
	ch           *amqp.Channel
	exchange     string
	s            string
	LeaseSeconds int
	MaxAttempts  int
}

func NewOutboxRelay(pool *pgxpool.Pool, ch *amqp.Channel, exchange, schema string) (*OutboxRelay, error) {
	s, err := SchemaName(schema)
	if err != nil {
		return nil, err
	}
	if err := ch.Confirm(false); err != nil {
		return nil, err
	}
	return &OutboxRelay{pool: pool, ch: ch, exchange: exchange, s: s, LeaseSeconds: ${LEASE_SECONDS}, MaxAttempts: ${MAX_PUBLISH_ATTEMPTS}}, nil
}

func (r *OutboxRelay) PublishBatch(ctx context.Context, workerID string, limit int) (int, error) {
	rows, err := r.pool.Query(ctx, "UPDATE "+r.s+".ghk_outbox SET claimed_by = $1, claimed_until = now() + make_interval(secs => $2), attempts = attempts + 1 "+
		"WHERE id IN (SELECT id FROM "+r.s+".ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < now()) "+
		"ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING id, tenant_id, event_type, payload, traceparent", workerID, r.LeaseSeconds, limit)
	if err != nil {
		return 0, err
	}
	type claimed struct{ id, tenant, eventType, payload, traceparent string }
	var batch []claimed
	for rows.Next() {
		var c claimed
		var tp *string
		if err := rows.Scan(&c.id, &c.tenant, &c.eventType, &c.payload, &tp); err != nil {
			rows.Close()
			return 0, err
		}
		if tp != nil {
			c.traceparent = *tp
		}
		batch = append(batch, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	published := 0
	for _, c := range batch {
		spanCtx, span := Tracer().Start(ContextFrom(ctx, c.traceparent), r.exchange+" publish",
			trace.WithSpanKind(trace.SpanKindProducer),
			trace.WithAttributes(attribute.String("messaging.system", "rabbitmq"), attribute.String("messaging.destination.name", r.exchange),
				attribute.String("messaging.message.id", c.id), attribute.String("tenant.id", c.tenant)))
		headers := amqp.Table{"tenant_id": c.tenant}
		if tp := TraceparentOf(spanCtx); tp != "" {
			headers["traceparent"] = tp
		}
		err := r.publish(spanCtx, c.eventType, c.id, c.payload, headers)
		if err == nil {
			_, err = r.pool.Exec(ctx, "UPDATE "+r.s+".ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = $1 AND claimed_by = $2", c.id, workerID)
		}
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			_, _ = r.pool.Exec(ctx, "UPDATE "+r.s+".ghk_outbox SET claimed_until = NULL, last_error = $2, failed_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END WHERE id = $1", c.id, err.Error(), r.MaxAttempts)
		} else {
			published++
		}
		span.End()
	}
	return published, nil
}

func (r *OutboxRelay) publish(ctx context.Context, key, id, body string, headers amqp.Table) error {
	confirm, err := r.ch.PublishWithDeferredConfirmWithContext(ctx, r.exchange, key, false, false, amqp.Publishing{
		MessageId: id, DeliveryMode: amqp.Persistent, ContentType: "application/json", Type: key, Headers: headers, Body: []byte(body),
	})
	if err != nil {
		return err
	}
	waitCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	acked, err := confirm.WaitContext(waitCtx)
	if err != nil {
		return err
	}
	if !acked {
		return amqp.ErrClosed
	}
	return nil
}
`;

  const inbox = `package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// Meta describes a delivered message; Tx is the transaction the inbox record is written in.
type Meta struct {
	MessageID string
	TenantID  string
	EventType string
	Tx        pgx.Tx
}

type Handler func(ctx context.Context, event map[string]any, meta Meta) error

// InboxConsumer records the message id in ghk_inbox in the same transaction as the handler, so
// redeliveries are acknowledged without running the handler twice. A handler error rejects the
// message without requeue, so RabbitMQ dead-letters it to the DLQ.
type InboxConsumer struct {
	pool    *pgxpool.Pool
	ch      *amqp.Channel
	queue   string
	name    string
	handler Handler
	s       string
}

func NewInboxConsumer(pool *pgxpool.Pool, ch *amqp.Channel, queue, name string, handler Handler, schema string) (*InboxConsumer, error) {
	s, err := SchemaName(schema)
	if err != nil {
		return nil, err
	}
	return &InboxConsumer{pool: pool, ch: ch, queue: queue, name: name, handler: handler, s: s}, nil
}

// Drain processes messages until the queue stays idle for \`idle\`. It returns how many were processed.
func (c *InboxConsumer) Drain(ctx context.Context, idle time.Duration) (int, error) {
	deliveries, err := c.ch.Consume(c.queue, c.name, false, false, false, false, nil)
	if err != nil {
		return 0, err
	}
	defer c.ch.Cancel(c.name, false) //nolint:errcheck
	processed := 0
	for {
		select {
		case d, ok := <-deliveries:
			if !ok {
				return processed, nil
			}
			c.process(ctx, d)
			processed++
		case <-time.After(idle):
			return processed, nil
		}
	}
}

func (c *InboxConsumer) process(ctx context.Context, d amqp.Delivery) {
	traceparent, _ := d.Headers["traceparent"].(string)
	tenant, _ := d.Headers["tenant_id"].(string)
	ctx, span := Tracer().Start(ContextFrom(ctx, traceparent), c.queue+" process",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(attribute.String("messaging.system", "rabbitmq"), attribute.String("messaging.destination.name", c.queue), attribute.String("messaging.message.id", d.MessageId)))
	defer span.End()
	if err := c.handle(ctx, d, tenant); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		_ = d.Nack(false, false)
		return
	}
	_ = d.Ack(false)
}

func (c *InboxConsumer) handle(ctx context.Context, d amqp.Delivery, tenant string) error {
	tx, err := c.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, "INSERT INTO "+c.s+".ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", c.name, d.MessageId)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		var event map[string]any
		if err := json.Unmarshal(d.Body, &event); err != nil {
			return fmt.Errorf("invalid message body: %w", err)
		}
		if err := c.handler(ctx, event, Meta{MessageID: d.MessageId, TenantID: tenant, EventType: d.Type, Tx: tx}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
`;

  const saga = `package runtime

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type SagaStep struct {
	Name       string
	Action     func(ctx context.Context) error
	Compensate func(ctx context.Context) error
}

// SagaOrchestrator persists progress after every step; when a step fails, the completed steps are
// compensated in reverse order. Re-running a saga id resumes after its completed steps.
type SagaOrchestrator struct {
	pool *pgxpool.Pool
	s    string
}

func NewSagaOrchestrator(pool *pgxpool.Pool, schema string) (*SagaOrchestrator, error) {
	s, err := SchemaName(schema)
	if err != nil {
		return nil, err
	}
	return &SagaOrchestrator{pool: pool, s: s}, nil
}

func (o *SagaOrchestrator) Run(ctx context.Context, sagaID, tenantID string, steps []SagaStep) (string, error) {
	if _, err := o.pool.Exec(ctx, "INSERT INTO "+o.s+".ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING", sagaID, tenantID); err != nil {
		return "", err
	}
	var done string
	if err := o.pool.QueryRow(ctx, "SELECT completed_steps FROM "+o.s+".ghk_sagas WHERE id = $1 AND tenant_id = $2", sagaID, tenantID).Scan(&done); err != nil {
		return "", err
	}
	completed := []string{}
	if done != "" {
		completed = strings.Split(done, ",")
	}
	byName := map[string]SagaStep{}
	for _, step := range steps {
		byName[step.Name] = step
	}
	contains := func(name string) bool {
		for _, c := range completed {
			if c == name {
				return true
			}
		}
		return false
	}
	for _, step := range steps {
		if contains(step.Name) {
			continue
		}
		if err := step.Action(ctx); err != nil {
			if err := o.save(ctx, sagaID, "COMPENSATING", completed); err != nil {
				return "", err
			}
			for i := len(completed) - 1; i >= 0; i-- {
				if err := byName[completed[i]].Compensate(ctx); err != nil {
					return "", err
				}
				completed = completed[:i]
				if err := o.save(ctx, sagaID, "COMPENSATING", completed); err != nil {
					return "", err
				}
			}
			return "COMPENSATED", o.save(ctx, sagaID, "COMPENSATED", completed)
		}
		completed = append(completed, step.Name)
		if err := o.save(ctx, sagaID, "RUNNING", completed); err != nil {
			return "", err
		}
	}
	return "COMPLETED", o.save(ctx, sagaID, "COMPLETED", completed)
}

// Status returns the persisted status and completed steps of a saga.
func (o *SagaOrchestrator) Status(ctx context.Context, sagaID string) (string, []string, error) {
	var status, done string
	if err := o.pool.QueryRow(ctx, "SELECT status, completed_steps FROM "+o.s+".ghk_sagas WHERE id = $1", sagaID).Scan(&status, &done); err != nil {
		return "", nil, err
	}
	if done == "" {
		return status, []string{}, nil
	}
	return status, strings.Split(done, ","), nil
}

func (o *SagaOrchestrator) save(ctx context.Context, sagaID, status string, completed []string) error {
	_, err := o.pool.Exec(ctx, "UPDATE "+o.s+".ghk_sagas SET status = $2, completed_steps = $3, updated_at = now() WHERE id = $1", sagaID, status, strings.Join(completed, ","))
	return err
}
`;

  const first = m.commands[0];
  const test = `//go:build integration

// Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and RabbitMQ.
// Requires DATABASE_URL and AMQP_URL. Run with: go test -tags integration ./internal/runtime/...
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

const (
	command = ${goStr(first.snake)}
	event   = ${goStr(first.event)}
)

var exporter = tracetest.NewInMemoryExporter()

func init() {
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter)))
}

type env struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	conn   *amqp.Connection
	schema string
	topo   Topology
}

func uid() string { return strings.ReplaceAll(uuid.NewString(), "-", "")[:12] }

func setup(t *testing.T) *env {
	t.Helper()
	dbURL, amqpURL := os.Getenv("DATABASE_URL"), os.Getenv("AMQP_URL")
	if dbURL == "" || amqpURL == "" {
		t.Fatal("integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md)")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	must(t, err)
	conn, err := amqp.Dial(amqpURL)
	must(t, err)
	e := &env{ctx: ctx, pool: pool, conn: conn, schema: "it_" + uid(), topo: TopologyFor("it-" + uid())}
	must(t, Migrate(ctx, pool, e.schema))
	exporter.Reset()
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "DROP SCHEMA IF EXISTS "+e.schema+" CASCADE")
		_ = conn.Close()
		pool.Close()
	})
	return e
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (e *env) count(t *testing.T, table, where string, args ...any) int {
	t.Helper()
	var n int
	must(t, e.pool.QueryRow(e.ctx, fmt.Sprintf("SELECT count(*) FROM %s.%s WHERE %s", e.schema, table, where), args...).Scan(&n))
	return n
}

func (e *env) service(t *testing.T) *CommandService {
	svc, err := NewCommandService(e.pool, e.schema)
	must(t, err)
	return svc
}

func (e *env) channel(t *testing.T) *amqp.Channel {
	ch, err := e.conn.Channel()
	must(t, err)
	return ch
}

func drainQueue(t *testing.T, ch *amqp.Channel, queue string) []amqp.Delivery {
	var out []amqp.Delivery
	for {
		d, ok, err := ch.Get(queue, true)
		must(t, err)
		if !ok {
			return out
		}
		out = append(out, d)
	}
}

func waitFor(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for condition")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestIT1AtomicWriteAndRollback(t *testing.T) {
	e := setup(t)
	svc := e.service(t)
	res, err := svc.Handle(e.ctx, CommandRequest{TenantID: "t1", AggregateID: "agg-1", Command: command})
	must(t, err)
	if res.Status != "created" || res.EventType != event || res.Version != 1 {
		t.Fatalf("unexpected result %+v", res)
	}
	if snap, _ := svc.Load(e.ctx, "t1", "agg-1"); snap == nil || snap.Version != 1 {
		t.Fatalf("aggregate not persisted: %+v", snap)
	}
	if n := e.count(t, "ghk_outbox", "aggregate_id = $1", "agg-1"); n != 1 {
		t.Fatalf("outbox rows = %d", n)
	}
	_, err = svc.Handle(e.ctx, CommandRequest{TenantID: "t1", AggregateID: "agg-2", Command: "no_such_command", IdempotencyKey: "k-fail"})
	if err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Fatalf("expected unknown command error, got %v", err)
	}
	if snap, _ := svc.Load(e.ctx, "t1", "agg-2"); snap != nil {
		t.Fatal("aggregate persisted despite domain error")
	}
	if e.count(t, "ghk_outbox", "aggregate_id = $1", "agg-2") != 0 || e.count(t, "ghk_idempotency", "key = $1", "k-fail") != 0 {
		t.Fatal("rollback incomplete")
	}
}

func TestIT2ConcurrentIdempotentRequests(t *testing.T) {
	e := setup(t)
	svc := e.service(t)
	results := make([]CommandResult, 5)
	var wg sync.WaitGroup
	errs := make(chan error, 5)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := svc.Handle(e.ctx, CommandRequest{TenantID: "t1", AggregateID: "agg-1", Command: command, IdempotencyKey: "key-1"})
			results[i] = r
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		must(t, err)
	}
	if n := e.count(t, "ghk_outbox", "true"); n != 1 {
		t.Fatalf("outbox rows = %d, want 1", n)
	}
	created := 0
	for _, r := range results {
		if r.Status == "created" {
			created++
		}
		if r.EventType != event || r.Version != 1 {
			t.Fatalf("divergent response %+v", r)
		}
	}
	if created != 1 {
		t.Fatalf("created = %d, want 1", created)
	}
}

func TestIT3ConcurrentRelaysPublishExactlyOnce(t *testing.T) {
	e := setup(t)
	svc := e.service(t)
	for i := 0; i < 20; i++ {
		_, err := svc.Handle(e.ctx, CommandRequest{TenantID: "t1", AggregateID: fmt.Sprintf("agg-%d", i), Command: command})
		must(t, err)
	}
	setupCh := e.channel(t)
	must(t, DeclareTopology(setupCh, e.topo))
	totals := make([]int, 2)
	var wg sync.WaitGroup
	for i, worker := range []string{"relay-a", "relay-b"} {
		wg.Add(1)
		go func(i int, worker string) {
			defer wg.Done()
			relay, err := NewOutboxRelay(e.pool, e.channel(t), e.topo.Exchange, e.schema)
			if err != nil {
				t.Error(err)
				return
			}
			for {
				n, err := relay.PublishBatch(e.ctx, worker, 3)
				if err != nil {
					t.Error(err)
					return
				}
				if n == 0 {
					return
				}
				totals[i] += n
			}
		}(i, worker)
	}
	wg.Wait()
	if totals[0]+totals[1] != 20 {
		t.Fatalf("published %v, want 20 in total", totals)
	}
	if n := e.count(t, "ghk_outbox", "published_at IS NULL"); n != 0 {
		t.Fatalf("%d rows unpublished", n)
	}
	waitFor(t, func() bool { q, err := setupCh.QueueDeclarePassive(e.topo.Queue, true, false, false, false, nil); return err == nil && q.Messages == 20 })
	ids := map[string]bool{}
	for _, d := range drainQueue(t, setupCh, e.topo.Queue) {
		ids[d.MessageId] = true
	}
	if len(ids) != 20 {
		t.Fatalf("unique messages = %d, want 20", len(ids))
	}
}

func TestIT4TenantIsolation(t *testing.T) {
	e := setup(t)
	svc := e.service(t)
	_, err := svc.Handle(e.ctx, CommandRequest{TenantID: "tenant-a", AggregateID: "shared-id", Command: command})
	must(t, err)
	if snap, _ := svc.Load(e.ctx, "tenant-b", "shared-id"); snap != nil {
		t.Fatal("tenant-b can read tenant-a's aggregate")
	}
	_, err = svc.Handle(e.ctx, CommandRequest{TenantID: "tenant-b", AggregateID: "shared-id", Command: command})
	must(t, err)
	a, _ := svc.Load(e.ctx, "tenant-a", "shared-id")
	b, _ := svc.Load(e.ctx, "tenant-b", "shared-id")
	if a == nil || b == nil || a.Version != 1 || b.Version != 1 {
		t.Fatalf("tenant aggregates not isolated: a=%+v b=%+v", a, b)
	}
	if n := e.count(t, "ghk_outbox", "tenant_id = $1", "tenant-a"); n != 1 {
		t.Fatalf("tenant-a outbox rows = %d", n)
	}
}

func TestIT5SagaCompensatesInReverseOrder(t *testing.T) {
	e := setup(t)
	saga, err := NewSagaOrchestrator(e.pool, e.schema)
	must(t, err)
	var log []string
	step := func(name string, fail bool) SagaStep {
		return SagaStep{
			Name: name,
			Action: func(context.Context) error {
				if fail {
					return errors.New(name + " failed")
				}
				log = append(log, "do:"+name)
				return nil
			},
			Compensate: func(context.Context) error { log = append(log, "undo:"+name); return nil },
		}
	}
	status, err := saga.Run(e.ctx, "saga-1", "t1", []SagaStep{step("reserve", false), step("charge", false), step("ship", true)})
	must(t, err)
	if status != "COMPENSATED" || !reflect.DeepEqual(log, []string{"do:reserve", "do:charge", "undo:charge", "undo:reserve"}) {
		t.Fatalf("status=%s log=%v", status, log)
	}
	persisted, completed, err := saga.Status(e.ctx, "saga-1")
	must(t, err)
	if persisted != "COMPENSATED" || len(completed) != 0 {
		t.Fatalf("persisted %s %v", persisted, completed)
	}
	if status, err := saga.Run(e.ctx, "saga-2", "t1", []SagaStep{step("reserve", false), step("charge", false)}); err != nil || status != "COMPLETED" {
		t.Fatalf("status=%s err=%v", status, err)
	}
}

func TestIT6InboxDeduplicatesAndDeadLetters(t *testing.T) {
	e := setup(t)
	ch := e.channel(t)
	must(t, DeclareTopology(ch, e.topo))
	var handled []string
	consumer, err := NewInboxConsumer(e.pool, ch, e.topo.Queue, "it-consumer", func(_ context.Context, event map[string]any, meta Meta) error {
		if event["poison"] == true {
			return errors.New("cannot process")
		}
		handled = append(handled, meta.MessageID)
		return nil
	}, e.schema)
	must(t, err)
	publish := func(id, body string) {
		must(t, ch.PublishWithContext(e.ctx, e.topo.Exchange, "Test", false, false, amqp.Publishing{MessageId: id, Headers: amqp.Table{"tenant_id": "t1"}, Body: []byte(body)}))
	}
	publish("m-1", \`{"ok": true}\`)
	publish("m-1", \`{"ok": true}\`)
	publish("m-poison", \`{"poison": true}\`)
	_, err = consumer.Drain(e.ctx, time.Second)
	must(t, err)
	if !reflect.DeepEqual(handled, []string{"m-1"}) {
		t.Fatalf("handled %v", handled)
	}
	if n := e.count(t, "ghk_inbox", "consumer = $1", "it-consumer"); n != 1 {
		t.Fatalf("inbox rows = %d", n)
	}
	waitFor(t, func() bool { q, err := ch.QueueDeclarePassive(e.topo.DLQ, true, false, false, false, nil); return err == nil && q.Messages == 1 })
	dead := drainQueue(t, ch, e.topo.DLQ)
	if len(dead) != 1 || dead[0].MessageId != "m-poison" {
		t.Fatalf("dead-lettered %v", dead)
	}
}

func TestIT7TraceContextPropagation(t *testing.T) {
	e := setup(t)
	svc := e.service(t)
	_, err := svc.Handle(e.ctx, CommandRequest{TenantID: "t1", AggregateID: "agg-1", Command: command, Traceparent: ${goStr(TEST_TRACEPARENT)}})
	must(t, err)
	var stored string
	must(t, e.pool.QueryRow(e.ctx, "SELECT traceparent FROM "+e.schema+".ghk_outbox").Scan(&stored))
	if !strings.Contains(stored, ${goStr(TEST_TRACE_ID)}) {
		t.Fatalf("outbox traceparent %q", stored)
	}
	ch := e.channel(t)
	must(t, DeclareTopology(ch, e.topo))
	relay, err := NewOutboxRelay(e.pool, ch, e.topo.Exchange, e.schema)
	must(t, err)
	if n, err := relay.PublishBatch(e.ctx, "relay", 10); err != nil || n != 1 {
		t.Fatalf("published %d err=%v", n, err)
	}
	received := 0
	consumer, err := NewInboxConsumer(e.pool, e.channel(t), e.topo.Queue, "trace-consumer", func(context.Context, map[string]any, Meta) error { received++; return nil }, e.schema)
	must(t, err)
	_, err = consumer.Drain(e.ctx, time.Second)
	must(t, err)
	if received != 1 {
		t.Fatalf("received %d", received)
	}
	byKind := map[trace.SpanKind]tracetest.SpanStub{}
	for _, s := range exporter.GetSpans() {
		byKind[s.SpanKind] = s
	}
	command, producer, consumerSpan := byKind[trace.SpanKindInternal], byKind[trace.SpanKindProducer], byKind[trace.SpanKindConsumer]
	for name, s := range map[string]tracetest.SpanStub{"command": command, "publish": producer, "consume": consumerSpan} {
		if got := s.SpanContext.TraceID().String(); got != ${goStr(TEST_TRACE_ID)} {
			t.Fatalf("%s span trace id = %s", name, got)
		}
	}
	if got := command.Parent.SpanID().String(); got != ${goStr(TEST_PARENT_SPAN_ID)} {
		t.Fatalf("command span parent = %s", got)
	}
	if consumerSpan.Parent.SpanID() != producer.SpanContext.SpanID() {
		t.Fatal("consume span is not a child of the publish span")
	}
	_ = json.Valid // keep encoding/json for handlers that decode payloads
}
`;

  return [
    { filename: 'internal/runtime/schema.go', content: schema },
    { filename: 'internal/runtime/telemetry.go', content: telemetry },
    { filename: 'internal/runtime/command_service.go', content: commandService },
    { filename: 'internal/runtime/outbox_relay.go', content: relay },
    { filename: 'internal/runtime/inbox_consumer.go', content: inbox },
    { filename: 'internal/runtime/saga.go', content: saga },
    { filename: 'internal/runtime/runtime_integration_test.go', content: test }
  ];
}
