/* ==========================================================================
   gherkin-ai-cli - The Go runtime kernel on MongoDB 7.0 (stack.kernelDatabase
   "mongodb"; PLAN-3.3.0 X-02). chi.

   Same design as the TypeScript kernel on MongoDB (typescript-mongo.ts):
     - internal/runtime/db.go: runtime.Pool over the official driver
       (go.mongodb.org/mongo-driver/v2, Apache-2.0) in place of pgxpool.Pool,
       with InTransaction: a transaction run again on a transient error, a
       write conflict or a duplicate key from a concurrent insert
       (PostgreSQL's row locks wait for the other writer instead);
     - collections with the kernel's column names and unique indexes; a
       schema is a database ("public" is the one in DATABASE_URL);
     - the command service and the inbox in transactions; the outbox claimed
       one event at a time with an atomic FindOneAndUpdate and a lease on the
       server's clock ($$NOW);
     - the server and the tests use runtime.Pool / NewPool.
   Filters and updates are bson.M; ordered documents (sort, index keys) are
   keyed bson.D, as go vet requires for another package's struct literals.
   Transactions need a replica set (one node is enough).
   ========================================================================== */

import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS } from './shared';

type File = { filename: string; content: string };

export const GO_MONGO_REQUIRE = 'go.mongodb.org/mongo-driver/v2 v2.2.0';

const DB_GO = `package runtime

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readconcern"
	"go.mongodb.org/mongo-driver/v2/mongo/writeconcern"
)

// Pool is the kernel's MongoDB connection (stack.kernelDatabase "mongodb"): one client, pooled and safe for
// concurrent use. Transactions need a replica set; one node is enough.
type Pool struct {
	client   *mongo.Client
	database string
}

// NewPool opens mongodb://host:27017/database?replicaSet=rs0 (or mongodb+srv://...). It connects lazily.
func NewPool(_ context.Context, databaseURL string) (*Pool, error) {
	client, err := mongo.Connect(options.Client().ApplyURI(databaseURL))
	if err != nil {
		return nil, err
	}
	database := "app"
	if u, err := url.Parse(databaseURL); err == nil && strings.TrimPrefix(u.Path, "/") != "" {
		database = strings.TrimPrefix(u.Path, "/")
	}
	return &Pool{client: client, database: database}, nil
}

// DefaultDatabase is the database in DATABASE_URL.
func (p *Pool) DefaultDatabase() string { return p.database }

// Database returns a database of the pool's client.
func (p *Pool) Database(name string) *mongo.Database { return p.client.Database(name) }

// Ping is the readiness probe.
func (p *Pool) Ping(ctx context.Context) error { return p.client.Ping(ctx, nil) }

// Close disconnects the client.
func (p *Pool) Close() { _ = p.client.Disconnect(context.Background()) }

// InTransaction runs work in a transaction (snapshot reads, majority writes); work must use the context it is
// given. On a transient error, a write conflict or a duplicate key from a concurrent transaction the work runs
// again on fresh data: the concurrent writer has committed by then, as a PostgreSQL row lock would have waited
// for it. Other errors (a domain error) abort the transaction and are returned.
func (p *Pool) InTransaction(ctx context.Context, work func(ctx context.Context) error) error {
	for attempt := 1; ; attempt++ {
		err := p.once(ctx, work)
		if err == nil || attempt >= 60 || !retryable(err) {
			return err
		}
		time.Sleep(time.Duration(min(5*attempt, 100)) * time.Millisecond)
	}
}

func (p *Pool) once(ctx context.Context, work func(ctx context.Context) error) error {
	session, err := p.client.StartSession()
	if err != nil {
		return err
	}
	defer session.EndSession(context.Background())
	opts := options.Transaction().SetReadConcern(readconcern.Snapshot()).SetWriteConcern(writeconcern.Majority())
	if err := session.StartTransaction(opts); err != nil {
		return err
	}
	sessionCtx := mongo.NewSessionContext(ctx, session)
	if err := work(sessionCtx); err != nil {
		_ = session.AbortTransaction(context.Background())
		return err
	}
	for attempt := 1; ; attempt++ {
		err := session.CommitTransaction(sessionCtx)
		var server mongo.ServerError
		if err != nil && attempt < 5 && errors.As(err, &server) && server.HasErrorLabel("UnknownTransactionCommitResult") {
			continue
		}
		return err
	}
}

// retryable: a transient transaction error, WriteConflict (112), DuplicateKey (11000) or NoSuchTransaction (251).
func retryable(err error) bool {
	var server mongo.ServerError
	if !errors.As(err, &server) {
		return false
	}
	return server.HasErrorLabel("TransientTransactionError") || server.HasErrorCode(112) || server.HasErrorCode(11000) || server.HasErrorCode(251)
}
`;

