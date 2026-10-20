/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for Go (chi)
   pgx + amqp091-go + OpenTelemetry. Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { defaultJvmBroker as defaultBrokerFor, usesKafka, usesServiceBus } from './jvm';

/** go.mod requires for the Service Bus adapter (stack.messaging "servicebus"). */
export const GO_SERVICEBUS_REQUIRES = [
  'github.com/Azure/azure-sdk-for-go/sdk/azidentity v1.15.0',
  'github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus v1.11.0'
];

/** go.mod requires for the Kafka adapter (stack.messaging "kafka"): franz-go, pure Go (no cgo). */
export const GO_KAFKA_REQUIRES = [
  'github.com/twmb/franz-go v1.22.2',
  'github.com/twmb/franz-go/pkg/kadm v1.19.0'
];
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface GoRuntimeFile {
  filename: string;
  content: string;
}

const goStr = (s: string) => JSON.stringify(s);

export function renderGoRuntime(m: DomainModel, module: string, siblings: DomainModel[] = [], { messaging = undefined as string | undefined } = {}): GoRuntimeFile[] {
  const serviceBus = usesServiceBus(messaging);
  const kafka = usesKafka(messaging);
  const defaultBroker = defaultBrokerFor(messaging);
  const all = [m, ...siblings];
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

// DefaultAggregate is the aggregate type used when a request does not name one.
const DefaultAggregate = ${goStr(m.pascal)}

// applied is an aggregate's new state after a command and the recorded event.
type applied struct {
	state   string
	version int64
	event   domain.DomainEvent
}

type aggregateFunc func(id string, state *string, version int64, command string, cmd domain.Command) (applied, error)

// aggregates holds every aggregate of the service, by aggregate type.
var aggregates = map[string]aggregateFunc{
${all.map(a => `	${goStr(a.pascal)}: func(id string, state *string, version int64, command string, cmd domain.Command) (applied, error) {
		var aggregate *domain.${a.pascal}Aggregate
		var err error
		if state == nil {
			aggregate, err = domain.New${a.pascal}Aggregate(id)
		} else {
			aggregate, err = domain.Restore${a.pascal}Aggregate(id, domain.State(*state), version)
		}
		if err != nil {
			return applied{}, err
		}
		var event domain.DomainEvent
		switch command {
${a.commands.map(c => `		case ${goStr(c.snake)}:
			event, err = aggregate.${c.name}(cmd)`).join('\n')}
		default:
			return applied{}, fmt.Errorf("%w: unknown command %s", domain.ErrValidation, command)
		}
		if err != nil {
			return applied{}, err
		}
		return applied{state: string(aggregate.State), version: aggregate.Version, event: event}, nil
	},`).join('\n')}
}

type CommandRequest struct {
	TenantID string
	// AggregateType is the feature's aggregate (e.g. ${goStr(m.pascal)}); empty means DefaultAggregate.
	AggregateType  string
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
	var loaded *string
	err = tx.QueryRow(ctx, "SELECT state, version FROM "+svc.s+".ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE", req.TenantID, aggregateType, req.AggregateID).Scan(&state, &version)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		err = nil
	case err == nil:
		loaded = &state
	}
	if err != nil {
		return result, err
	}
	done, err := apply(req.AggregateID, loaded, version, req.Command, domain.Command{ID: req.AggregateID, Payload: req.Payload})
	if err != nil {
		return result, err
	}
	event := done.event
	if _, err = tx.Exec(ctx, "INSERT INTO "+svc.s+".ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5) "+
		"ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
		req.TenantID, aggregateType, req.AggregateID, done.state, done.version); err != nil {
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
	return svc.LoadType(ctx, DefaultAggregate, tenantID, aggregateID)
}

// LoadType is Load for a given aggregate type.
func (svc *CommandService) LoadType(ctx context.Context, aggregateType, tenantID, aggregateID string) (*Snapshot, error) {
	var snap Snapshot
	err := svc.pool.QueryRow(ctx, "SELECT state, version FROM "+svc.s+".ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3", tenantID, aggregateType, aggregateID).Scan(&snap.State, &snap.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &snap, err
}
`;

  const broker = `package runtime

// The event broker behind the outbox relay and the inbox consumer, chosen at run time so one image runs on any
// cloud: GHK_BROKER=rabbitmq (AMQP_URL), pubsub (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT; PUBSUB_EMULATOR_HOST)${serviceBus ? '\n// or servicebus (SERVICEBUS_NAMESPACE or SERVICEBUS_CONNECTION_STRING)' : ''}${kafka ? '\n// or kafka (KAFKA_BOOTSTRAP_SERVERS)' : ''}. Without GHK_BROKER the configured
// variables decide, then stack.messaging.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// Topology: publish to Exchange (topic), consume from Queue (subscription); dead letters go to DLX, read from DLQ.
type Topology struct{ Exchange, Queue, DLX, DLQ string }

// TopologyFor returns the topology for a prefix (use one per environment or test).
func TopologyFor(prefix string) Topology {
	return Topology{prefix + ".events", prefix + ".consumer", prefix + ".dlx", prefix + ".dlq"}
}

var DefaultTopology = Topology{${goStr(t.exchange)}, ${goStr(t.queue)}, ${goStr(t.dlx)}, ${goStr(t.dlq)}}

// DefaultBrokerKind is the broker of the generated configuration (stack.messaging).
const DefaultBrokerKind = ${goStr(defaultBroker)}

// BrokerMessage is a domain event on the wire, independent of the broker.
type BrokerMessage struct {
	MessageID, EventType, TenantID, Traceparent string
	Body                                        []byte
}

// EventPublisher publishes to one destination; Publish returns only once the broker has durably accepted the message.
type EventPublisher interface {
	System() string
	Destination() string
	Publish(ctx context.Context, m BrokerMessage) error
	Close() error
}

// Delivery is a received message: Ack once processed; DeadLetter moves it to the DLQ (it is not redelivered).
type Delivery struct {
	Message    BrokerMessage
	Ack        func(ctx context.Context) error
	DeadLetter func(ctx context.Context) error
}

// EventSubscription pulls messages from one queue / subscription.
type EventSubscription interface {
	System() string
	Source() string
	// Poll returns the next waiting message, or nil when there is none.
	Poll(ctx context.Context) (*Delivery, error)
	Close() error
}

type Broker interface {
	System() string
	// DynamicTopology is false when topics cannot be created at run time (Service Bus emulator: fixed Config.json).
	DynamicTopology() bool
	// Declare creates the topology if missing (idempotent); in production it usually comes from infrastructure as code.
	Declare(ctx context.Context, t Topology) error
	Publisher(ctx context.Context, destination string) (EventPublisher, error)
	// Subscribe: t says where dead-lettered messages go.
	Subscribe(ctx context.Context, source string, t Topology) (EventSubscription, error)
	Close() error
}

// BrokerKind is GHK_BROKER, else the broker whose variables are set, else DefaultBrokerKind.
func BrokerKind() string {
	if k := strings.TrimSpace(os.Getenv("GHK_BROKER")); k != "" {
		return strings.ToLower(k)
	}
	switch {
	case os.Getenv("AMQP_URL") != "":
		return "rabbitmq"
	case os.Getenv("PUBSUB_PROJECT_ID") != "" || os.Getenv("PUBSUB_EMULATOR_HOST") != "":
		return "pubsub"
	case os.Getenv("SERVICEBUS_CONNECTION_STRING") != "" || os.Getenv("SERVICEBUS_NAMESPACE") != "":
		return "servicebus"
	case os.Getenv("KAFKA_BOOTSTRAP_SERVERS") != "":
		return "kafka"
	}
	return DefaultBrokerKind
}

// BrokerConfigured reports whether the variables of the selected broker are set.
func BrokerConfigured() bool {
	switch BrokerKind() {
	case "pubsub":
		return os.Getenv("PUBSUB_PROJECT_ID") != "" || os.Getenv("GOOGLE_CLOUD_PROJECT") != ""
	case "servicebus":
		return os.Getenv("SERVICEBUS_CONNECTION_STRING") != "" || os.Getenv("SERVICEBUS_NAMESPACE") != ""
	case "kafka":
		return os.Getenv("KAFKA_BOOTSTRAP_SERVERS") != ""
	default:
		return os.Getenv("AMQP_URL") != ""
	}
}

// ConnectBroker connects to the selected broker.
func ConnectBroker(ctx context.Context) (Broker, error) {
	switch kind := BrokerKind(); kind {
	case "rabbitmq":
		url := os.Getenv("AMQP_URL")
		if url == "" {
			return nil, errors.New("AMQP_URL is not set (amqp://user:password@host:5672)")
		}
		return ConnectRabbitMQ(ctx, url)
	case "pubsub":
		return NewPubSubBrokerFromEnv()
	case "servicebus":
		${serviceBus ? 'return NewServiceBusBrokerFromEnv()' : 'return nil, errors.New("the Azure Service Bus adapter is not generated: set stack.messaging to \\"servicebus\\" and regenerate")'}
	case "kafka":
		${kafka ? 'return NewKafkaBrokerFromEnv()' : 'return nil, errors.New("the Kafka adapter is not generated: set stack.messaging to \\"kafka\\" and regenerate")'}
	default:
		return nil, fmt.Errorf("unsupported GHK_BROKER: %s (rabbitmq, pubsub, servicebus, kafka)", kind)
	}
}

// RabbitMQBroker: RabbitMQ 0-9-1 with a topic exchange, publisher confirms and dead-lettering through the queue's DLX.
type RabbitMQBroker struct{ conn *amqp.Connection }

func ConnectRabbitMQ(ctx context.Context, url string) (*RabbitMQBroker, error) {
	// A busy host can delay the AMQP handshake: retry before failing.
	for attempt := 1; ; attempt++ {
		conn, err := amqp.Dial(url)
		if err == nil {
			return &RabbitMQBroker{conn: conn}, nil
		}
		if attempt == 5 {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(2*attempt) * time.Second):
		}
	}
}

func (b *RabbitMQBroker) System() string        { return "rabbitmq" }
func (b *RabbitMQBroker) DynamicTopology() bool { return true }
func (b *RabbitMQBroker) Close() error          { return b.conn.Close() }

func (b *RabbitMQBroker) Declare(_ context.Context, t Topology) error {
	ch, err := b.conn.Channel()
	if err != nil {
		return err
	}
	defer ch.Close()
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

func (b *RabbitMQBroker) Publisher(_ context.Context, exchange string) (EventPublisher, error) {
	ch, err := b.conn.Channel()
	if err != nil {
		return nil, err
	}
	if err := ch.Confirm(false); err != nil {
		ch.Close()
		return nil, err
	}
	return &rabbitPublisher{ch: ch, exchange: exchange}, nil
}

func (b *RabbitMQBroker) Subscribe(_ context.Context, queue string, _ Topology) (EventSubscription, error) {
	ch, err := b.conn.Channel()
	if err != nil {
		return nil, err
	}
	return &rabbitSubscription{ch: ch, queue: queue}, nil
}

type rabbitPublisher struct {
	ch       *amqp.Channel
	exchange string
}

func (p *rabbitPublisher) System() string      { return "rabbitmq" }
func (p *rabbitPublisher) Destination() string { return p.exchange }
func (p *rabbitPublisher) Close() error        { return p.ch.Close() }

func (p *rabbitPublisher) Publish(ctx context.Context, m BrokerMessage) error {
	headers := amqp.Table{}
	if m.TenantID != "" {
		headers["tenant_id"] = m.TenantID
	}
	if m.Traceparent != "" {
		headers["traceparent"] = m.Traceparent
	}
	confirm, err := p.ch.PublishWithDeferredConfirmWithContext(ctx, p.exchange, m.EventType, false, false, amqp.Publishing{
		MessageId: m.MessageID, DeliveryMode: amqp.Persistent, ContentType: "application/json", Type: m.EventType, Headers: headers, Body: m.Body,
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

type rabbitSubscription struct {
	ch    *amqp.Channel
	queue string
}

func (s *rabbitSubscription) System() string { return "rabbitmq" }
func (s *rabbitSubscription) Source() string { return s.queue }
func (s *rabbitSubscription) Close() error   { return s.ch.Close() }

func (s *rabbitSubscription) Poll(_ context.Context) (*Delivery, error) {
	d, ok, err := s.ch.Get(s.queue, false)
	if err != nil || !ok {
		return nil, err
	}
	tenant, _ := d.Headers["tenant_id"].(string)
	traceparent, _ := d.Headers["traceparent"].(string)
	return &Delivery{
		Message: BrokerMessage{MessageID: d.MessageId, EventType: d.Type, TenantID: tenant, Traceparent: traceparent, Body: d.Body},
		Ack:     func(context.Context) error { return d.Ack(false) },
		// Rejected without requeue: RabbitMQ dead-letters it through the queue's DLX.
		DeadLetter: func(context.Context) error { return d.Nack(false, false) },
	}, nil
}

const metadataToken = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

// PubSubBroker: Google Cloud Pub/Sub over its REST API (no client library): topics for the exchange and the DLX, pull
// subscriptions for the queue and the DLQ. Publish returns once Pub/Sub has stored the message. A failed message is
// dead-lettered by the consumer: published to the DLX topic, then acknowledged.
// Auth: none against the emulator (PUBSUB_EMULATOR_HOST); otherwise GOOGLE_OAUTH_ACCESS_TOKEN or the metadata-server
// token of the workload's service account (Cloud Run, GKE workload identity).
type PubSubBroker struct {
	project, root string
	emulator      bool
	http          *http.Client
	mu            sync.Mutex
	token         string
	expiresAt     time.Time
}

func NewPubSubBroker(project, emulatorHost string) *PubSubBroker {
	root := "https://pubsub.googleapis.com"
	if emulatorHost != "" {
		root = "http://" + emulatorHost
	}
	return &PubSubBroker{project: project, root: root + "/v1/projects/" + project, emulator: emulatorHost != "", http: &http.Client{Timeout: 30 * time.Second}}
}

func NewPubSubBrokerFromEnv() (*PubSubBroker, error) {
	project := os.Getenv("PUBSUB_PROJECT_ID")
	if project == "" {
		project = os.Getenv("GOOGLE_CLOUD_PROJECT")
	}
	if project == "" {
		return nil, errors.New("PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set")
	}
	return NewPubSubBroker(project, os.Getenv("PUBSUB_EMULATOR_HOST")), nil
}

func (b *PubSubBroker) System() string        { return "gcp_pubsub" }
func (b *PubSubBroker) DynamicTopology() bool { return true }
func (b *PubSubBroker) Close() error          { return nil }

func (b *PubSubBroker) bearer(ctx context.Context) (string, error) {
	if b.emulator {
		return "", nil
	}
	if tok := os.Getenv("GOOGLE_OAUTH_ACCESS_TOKEN"); tok != "" {
		return tok, nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.token == "" || time.Now().After(b.expiresAt) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, metadataToken, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Metadata-Flavor", "Google")
		res, err := b.http.Do(req)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		var body struct {
			AccessToken string \`json:"access_token"\`
			ExpiresIn   int    \`json:"expires_in"\`
		}
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			return "", err
		}
		b.token, b.expiresAt = body.AccessToken, time.Now().Add(time.Duration(body.ExpiresIn-60)*time.Second)
	}
	return b.token, nil
}

// call sends a request to the API; a status listed in accepted returns (nil, nil) instead of failing.
func (b *PubSubBroker) call(ctx context.Context, method, path string, body any, accepted ...int) (map[string]any, error) {
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, b.root+path, payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if tok, err := b.bearer(ctx); err != nil {
		return nil, err
	} else if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	res, err := b.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode/100 == 2 {
		out := map[string]any{}
		if len(bytes.TrimSpace(raw)) > 0 {
			if err := json.Unmarshal(raw, &out); err != nil {
				return nil, err
			}
		}
		return out, nil
	}
	for _, status := range accepted {
		if res.StatusCode == status {
			return nil, nil
		}
	}
	return nil, fmt.Errorf("pub/sub %s %s failed: %d %s", method, path, res.StatusCode, raw)
}

func (b *PubSubBroker) Declare(ctx context.Context, t Topology) error {
	// 409: it already exists (created earlier or by infrastructure as code).
	steps := []struct {
		path string
		body any
	}{
		{"/topics/" + t.Exchange, map[string]any{}},
		{"/topics/" + t.DLX, map[string]any{}},
		{"/subscriptions/" + t.Queue, map[string]any{"topic": "projects/" + b.project + "/topics/" + t.Exchange, "ackDeadlineSeconds": 60}},
		{"/subscriptions/" + t.DLQ, map[string]any{"topic": "projects/" + b.project + "/topics/" + t.DLX, "ackDeadlineSeconds": 60}},
	}
	for _, s := range steps {
		if _, err := b.call(ctx, http.MethodPut, s.path, s.body, http.StatusConflict); err != nil {
			return err
		}
	}
	return nil
}

func (b *PubSubBroker) publishTo(ctx context.Context, topic string, m BrokerMessage) error {
	attributes := map[string]string{"ghk_message_id": m.MessageID}
	if m.EventType != "" {
		attributes["event_type"] = m.EventType
	}
	if m.TenantID != "" {
		attributes["tenant_id"] = m.TenantID
	}
	if m.Traceparent != "" {
		attributes["traceparent"] = m.Traceparent
	}
	res, err := b.call(ctx, http.MethodPost, "/topics/"+topic+":publish",
		map[string]any{"messages": []any{map[string]any{"data": base64.StdEncoding.EncodeToString(m.Body), "attributes": attributes}}})
	if err != nil {
		return err
	}
	if ids, _ := res["messageIds"].([]any); len(ids) != 1 {
		return fmt.Errorf("pub/sub did not accept message %s", m.MessageID)
	}
	return nil
}

func (b *PubSubBroker) Publisher(_ context.Context, topic string) (EventPublisher, error) {
	return &pubsubPublisher{b: b, topic: topic}, nil
}

func (b *PubSubBroker) Subscribe(_ context.Context, subscription string, t Topology) (EventSubscription, error) {
	return &pubsubSubscription{b: b, subscription: subscription, t: t}, nil
}

type pubsubPublisher struct {
	b     *PubSubBroker
	topic string
}

func (p *pubsubPublisher) System() string      { return "gcp_pubsub" }
func (p *pubsubPublisher) Destination() string { return p.topic }
func (p *pubsubPublisher) Close() error        { return nil }
func (p *pubsubPublisher) Publish(ctx context.Context, m BrokerMessage) error {
	return p.b.publishTo(ctx, p.topic, m)
}

type pubsubSubscription struct {
	b            *PubSubBroker
	subscription string
	t            Topology
}

func (s *pubsubSubscription) System() string { return "gcp_pubsub" }
func (s *pubsubSubscription) Source() string { return s.subscription }
func (s *pubsubSubscription) Close() error   { return nil }

func (s *pubsubSubscription) Poll(ctx context.Context) (*Delivery, error) {
	res, err := s.b.call(ctx, http.MethodPost, "/subscriptions/"+s.subscription+":pull", map[string]any{"maxMessages": 1, "returnImmediately": true})
	if err != nil {
		return nil, err
	}
	received, _ := res["receivedMessages"].([]any)
	if len(received) == 0 {
		return nil, nil
	}
	first, _ := received[0].(map[string]any)
	msg, _ := first["message"].(map[string]any)
	attrs, _ := msg["attributes"].(map[string]any)
	attr := func(key string) string { v, _ := attrs[key].(string); return v }
	ackID, _ := first["ackId"].(string)
	data, _ := msg["data"].(string)
	body, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return nil, err
	}
	id := attr("ghk_message_id")
	if id == "" {
		id, _ = msg["messageId"].(string)
	}
	m := BrokerMessage{MessageID: id, EventType: attr("event_type"), TenantID: attr("tenant_id"), Traceparent: attr("traceparent"), Body: body}
	ack := func(ctx context.Context) error {
		_, err := s.b.call(ctx, http.MethodPost, "/subscriptions/"+s.subscription+":acknowledge", map[string]any{"ackIds": []string{ackID}})
		return err
	}
	return &Delivery{Message: m, Ack: ack, DeadLetter: func(ctx context.Context) error {
		if err := s.b.publishTo(ctx, s.t.DLX, m); err != nil {
			return err
		}
		return ack(ctx)
	}}, nil
}
`;

  const kafkaGo = `package runtime

// Apache Kafka (franz-go, pure Go): topics for the exchange and the DLX; the queue and the DLQ are consumer groups
// on them. KAFKA_BOOTSTRAP_SERVERS, and for managed clusters (Confluent Cloud, Event Hubs, MSK with SASL/SCRAM)
// KAFKA_SECURITY_PROTOCOL, KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD. Publish returns once
// every in-sync replica has the message (acks=all, idempotent producer). Ack commits the offset; a message that is
// neither acked nor dead-lettered is handed out again by the next Poll.

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/plain"
	"github.com/twmb/franz-go/pkg/sasl/scram"
)

type KafkaBroker struct{ opts []kgo.Opt }

func NewKafkaBrokerFromEnv() (*KafkaBroker, error) {
	servers := os.Getenv("KAFKA_BOOTSTRAP_SERVERS")
	if servers == "" {
		return nil, errors.New("KAFKA_BOOTSTRAP_SERVERS is not set (host:9092)")
	}
	opts := []kgo.Opt{kgo.SeedBrokers(strings.Split(servers, ",")...)}
	if strings.HasSuffix(strings.ToUpper(os.Getenv("KAFKA_SECURITY_PROTOCOL")), "SSL") {
		opts = append(opts, kgo.DialTLSConfig(&tls.Config{MinVersion: tls.VersionTLS12}))
	}
	if user := os.Getenv("KAFKA_SASL_USERNAME"); user != "" {
		pass := os.Getenv("KAFKA_SASL_PASSWORD")
		switch strings.ToUpper(os.Getenv("KAFKA_SASL_MECHANISM")) {
		case "SCRAM-SHA-256":
			opts = append(opts, kgo.SASL(scram.Auth{User: user, Pass: pass}.AsSha256Mechanism()))
		case "SCRAM-SHA-512":
			opts = append(opts, kgo.SASL(scram.Auth{User: user, Pass: pass}.AsSha512Mechanism()))
		default:
			opts = append(opts, kgo.SASL(plain.Auth{User: user, Pass: pass}.AsMechanism()))
		}
	}
	return &KafkaBroker{opts: opts}, nil
}

func (b *KafkaBroker) System() string        { return "kafka" }
func (b *KafkaBroker) DynamicTopology() bool { return true }
func (b *KafkaBroker) Close() error          { return nil }

func (b *KafkaBroker) client(extra ...kgo.Opt) (*kgo.Client, error) {
	return kgo.NewClient(append(append([]kgo.Opt{}, b.opts...), extra...)...)
}

func (b *KafkaBroker) Declare(ctx context.Context, t Topology) error {
	cl, err := b.client()
	if err != nil {
		return err
	}
	defer cl.Close()
	resp, err := kadm.NewClient(cl).CreateTopics(ctx, -1, -1, nil, t.Exchange, t.DLX)
	if err != nil {
		return err
	}
	for _, r := range resp {
		if r.Err != nil && !errors.Is(r.Err, kerr.TopicAlreadyExists) {
			return fmt.Errorf("create topic %s: %w", r.Topic, r.Err)
		}
	}
	return nil
}

func kafkaRecord(topic string, m BrokerMessage) *kgo.Record {
	r := &kgo.Record{Topic: topic, Value: m.Body, Headers: []kgo.RecordHeader{{Key: "message_id", Value: []byte(m.MessageID)}}}
	if m.TenantID != "" {
		r.Key = []byte(m.TenantID)
	}
	for _, h := range [][2]string{{"event_type", m.EventType}, {"tenant_id", m.TenantID}, {"traceparent", m.Traceparent}} {
		if h[1] != "" {
			r.Headers = append(r.Headers, kgo.RecordHeader{Key: h[0], Value: []byte(h[1])})
		}
	}
	return r
}

func (b *KafkaBroker) producer() (*kgo.Client, error) {
	return b.client(kgo.RequiredAcks(kgo.AllISRAcks()), kgo.ProduceRequestTimeout(30*time.Second))
}

type kafkaPublisher struct {
	cl    *kgo.Client
	topic string
}

func (b *KafkaBroker) Publisher(_ context.Context, topic string) (EventPublisher, error) {
	cl, err := b.producer()
	if err != nil {
		return nil, err
	}
	return &kafkaPublisher{cl, topic}, nil
}

func (p *kafkaPublisher) System() string      { return "kafka" }
func (p *kafkaPublisher) Destination() string { return p.topic }
func (p *kafkaPublisher) Close() error        { p.cl.Close(); return nil }
func (p *kafkaPublisher) Publish(ctx context.Context, m BrokerMessage) error {
	return p.cl.ProduceSync(ctx, kafkaRecord(p.topic, m)).FirstErr()
}

type kafkaSubscription struct {
	broker      *KafkaBroker
	cl          *kgo.Client
	group       string
	topology    Topology
	buffered    []*kgo.Record
	pending     *Delivery
	deadLetters *kgo.Client
}

func (b *KafkaBroker) Subscribe(_ context.Context, group string, t Topology) (EventSubscription, error) {
	topic := t.Exchange
	if group == t.DLQ {
		topic = t.DLX
	}
	cl, err := b.client(kgo.ConsumerGroup(group), kgo.ConsumeTopics(topic), kgo.DisableAutoCommit(),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()), kgo.FetchMaxWait(200*time.Millisecond))
	if err != nil {
		return nil, err
	}
	return &kafkaSubscription{broker: b, cl: cl, group: group, topology: t}, nil
}

func (s *kafkaSubscription) System() string { return "kafka" }
func (s *kafkaSubscription) Source() string { return s.group }

func (s *kafkaSubscription) Close() error {
	if s.deadLetters != nil {
		s.deadLetters.Close()
	}
	s.cl.Close()
	return nil
}

func kafkaHeader(r *kgo.Record, key string) string {
	for i := len(r.Headers) - 1; i >= 0; i-- {
		if r.Headers[i].Key == key {
			return string(r.Headers[i].Value)
		}
	}
	return ""
}

func (s *kafkaSubscription) Poll(ctx context.Context) (*Delivery, error) {
	// Neither acked nor dead-lettered: hand it out again, as RabbitMQ redelivers an unacknowledged message.
	if s.pending != nil {
		return s.pending, nil
	}
	if len(s.buffered) == 0 {
		pctx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
		fetches := s.cl.PollRecords(pctx, 10)
		cancel()
		for _, fe := range fetches.Errors() {
			if !errors.Is(fe.Err, context.DeadlineExceeded) && !errors.Is(fe.Err, context.Canceled) {
				return nil, fe.Err
			}
		}
		s.buffered = fetches.Records()
	}
	if len(s.buffered) == 0 {
		return nil, nil
	}
	r := s.buffered[0]
	s.buffered = s.buffered[1:]
	id := kafkaHeader(r, "message_id")
	if id == "" {
		id = fmt.Sprintf("%s-%d-%d", r.Topic, r.Partition, r.Offset)
	}
	m := BrokerMessage{MessageID: id, EventType: kafkaHeader(r, "event_type"), TenantID: kafkaHeader(r, "tenant_id"), Traceparent: kafkaHeader(r, "traceparent"), Body: r.Value}
	commit := func(ctx context.Context) error {
		if err := s.cl.CommitRecords(ctx, r); err != nil {
			return err
		}
		s.pending = nil
		return nil
	}
	s.pending = &Delivery{Message: m, Ack: commit, DeadLetter: func(ctx context.Context) error {
		if s.deadLetters == nil {
			cl, err := s.broker.producer()
			if err != nil {
				return err
			}
			s.deadLetters = cl
		}
		if err := s.deadLetters.ProduceSync(ctx, kafkaRecord(s.topology.DLX, m)).FirstErr(); err != nil {
			return err
		}
		return commit(ctx)
	}}
	return s.pending, nil
}
`;

  const serviceBusGo = `package runtime

// Azure Service Bus (official SDK, AMQP): topics for the exchange and the DLX, subscriptions for the queue and the
// DLQ. Auth: SERVICEBUS_CONNECTION_STRING (shared access key; the emulator) or SERVICEBUS_NAMESPACE
// (e.g. orders.servicebus.windows.net) with Microsoft Entra ID (managed identity in Container Apps / AKS).
// A failed message is dead-lettered by the consumer: sent to the DLX topic, then completed.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"
)

type ServiceBusBroker struct {
	client                      *azservicebus.Client
	connectionString, namespace string
	emulator                    bool
}

func NewServiceBusBrokerFromEnv() (*ServiceBusBroker, error) {
	cs, ns := os.Getenv("SERVICEBUS_CONNECTION_STRING"), os.Getenv("SERVICEBUS_NAMESPACE")
	b := &ServiceBusBroker{connectionString: cs, namespace: ns, emulator: strings.Contains(cs, "UseDevelopmentEmulator=true")}
	var err error
	switch {
	case cs != "":
		b.client, err = azservicebus.NewClientFromConnectionString(cs, nil)
	case ns != "":
		cred, credErr := azidentity.NewDefaultAzureCredential(nil)
		if credErr != nil {
			return nil, credErr
		}
		b.client, err = azservicebus.NewClient(ns, cred, nil)
	default:
		return nil, errors.New("SERVICEBUS_CONNECTION_STRING or SERVICEBUS_NAMESPACE is not set")
	}
	if err != nil {
		return nil, err
	}
	return b, nil
}

func (b *ServiceBusBroker) System() string        { return "servicebus" }
func (b *ServiceBusBroker) DynamicTopology() bool { return !b.emulator }
func (b *ServiceBusBroker) Close() error          { return b.client.Close(context.Background()) }

func (b *ServiceBusBroker) Declare(ctx context.Context, t Topology) error {
	// The emulator only knows the entities of its Config.json; in Azure they usually come from Terraform.
	if b.emulator {
		return nil
	}
	var adm *admin.Client
	var err error
	if b.connectionString != "" {
		adm, err = admin.NewClientFromConnectionString(b.connectionString, nil)
	} else {
		cred, credErr := azidentity.NewDefaultAzureCredential(nil)
		if credErr != nil {
			return credErr
		}
		adm, err = admin.NewClient(b.namespace, cred, nil)
	}
	if err != nil {
		return err
	}
	for _, topic := range []string{t.Exchange, t.DLX} {
		if res, err := adm.GetTopic(ctx, topic, nil); err != nil {
			return err
		} else if res == nil {
			if _, err := adm.CreateTopic(ctx, topic, nil); err != nil {
				return err
			}
		}
	}
	for _, s := range [][2]string{{t.Exchange, t.Queue}, {t.DLX, t.DLQ}} {
		if res, err := adm.GetSubscription(ctx, s[0], s[1], nil); err != nil {
			return err
		} else if res == nil {
			if _, err := adm.CreateSubscription(ctx, s[0], s[1], nil); err != nil {
				return err
			}
		}
	}
	return nil
}

func toServiceBusMessage(m BrokerMessage) *azservicebus.Message {
	id, contentType := m.MessageID, "application/json"
	msg := &azservicebus.Message{Body: m.Body, MessageID: &id, ContentType: &contentType, ApplicationProperties: map[string]any{}}
	if m.EventType != "" {
		subject := m.EventType
		msg.Subject = &subject
	}
	if m.TenantID != "" {
		msg.ApplicationProperties["tenant_id"] = m.TenantID
	}
	if m.Traceparent != "" {
		msg.ApplicationProperties["ghk_traceparent"] = m.Traceparent
	}
	return msg
}

type serviceBusPublisher struct {
	sender *azservicebus.Sender
	topic  string
}

func (p *serviceBusPublisher) System() string      { return "servicebus" }
func (p *serviceBusPublisher) Destination() string { return p.topic }
func (p *serviceBusPublisher) Close() error        { return p.sender.Close(context.Background()) }
func (p *serviceBusPublisher) Publish(ctx context.Context, m BrokerMessage) error {
	return p.sender.SendMessage(ctx, toServiceBusMessage(m), nil)
}

func (b *ServiceBusBroker) Publisher(_ context.Context, topic string) (EventPublisher, error) {
	sender, err := b.client.NewSender(topic, nil)
	if err != nil {
		return nil, err
	}
	return &serviceBusPublisher{sender: sender, topic: topic}, nil
}

// serviceBusSubscription receives in a background goroutine, so the AMQP link is opened once and Poll never blocks.
type serviceBusSubscription struct {
	b            *ServiceBusBroker
	receiver     *azservicebus.Receiver
	subscription string
	t            Topology
	messages     chan *azservicebus.ReceivedMessage
	cancel       context.CancelFunc
	done         chan struct{}
	mu           sync.Mutex
	deadLetters  *azservicebus.Sender
}

func (b *ServiceBusBroker) Subscribe(_ context.Context, subscription string, t Topology) (EventSubscription, error) {
	topic := t.Exchange
	if subscription == t.DLQ {
		topic = t.DLX
	}
	receiver, err := b.client.NewReceiverForSubscription(topic, subscription, &azservicebus.ReceiverOptions{ReceiveMode: azservicebus.ReceiveModePeekLock})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &serviceBusSubscription{b: b, receiver: receiver, subscription: subscription, t: t, messages: make(chan *azservicebus.ReceivedMessage), cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(s.done)
		for ctx.Err() == nil {
			received, err := receiver.ReceiveMessages(ctx, 1, nil)
			if err != nil {
				if ctx.Err() == nil {
					time.Sleep(500 * time.Millisecond)
				}
				continue
			}
			for _, m := range received {
				select {
				case s.messages <- m:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return s, nil
}

func (s *serviceBusSubscription) System() string { return "servicebus" }
func (s *serviceBusSubscription) Source() string { return s.subscription }

func (s *serviceBusSubscription) Poll(ctx context.Context) (*Delivery, error) {
	select {
	case msg := <-s.messages:
		prop := func(key string) string {
			if v, ok := msg.ApplicationProperties[key]; ok && v != nil {
				return fmt.Sprint(v)
			}
			return ""
		}
		subject := ""
		if msg.Subject != nil {
			subject = *msg.Subject
		}
		m := BrokerMessage{MessageID: msg.MessageID, EventType: subject, TenantID: prop("tenant_id"), Traceparent: prop("ghk_traceparent"), Body: msg.Body}
		return &Delivery{
			Message: m,
			Ack:     func(ctx context.Context) error { return s.receiver.CompleteMessage(ctx, msg, nil) },
			DeadLetter: func(ctx context.Context) error {
				s.mu.Lock()
				if s.deadLetters == nil {
					sender, err := s.b.client.NewSender(s.t.DLX, nil)
					if err != nil {
						s.mu.Unlock()
						return err
					}
					s.deadLetters = sender
				}
				s.mu.Unlock()
				if err := s.deadLetters.SendMessage(ctx, toServiceBusMessage(m), nil); err != nil {
					return err
				}
				return s.receiver.CompleteMessage(ctx, msg, nil)
			},
		}, nil
	case <-time.After(200 * time.Millisecond):
		return nil, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *serviceBusSubscription) Close() error {
	s.cancel()
	<-s.done
	if s.deadLetters != nil {
		_ = s.deadLetters.Close(context.Background())
	}
	return s.receiver.Close(context.Background())
}
`;

  const relay = `package runtime

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// OutboxRelay publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a
// lease, so concurrent relays never publish the same row; the publisher returns only once the broker
// has accepted the message (RabbitMQ confirms, Pub/Sub / Service Bus send), before a row is marked
// published. Use one relay (and publisher) per goroutine.
type OutboxRelay struct {
	pool         *pgxpool.Pool
	publisher    EventPublisher
	s            string
	LeaseSeconds int
	MaxAttempts  int
}

func NewOutboxRelay(pool *pgxpool.Pool, publisher EventPublisher, schema string) (*OutboxRelay, error) {
	s, err := SchemaName(schema)
	if err != nil {
		return nil, err
	}
	return &OutboxRelay{pool: pool, publisher: publisher, s: s, LeaseSeconds: ${LEASE_SECONDS}, MaxAttempts: ${MAX_PUBLISH_ATTEMPTS}}, nil
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
		destination := r.publisher.Destination()
		spanCtx, span := Tracer().Start(ContextFrom(ctx, c.traceparent), destination+" publish",
			trace.WithSpanKind(trace.SpanKindProducer),
			trace.WithAttributes(attribute.String("messaging.system", r.publisher.System()), attribute.String("messaging.destination.name", destination),
				attribute.String("messaging.message.id", c.id), attribute.String("tenant.id", c.tenant)))
		err := r.publisher.Publish(spanCtx, BrokerMessage{MessageID: c.id, EventType: c.eventType, TenantID: c.tenant, Traceparent: TraceparentOf(spanCtx), Body: []byte(c.payload)})
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
`;

  const inbox = `package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
// redeliveries are acknowledged without running the handler twice. A handler error dead-letters the
// message (RabbitMQ DLX, Pub/Sub / Service Bus dead-letter topic): it is not redelivered.
type InboxConsumer struct {
	pool         *pgxpool.Pool
	subscription EventSubscription
	name         string
	handler      Handler
	s            string
}

func NewInboxConsumer(pool *pgxpool.Pool, subscription EventSubscription, name string, handler Handler, schema string) (*InboxConsumer, error) {
	s, err := SchemaName(schema)
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
	tx, err := c.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, "INSERT INTO "+c.s+".ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", c.name, m.MessageID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		var event map[string]any
		if err := json.Unmarshal(m.Body, &event); err != nil {
			return fmt.Errorf("invalid message body: %w", err)
		}
		if err := c.handler(ctx, event, Meta{MessageID: m.MessageID, TenantID: m.TenantID, EventType: m.EventType, Tx: tx}); err != nil {
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
	broker Broker
	schema string
	topo   Topology
}

func uid() string { return strings.ReplaceAll(uuid.NewString(), "-", "")[:12] }

// setup connects to PostgreSQL and the selected broker (GHK_BROKER: rabbitmq with AMQP_URL, pubsub with
// PUBSUB_PROJECT_ID [+ PUBSUB_EMULATOR_HOST], servicebus).
func setup(t *testing.T) *env {
	t.Helper()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" || !BrokerConfigured() {
		t.Fatal("integration tests need DATABASE_URL and the broker variables (see docs/RUNTIME-KERNEL.md)")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	must(t, err)
	broker, err := ConnectBroker(ctx)
	must(t, err)
	e := &env{ctx: ctx, pool: pool, broker: broker, schema: "it_" + uid()}
	// Brokers with fixed entities (Service Bus emulator) share one topology, emptied before each test.
	if broker.DynamicTopology() {
		e.topo = TopologyFor("it-" + uid())
	} else {
		e.topo = TopologyFor("it")
	}
	must(t, Migrate(ctx, pool, e.schema))
	must(t, broker.Declare(ctx, e.topo))
	if !broker.DynamicTopology() {
		e.receive(t, e.topo.Queue, 0)
		e.receive(t, e.topo.DLQ, 0)
	}
	exporter.Reset()
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "DROP SCHEMA IF EXISTS "+e.schema+" CASCADE")
		_ = broker.Close()
		pool.Close()
	})
	return e
}

// receive acknowledges messages until expected arrived and the source stays quiet for 500 ms (10 s at most).
func (e *env) receive(t *testing.T, source string, expected int) []BrokerMessage {
	t.Helper()
	sub, err := e.broker.Subscribe(e.ctx, source, e.topo)
	must(t, err)
	defer sub.Close()
	var out []BrokerMessage
	deadline := time.Now().Add(10 * time.Second)
	quietSince := time.Now()
	for time.Now().Before(deadline) && (len(out) < expected || time.Since(quietSince) < 500*time.Millisecond) {
		d, err := sub.Poll(e.ctx)
		must(t, err)
		if d == nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		out = append(out, d.Message)
		must(t, d.Ack(e.ctx))
		quietSince = time.Now()
	}
	return out
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
	totals := make([]int, 2)
	var wg sync.WaitGroup
	for i, worker := range []string{"relay-a", "relay-b"} {
		wg.Add(1)
		go func(i int, worker string) {
			defer wg.Done()
			publisher, err := e.broker.Publisher(e.ctx, e.topo.Exchange)
			if err != nil {
				t.Error(err)
				return
			}
			defer publisher.Close()
			relay, err := NewOutboxRelay(e.pool, publisher, e.schema)
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
	received := e.receive(t, e.topo.Queue, 20)
	ids := map[string]bool{}
	for _, m := range received {
		ids[m.MessageID] = true
	}
	if len(received) != 20 || len(ids) != 20 {
		t.Fatalf("received %d messages, %d unique, want 20", len(received), len(ids))
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
	publisher, err := e.broker.Publisher(e.ctx, e.topo.Exchange)
	must(t, err)
	sub, err := e.broker.Subscribe(e.ctx, e.topo.Queue, e.topo)
	must(t, err)
	var handled []string
	consumer, err := NewInboxConsumer(e.pool, sub, "it-consumer", func(_ context.Context, event map[string]any, meta Meta) error {
		if event["poison"] == true {
			return errors.New("cannot process")
		}
		handled = append(handled, meta.MessageID)
		return nil
	}, e.schema)
	must(t, err)
	publish := func(id, body string) {
		must(t, publisher.Publish(e.ctx, BrokerMessage{MessageID: id, EventType: "Test", TenantID: "t1", Body: []byte(body)}))
	}
	publish("m-1", \`{"ok": true}\`)
	publish("m-1", \`{"ok": true}\`)
	publish("m-poison", \`{"poison": true}\`)
	_, err = consumer.Drain(e.ctx, time.Second)
	must(t, err)
	_ = sub.Close()
	_ = publisher.Close()
	if !reflect.DeepEqual(handled, []string{"m-1"}) {
		t.Fatalf("handled %v", handled)
	}
	if n := e.count(t, "ghk_inbox", "consumer = $1", "it-consumer"); n != 1 {
		t.Fatalf("inbox rows = %d", n)
	}
	dead := e.receive(t, e.topo.DLQ, 1)
	if len(dead) != 1 || dead[0].MessageID != "m-poison" {
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
	publisher, err := e.broker.Publisher(e.ctx, e.topo.Exchange)
	must(t, err)
	relay, err := NewOutboxRelay(e.pool, publisher, e.schema)
	must(t, err)
	if n, err := relay.PublishBatch(e.ctx, "relay", 10); err != nil || n != 1 {
		t.Fatalf("published %d err=%v", n, err)
	}
	_ = publisher.Close()
	received := 0
	sub, err := e.broker.Subscribe(e.ctx, e.topo.Queue, e.topo)
	must(t, err)
	consumer, err := NewInboxConsumer(e.pool, sub, "trace-consumer", func(context.Context, map[string]any, Meta) error { received++; return nil }, e.schema)
	must(t, err)
	_, err = consumer.Drain(e.ctx, time.Second)
	must(t, err)
	_ = sub.Close()
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
    { filename: 'internal/runtime/otel.go', content: `package runtime

import (
	"context"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// StartTelemetry exports spans over OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set (service.name from
// OTEL_SERVICE_NAME); the returned function flushes them on shutdown. Without the variable it does nothing.
func StartTelemetry(ctx context.Context) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
		return noop, nil
	}
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return noop, err
	}
	name := os.Getenv("OTEL_SERVICE_NAME")
	if name == "" {
		name = ${goStr(m.service || m.kebab)}
	}
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(attribute.String("service.name", name)))
	if err != nil {
		return noop, err
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter), sdktrace.WithResource(res))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return provider.Shutdown, nil
}
` },
    { filename: 'internal/runtime/command_service.go', content: commandService },
    { filename: 'internal/runtime/broker.go', content: broker },
    ...(serviceBus ? [{ filename: 'internal/runtime/servicebus_broker.go', content: serviceBusGo }] : []),
    ...(kafka ? [{ filename: 'internal/runtime/kafka_broker.go', content: kafkaGo }] : []),
    { filename: 'internal/runtime/outbox_relay.go', content: relay },
    { filename: 'internal/runtime/inbox_consumer.go', content: inbox },
    { filename: 'internal/runtime/saga.go', content: saga },
    { filename: 'internal/runtime/runtime_integration_test.go', content: test }
  ];
}