const SCHEMA_GO = `package runtime

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// collections are the kernel's collections and their keys (unique indexes).
var collections = []struct {
	name string
	keys [][]string
}{
	{"ghk_aggregates", [][]string{{"tenant_id", "aggregate_type", "id"}}},
	{"ghk_outbox", nil},
	{"ghk_idempotency", [][]string{{"tenant_id", "key"}}},
	{"ghk_inbox", [][]string{{"consumer", "message_id"}}},
	{"ghk_sagas", nil},
}

// Tenant isolation is the repository filter (tenant_id in every query).

var schemaPattern = regexp.MustCompile(\`^[A-Za-z0-9_-]{1,63}$\`)

// SchemaName validates a schema, which on MongoDB is a database; "public" is the pool's database.
func (p *Pool) SchemaName(schema string) (string, error) {
	s := schema
	if s == "" || s == "public" {
		s = p.database
	}
	if !schemaPattern.MatchString(s) {
		return "", fmt.Errorf("invalid schema name: %s", s)
	}
	return s, nil
}

func ascending(fields ...string) bson.D {
	keys := bson.D{}
	for _, field := range fields {
		keys = append(keys, bson.E{Key: field, Value: 1})
	}
	return keys
}

// Migrate creates the collections and indexes (idempotent); they exist before any transaction writes to them.
func Migrate(ctx context.Context, pool *Pool, schema string) error {
	s, err := pool.SchemaName(schema)
	if err != nil {
		return err
	}
	db := pool.Database(s)
	existing, err := db.ListCollectionNames(ctx, bson.M{})
	if err != nil {
		return err
	}
	for _, c := range collections {
		if !slices.Contains(existing, c.name) {
			var command mongo.CommandError
			if err := db.CreateCollection(ctx, c.name); err != nil && !(errors.As(err, &command) && command.Code == 48) {
				return err // 48: created by a replica starting at the same time
			}
		}
		for _, key := range c.keys {
			if _, err := db.Collection(c.name).Indexes().CreateOne(ctx, mongo.IndexModel{Keys: ascending(key...), Options: options.Index().SetUnique(true)}); err != nil {
				return err
			}
		}
	}
	_, err = db.Collection("ghk_outbox").Indexes().CreateOne(ctx, mongo.IndexModel{Keys: ascending("published_at", "failed_at", "created_at")})
	return err
}
`;

const COMMAND_SERVICE_TAIL = `// CommandService executes a command in one MongoDB transaction: idempotency lookup, aggregate load, domain
// logic, aggregate save and outbox insert. A domain error aborts everything; a concurrent writer makes it run again.
type CommandService struct {
	pool *Pool
	s    string
}

func NewCommandService(pool *Pool, schema string) (*CommandService, error) {
	s, err := pool.SchemaName(schema)
	if err != nil {
		return nil, err
	}
	return &CommandService{pool: pool, s: s}, nil
}

func (svc *CommandService) Handle(ctx context.Context, req CommandRequest) (result CommandResult, err error) {
	if req.TenantID == "" {
		return result, fmt.Errorf("%w: tenant id is required", domain.ErrValidation)
	}
	aggregateType := req.AggregateType
	if aggregateType == "" {
		aggregateType = DefaultAggregate
	}
	apply, ok := aggregates[aggregateType]
	if !ok {
		return result, fmt.Errorf("%w: unknown aggregate type %s", domain.ErrValidation, aggregateType)
	}
	ctx, span := Tracer().Start(ContextFrom(ctx, req.Traceparent), aggregateType+"."+req.Command,
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(attribute.String("tenant.id", req.TenantID), attribute.String("aggregate.id", req.AggregateID)))
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		span.End()
	}()
	traceparent := TraceparentOf(ctx)
	// A concurrent change of the same aggregate is a write conflict: the transaction runs again on its result.
	err = svc.pool.InTransaction(ctx, func(tx context.Context) error {
		var runErr error
		result, runErr = svc.execute(tx, aggregateType, apply, req, traceparent)
		return runErr
	})
	return result, err
}

func (svc *CommandService) execute(ctx context.Context, aggregateType string, apply aggregateFunc, req CommandRequest, traceparent string) (CommandResult, error) {
	db := svc.pool.Database(svc.s)
	if req.IdempotencyKey != "" {
		claim := bson.M{"tenant_id": req.TenantID, "key": req.IdempotencyKey}
		var done struct {
			Status   string  \`bson:"status"\`
			Response *string \`bson:"response"\`
		}
		err := db.Collection("ghk_idempotency").FindOne(ctx, claim).Decode(&done)
		switch {
		case err == nil:
			if done.Status == "COMPLETED" && done.Response != nil {
				var stored CommandResult
				if err := json.Unmarshal([]byte(*done.Response), &stored); err != nil {
					return CommandResult{}, err
				}
				stored.Status = "replayed"
				return stored, nil
			}
			return CommandResult{Status: "in-progress", AggregateID: req.AggregateID}, nil
		case !errors.Is(err, mongo.ErrNoDocuments):
			return CommandResult{}, err
		}
		if _, err := db.Collection("ghk_idempotency").InsertOne(ctx, bson.M{"tenant_id": req.TenantID, "key": req.IdempotencyKey, "status": "PROCESSING", "created_at": time.Now().UTC()}); err != nil {
			return CommandResult{}, err
		}
	}

	id := bson.M{"tenant_id": req.TenantID, "aggregate_type": aggregateType, "id": req.AggregateID}
	var row struct {
		State   string \`bson:"state"\`
		Version int64  \`bson:"version"\`
	}
	var loaded *string
	err := db.Collection("ghk_aggregates").FindOne(ctx, id).Decode(&row)
	switch {
	case err == nil:
		loaded = &row.State
	case !errors.Is(err, mongo.ErrNoDocuments):
		return CommandResult{}, err
	}
	done, err := apply(req.AggregateID, loaded, row.Version, req.Command, domain.Command{ID: req.AggregateID, Payload: req.Payload})
	if err != nil {
		return CommandResult{}, err
	}
	event := done.event
	now := time.Now().UTC()
	if _, err := db.Collection("ghk_aggregates").UpdateOne(ctx, id, bson.M{"$set": bson.M{"state": done.state, "version": done.version, "updated_at": now}}, options.UpdateOne().SetUpsert(true)); err != nil {
		return CommandResult{}, err
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return CommandResult{}, err
	}
	var tp any
	if traceparent != "" {
		tp = traceparent
	}
	if _, err := db.Collection("ghk_outbox").InsertOne(ctx, bson.M{
		"_id": uuid.NewString(), "tenant_id": req.TenantID, "aggregate_id": req.AggregateID, "event_type": string(event.Type),
		"payload": string(payload), "traceparent": tp, "created_at": now, "claimed_by": nil, "claimed_until": nil,
		"published_at": nil, "attempts": 0, "last_error": nil, "failed_at": nil,
	}); err != nil {
		return CommandResult{}, err
	}
	result := CommandResult{Status: "created", AggregateID: req.AggregateID, EventType: string(event.Type), Version: event.Version}
	if req.IdempotencyKey != "" {
		response, _ := json.Marshal(result)
		if _, err := db.Collection("ghk_idempotency").UpdateOne(ctx, bson.M{"tenant_id": req.TenantID, "key": req.IdempotencyKey},
			bson.M{"$set": bson.M{"status": "COMPLETED", "response": string(response)}}); err != nil {
			return CommandResult{}, err
		}
	}
	return result, nil
}

// Snapshot is an aggregate as stored for a tenant.
type Snapshot struct {
	State   string
	Version int64
}

// Load returns the aggregate as tenantID sees it (nil for other tenants' aggregates).
func (svc *CommandService) Load(ctx context.Context, tenantID, aggregateID string) (*Snapshot, error) {
	return svc.LoadType(ctx, DefaultAggregate, tenantID, aggregateID)
}

// LoadType is Load for a given aggregate type.
func (svc *CommandService) LoadType(ctx context.Context, aggregateType, tenantID, aggregateID string) (*Snapshot, error) {
	var row struct {
		State   string \`bson:"state"\`
		Version int64  \`bson:"version"\`
	}
	err := svc.pool.Database(svc.s).Collection("ghk_aggregates").FindOne(ctx, bson.M{"tenant_id": tenantID, "aggregate_type": aggregateType, "id": aggregateID}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &Snapshot{State: row.State, Version: row.Version}, nil
}
`;

const RELAY_GO = `package runtime

import (
	"context"
	"errors"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// OutboxRelay publishes pending outbox events. Each one is claimed with an atomic FindOneAndUpdate and a lease
// on the server's clock, so concurrent relays never publish the same event; the publisher returns only once the
// broker has accepted the message, before it is marked published. Use one relay (and publisher) per goroutine.
type OutboxRelay struct {
	pool         *Pool
	publisher    EventPublisher
	s            string
	LeaseSeconds int
	MaxAttempts  int
}

func NewOutboxRelay(pool *Pool, publisher EventPublisher, schema string) (*OutboxRelay, error) {
	s, err := pool.SchemaName(schema)
	if err != nil {
		return nil, err
	}
	return &OutboxRelay{pool: pool, publisher: publisher, s: s, LeaseSeconds: ${LEASE_SECONDS}, MaxAttempts: ${MAX_PUBLISH_ATTEMPTS}}, nil
}

type outboxRow struct {
	ID          string  \`bson:"_id"\`
	TenantID    string  \`bson:"tenant_id"\`
	EventType   string  \`bson:"event_type"\`
	Payload     string  \`bson:"payload"\`
	Traceparent *string \`bson:"traceparent"\`
}

// claim leases the oldest pending event nobody holds a lease on to workerID (nil when there is none).
func (r *OutboxRelay) claim(ctx context.Context, outbox *mongo.Collection, workerID string) (*outboxRow, error) {
	pending := bson.M{"published_at": nil, "failed_at": nil,
		"$or": bson.A{bson.M{"claimed_until": nil}, bson.M{"$expr": bson.M{"$lt": bson.A{"$claimed_until", "$$NOW"}}}}}
	lease := bson.A{bson.M{"$set": bson.M{
		"claimed_by":    bson.M{"$literal": workerID},
		"claimed_until": bson.M{"$add": bson.A{"$$NOW", int64(r.LeaseSeconds) * 1000}},
		"attempts":      bson.M{"$add": bson.A{"$attempts", 1}},
	}}}
	order := bson.D{{Key: "created_at", Value: 1}, {Key: "_id", Value: 1}}
	var row outboxRow
	err := outbox.FindOneAndUpdate(ctx, pending, lease, options.FindOneAndUpdate().SetSort(order).SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *OutboxRelay) PublishBatch(ctx context.Context, workerID string, limit int) (int, error) {
	outbox := r.pool.Database(r.s).Collection("ghk_outbox")
	published := 0
	for n := 0; n < limit; n++ {
		row, err := r.claim(ctx, outbox, workerID)
		if err != nil {
			return published, err
		}
		if row == nil {
			break
		}
		incoming := ""
		if row.Traceparent != nil {
			incoming = *row.Traceparent
		}
		destination := r.publisher.Destination()
		spanCtx, span := Tracer().Start(ContextFrom(ctx, incoming), destination+" publish",
			trace.WithSpanKind(trace.SpanKindProducer),
			trace.WithAttributes(attribute.String("messaging.system", r.publisher.System()), attribute.String("messaging.destination.name", destination),
				attribute.String("messaging.message.id", row.ID), attribute.String("tenant.id", row.TenantID)))
		err = r.publisher.Publish(spanCtx, BrokerMessage{MessageID: row.ID, EventType: row.EventType, TenantID: row.TenantID, Traceparent: TraceparentOf(spanCtx), Body: []byte(row.Payload)})
		if err == nil {
			_, err = outbox.UpdateOne(ctx, bson.M{"_id": row.ID, "claimed_by": workerID}, bson.A{bson.M{"$set": bson.M{"published_at": "$$NOW", "claimed_until": nil}}})
		}
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			_, _ = outbox.UpdateOne(ctx, bson.M{"_id": row.ID}, bson.A{bson.M{"$set": bson.M{
				"claimed_until": nil,
				"last_error":    bson.M{"$literal": err.Error()},
				"failed_at":     bson.M{"$cond": bson.A{bson.M{"$gte": bson.A{"$attempts", r.MaxAttempts}}, "$$NOW", nil}},
			}}})
		} else {
			published++
		}
		span.End()
	}
	return published, nil
}
`;

const INBOX_GO = `package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// Meta describes a delivered message. Tx is the context of the transaction the inbox record is written in:
// the handler's writes with it (to Database) join that transaction.
type Meta struct {
	MessageID string
	TenantID  string
	EventType string
	Tx        context.Context
	Database  *mongo.Database
}

type Handler func(ctx context.Context, event map[string]any, meta Meta) error

// InboxConsumer records the message id in ghk_inbox in the same transaction as the handler, so
// redeliveries are acknowledged without running the handler twice. A handler error dead-letters the
// message: it is not redelivered. A write conflict runs the transaction (and the handler) again: keep the
// handler's effects in the transaction.
type InboxConsumer struct {
	pool         *Pool
	subscription EventSubscription
	name         string
	handler      Handler
	s            string
}

func NewInboxConsumer(pool *Pool, subscription EventSubscription, name string, handler Handler, schema string) (*InboxConsumer, error) {
	s, err := pool.SchemaName(schema)
	if err != nil {
		return nil, err
	}
	return &InboxConsumer{pool: pool, subscription: subscription, name: name, handler: handler, s: s}, nil
}

// Drain processes messages until the source stays idle for idle. It returns how many were processed.
func (c *InboxConsumer) Drain(ctx context.Context, idle time.Duration) (int, error) {
	processed := 0
	idleSince := time.Now()
	for time.Since(idleSince) < idle {
		d, err := c.subscription.Poll(ctx)
		if err != nil {
			return processed, err
		}
		if d == nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		c.process(ctx, d)
		processed++
		idleSince = time.Now()
	}
	return processed, nil
}

func (c *InboxConsumer) process(ctx context.Context, d *Delivery) {
	m := d.Message
	source := c.subscription.Source()
	ctx, span := Tracer().Start(ContextFrom(ctx, m.Traceparent), source+" process",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(attribute.String("messaging.system", c.subscription.System()), attribute.String("messaging.destination.name", source), attribute.String("messaging.message.id", m.MessageID)))
	defer span.End()
	if err := c.handle(ctx, m); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		_ = d.DeadLetter(ctx)
		return
	}
	_ = d.Ack(ctx)
}

func (c *InboxConsumer) handle(ctx context.Context, m BrokerMessage) error {
	db := c.pool.Database(c.s)
	return c.pool.InTransaction(ctx, func(tx context.Context) error {
		inbox := db.Collection("ghk_inbox")
		key := bson.M{"consumer": c.name, "message_id": m.MessageID}
		err := inbox.FindOne(tx, key).Err()
		if err == nil {
			return nil // already processed
		}
		if !errors.Is(err, mongo.ErrNoDocuments) {
			return err
		}
		if _, err := inbox.InsertOne(tx, bson.M{"consumer": c.name, "message_id": m.MessageID, "processed_at": time.Now().UTC()}); err != nil {
			return err
		}
		var event map[string]any
		if err := json.Unmarshal(m.Body, &event); err != nil {
			return fmt.Errorf("invalid message body: %w", err)
		}
		return c.handler(tx, event, Meta{MessageID: m.MessageID, TenantID: m.TenantID, EventType: m.EventType, Tx: tx, Database: db})
	})
}
`;

const SAGA_GO = `package runtime

import (
	"context"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type SagaStep struct {
	Name       string
	Action     func(ctx context.Context) error
	Compensate func(ctx context.Context) error
}

// SagaOrchestrator persists progress after every step; when a step fails, the completed steps are
// compensated in reverse order. Re-running a saga id resumes after its completed steps.
type SagaOrchestrator struct {
	pool *Pool
	s    string
}

func NewSagaOrchestrator(pool *Pool, schema string) (*SagaOrchestrator, error) {
	s, err := pool.SchemaName(schema)
	if err != nil {
		return nil, err
	}
	return &SagaOrchestrator{pool: pool, s: s}, nil
}

func (o *SagaOrchestrator) sagas() *mongo.Collection { return o.pool.Database(o.s).Collection("ghk_sagas") }

type sagaRow struct {
	Status         string \`bson:"status"\`
	CompletedSteps string \`bson:"completed_steps"\`
}

func split(done string) []string {
	if done == "" {
		return []string{}
	}
	return strings.Split(done, ",")
}

func (o *SagaOrchestrator) Run(ctx context.Context, sagaID, tenantID string, steps []SagaStep) (string, error) {
	_, err := o.sagas().UpdateOne(ctx, bson.M{"_id": sagaID},
		bson.M{"$setOnInsert": bson.M{"tenant_id": tenantID, "status": "RUNNING", "completed_steps": "", "updated_at": time.Now().UTC()}},
		options.UpdateOne().SetUpsert(true))
	if err != nil && !mongo.IsDuplicateKeyError(err) { // a concurrent run created it
		return "", err
	}
	var row sagaRow
	if err := o.sagas().FindOne(ctx, bson.M{"_id": sagaID, "tenant_id": tenantID}).Decode(&row); err != nil {
		return "", err
	}
	completed := split(row.CompletedSteps)
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
	var row sagaRow
	if err := o.sagas().FindOne(ctx, bson.M{"_id": sagaID}).Decode(&row); err != nil {
		return "", nil, err
	}
	return row.Status, split(row.CompletedSteps), nil
}

func (o *SagaOrchestrator) save(ctx context.Context, sagaID, status string, completed []string) error {
	_, err := o.sagas().UpdateOne(ctx, bson.M{"_id": sagaID}, bson.M{"$set": bson.M{"status": status, "completed_steps": strings.Join(completed, ","), "updated_at": time.Now().UTC()}})
	return err
}
`;

/** Adapts a generated Go project (PostgreSQL kernel) to MongoDB; also its go.mod (contracts.ts). */
export function mongoizeGoProject(files: File[]): File[] {
  const out = files.map(f => {
    switch (f.filename) {
      case 'internal/runtime/schema.go': return { ...f, content: SCHEMA_GO };
      case 'internal/runtime/outbox_relay.go': return { ...f, content: RELAY_GO };
      case 'internal/runtime/inbox_consumer.go': return { ...f, content: INBOX_GO };
      case 'internal/runtime/saga.go': return { ...f, content: SAGA_GO };
      case 'internal/runtime/command_service.go': return { ...f, content: commandService(f.content) };
    }
    if (/(^|\/)go\.mod$/.test(f.filename)) return { ...f, content: f.content.replace('github.com/jackc/pgx/v5 v5.7.1', GO_MONGO_REQUIRE) };
    if (!f.filename.endsWith('.go') || !/pgx/.test(f.content)) return f;
    // By package, not directory: internal/runtime holds external tests (package runtime_test) too.
    const inRuntime = /^package runtime$/m.test(f.content);
    let content = f.content
      .replace(/^\t"github\.com\/jackc\/pgx\/v5\/pgxpool"\n/m, /e\.count\(|SELECT tenant_id FROM ghk_outbox/.test(f.content) ? '\t"go.mongodb.org/mongo-driver/v2/bson"\n' : '')
      .replace(/\bpgxpool\.New\(/g, inRuntime ? 'NewPool(' : 'runtime.NewPool(')
      .replace(/\*pgxpool\.Pool\b/g, inRuntime ? '*Pool' : '*runtime.Pool')
      // Runtime integration tests.
      .replace('_, _ = pool.Exec(ctx, "DROP SCHEMA IF EXISTS "+e.schema+" CASCADE")', '_ = pool.Database(e.schema).Drop(ctx)')
      .replace(/func \(e \*env\) count\(t \*testing\.T, table, where string, args \.\.\.any\) int \{[\s\S]*?\n\}\n/, `func (e *env) count(t *testing.T, collection string, filter bson.M) int {
	t.Helper()
	n, err := e.pool.Database(e.schema).Collection(collection).CountDocuments(e.ctx, filter)
	must(t, err)
	return int(n)
}
`)
      .replace(/e\.count\(t, "(\w+)", "(\w+) = \$1", ("[^"]*")\)/g, 'e.count(t, "$1", bson.M{"$2": $3})')
      .replace(/e\.count\(t, "(\w+)", "(\w+) IS NULL"\)/g, 'e.count(t, "$1", bson.M{"$2": nil})')
      .replace(/e\.count\(t, "(\w+)", "true"\)/g, 'e.count(t, "$1", bson.M{})')
      .replace('must(t, e.pool.QueryRow(e.ctx, "SELECT traceparent FROM "+e.schema+".ghk_outbox").Scan(&stored))', `var outboxRow struct {
		Traceparent string \`bson:"traceparent"\`
	}
	must(t, e.pool.Database(e.schema).Collection("ghk_outbox").FindOne(e.ctx, bson.M{}).Decode(&outboxRow))
	stored = outboxRow.Traceparent`)
      // HTTP integration test.
      .replace(/var stored string\n\tif err := pool\.QueryRow\(ctx, "SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = \$1", id\)\.Scan\(&stored\); err != nil \|\| stored != tenant \{\n\t\tt\.Fatalf\("outbox tenant %q, err %v", stored, err\)/, `var stored struct {
		TenantID string \`bson:"tenant_id"\`
	}
	if err := pool.Database(pool.DefaultDatabase()).Collection("ghk_outbox").FindOne(ctx, bson.M{"aggregate_id": id}).Decode(&stored); err != nil || stored.TenantID != tenant {
		t.Fatalf("outbox tenant %q, err %v", stored.TenantID, err)`)
      .replace('against PostgreSQL and RabbitMQ', 'against MongoDB and RabbitMQ')
      .replace('HTTP contract of the application layer against PostgreSQL', 'HTTP contract of the application layer against MongoDB');
    // The test helpers no longer format SQL.
    if (/^\t"fmt"\n/m.test(content) && !/\bfmt\./.test(content.replace(/^\t"fmt"\n/m, ''))) content = content.replace(/^\t"fmt"\n/m, '');
    return { ...f, content };
  });
  return out.some(f => f.filename === 'internal/runtime/schema.go') ? [...out, { filename: 'internal/runtime/db.go', content: DB_GO }] : out;
}

/** Keeps the generated aggregate table and request/result types; replaces the data access. */
function commandService(content: string): string {
  return content
    .replace('\t"fmt"\n', '\t"fmt"\n\t"time"\n')
    .replace('\t"github.com/jackc/pgx/v5"\n\t"github.com/jackc/pgx/v5/pgxpool"\n',
      '\t"go.mongodb.org/mongo-driver/v2/bson"\n\t"go.mongodb.org/mongo-driver/v2/mongo"\n\t"go.mongodb.org/mongo-driver/v2/mongo/options"\n')
    .replace(/\/\/ CommandService executes a command in one transaction[\s\S]*$/, () => COMMAND_SERVICE_TAIL);
}
