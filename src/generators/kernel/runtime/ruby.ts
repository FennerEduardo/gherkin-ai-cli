/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for Ruby (Rails)
   pg + bunny + OpenTelemetry Ruby. Contract: docs/RUNTIME-KERNEL.md.
   Files under app/runtime/ are autoloaded by Rails (one constant per file).
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface RbRuntimeFile {
  filename: string;
  content: string;
}

export const RB_RUNTIME_GEMS = `gem "pg", "~> 1.5"
gem "bunny", "~> 2.23"
gem "opentelemetry-sdk", "~> 1.5"
`;

const rb = (s: string) => JSON.stringify(s); // JSON strings are valid Ruby double-quoted literals here (no #{)

export function renderRbRuntime(m: DomainModel): RbRuntimeFile[] {
  const t = topology(m);
  const A = `${m.pascal}Aggregate`;
  const statements = RUNTIME_SCHEMA_SQL.map(s => `    ${rb(s)}`).join(',\n');

  const schema = `# frozen_string_literal: true

# Runtime tables (docs/RUNTIME-KERNEL.md).
module RuntimeSchema
  STATEMENTS = [
${statements}
  ].freeze

${RLS_NOTE.split('\n').map(l => `  ${l.replace(/^-- ?/, '# ')}`).join('\n')}

  def self.name_for(schema = "public")
    s = schema.to_s.empty? ? "public" : schema.to_s
    raise ArgumentError, "Invalid schema name: #{s}" unless s.match?(/\\A[a-z_][a-z0-9_]*\\z/)

    s
  end

  def self.migrate(database_url, schema = "public")
    s = name_for(schema)
    conn = PG.connect(database_url)
    STATEMENTS.each { |statement| conn.exec(statement.gsub(${rb(SCHEMA_TOKEN)}, s)) }
  ensure
    conn&.close
  end
end
`;

  const telemetry = `# frozen_string_literal: true

require "opentelemetry"

# W3C trace-context helpers; spans go to the global tracer provider (configure exporters with OTEL_*).
module RuntimeTelemetry
  PROPAGATOR = OpenTelemetry::Trace::Propagation::TraceContext.text_map_propagator

  def self.tracer
    OpenTelemetry.tracer_provider.tracer(${rb(m.kebab)})
  end

  # Context whose parent is the span described by an incoming traceparent header.
  def self.context_from(traceparent)
    return OpenTelemetry::Context.current if traceparent.nil? || traceparent.empty?

    PROPAGATOR.extract({ "traceparent" => traceparent }, context: OpenTelemetry::Context.empty)
  end

  # traceparent header value for a span (nil when the span is invalid).
  def self.traceparent_of(span, parent)
    carrier = {}
    PROPAGATOR.inject(carrier, context: OpenTelemetry::Trace.context_with_span(span, parent_context: parent))
    carrier["traceparent"]
  end
end
`;

  const commandService = `# frozen_string_literal: true

require "json"
require "securerandom"

# Executes a command in one transaction: idempotency claim, aggregate load (FOR UPDATE), domain
# logic, aggregate save and outbox insert. A domain error rolls back everything.
class CommandService
  AGGREGATE_TYPE = ${rb(m.pascal)}
  COMMANDS = {
${m.commands.map(c => `    ${rb(c.snake)} => ->(aggregate, command) { aggregate.${c.snake}(command) }`).join(',\n')}
  }.freeze

  Result = Struct.new(:status, :aggregate_id, :event_type, :version, keyword_init: true)

  def initialize(database_url, schema = "public")
    @database_url = database_url
    @s = RuntimeSchema.name_for(schema)
  end

  def handle(tenant_id:, aggregate_id:, command:, payload: {}, idempotency_key: nil, traceparent: nil)
    raise DomainValidationError, "tenant_id is required" if tenant_id.to_s.empty?

    parent = RuntimeTelemetry.context_from(traceparent)
    span = RuntimeTelemetry.tracer.start_span("${m.pascal}.#{command}", with_parent: parent, kind: :internal,
                                              attributes: { "tenant.id" => tenant_id, "aggregate.id" => aggregate_id })
    conn = PG.connect(@database_url)
    begin
      conn.transaction do |tx|
        execute(tx, tenant_id, aggregate_id, command, payload, idempotency_key, RuntimeTelemetry.traceparent_of(span, parent))
      end
    rescue StandardError => e
      span.record_exception(e)
      span.status = OpenTelemetry::Trace::Status.error(e.message)
      raise
    ensure
      conn.close
      span.finish
    end
  end

  # The aggregate as the tenant sees it (nil for other tenants' aggregates).
  def load(tenant_id, aggregate_id)
    conn = PG.connect(@database_url)
    row = conn.exec_params("SELECT state, version FROM #{@s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3",
                           [tenant_id, AGGREGATE_TYPE, aggregate_id]).first
    row && { state: row["state"], version: row["version"].to_i }
  ensure
    conn&.close
  end

  private

  def execute(tx, tenant_id, aggregate_id, command, payload, key, traceparent)
    if key
      claim = tx.exec_params("INSERT INTO #{@s}.ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING", [tenant_id, key])
      if claim.cmd_tuples.zero?
        row = tx.exec_params("SELECT status, response FROM #{@s}.ghk_idempotency WHERE tenant_id = $1 AND key = $2", [tenant_id, key]).first
        return Result.new(**JSON.parse(row["response"], symbolize_names: true).merge(status: "replayed")) if row && row["status"] == "COMPLETED"

        return Result.new(status: "in-progress", aggregate_id: aggregate_id)
      end
    end
    row = tx.exec_params("SELECT state, version FROM #{@s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE",
                         [tenant_id, AGGREGATE_TYPE, aggregate_id]).first
    aggregate = row ? ${A}.restore(aggregate_id, row["state"], row["version"].to_i) : ${A}.new(aggregate_id)
    handler = COMMANDS[command] or raise DomainValidationError, "Unknown command #{command}"
    event = handler.call(aggregate, ${m.pascal}Command.new(id: aggregate_id, payload: payload || {}))
    tx.exec_params("INSERT INTO #{@s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5) " \\
                   "ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
                   [tenant_id, AGGREGATE_TYPE, aggregate_id, aggregate.state, aggregate.version])
    tx.exec_params("INSERT INTO #{@s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES ($1, $2, $3, $4, $5, $6)",
                   [SecureRandom.uuid, tenant_id, aggregate_id, event.type, JSON.generate(event.to_h), traceparent])
    result = Result.new(status: "created", aggregate_id: aggregate_id, event_type: event.type, version: event.version)
    if key
      tx.exec_params("UPDATE #{@s}.ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND key = $2",
                     [tenant_id, key, JSON.generate(result.to_h)])
    end
    result
  end
end
`;

  const topologyRb = `# frozen_string_literal: true

# Topic exchange -> consumer queue, which dead-letters rejected messages to a fanout DLX -> DLQ.
RuntimeTopology = Struct.new(:exchange, :queue, :dlx, :dlq) do
  def self.default
    new(${rb(t.exchange)}, ${rb(t.queue)}, ${rb(t.dlx)}, ${rb(t.dlq)})
  end

  def self.for_prefix(prefix)
    new("#{prefix}.events", "#{prefix}.consumer", "#{prefix}.dlx", "#{prefix}.dlq")
  end

  def declare(channel)
    events = channel.topic(exchange, durable: true)
    dead = channel.fanout(dlx, durable: true)
    channel.queue(dlq, durable: true).bind(dead)
    channel.queue(queue, durable: true, arguments: { "x-dead-letter-exchange" => dlx }).bind(events, routing_key: "#")
  end
end
`;

  const relay = `# frozen_string_literal: true

# Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
# concurrent relays never publish the same row; publisher confirms guarantee delivery to the broker
# before a row is marked published. Use one relay (and channel) per thread.
class OutboxRelay
  def initialize(database_url, channel, exchange = RuntimeTopology.default.exchange, schema = "public", lease_seconds: ${LEASE_SECONDS}, max_attempts: ${MAX_PUBLISH_ATTEMPTS})
    @database_url = database_url
    @channel = channel
    @channel.confirm_select
    @exchange = channel.topic(exchange, durable: true)
    @s = RuntimeSchema.name_for(schema)
    @lease_seconds = lease_seconds
    @max_attempts = max_attempts
  end

  def publish_batch(worker_id, limit = 50)
    conn = PG.connect(@database_url)
    rows = conn.exec_params(
      "UPDATE #{@s}.ghk_outbox SET claimed_by = $1, claimed_until = now() + make_interval(secs => $2), attempts = attempts + 1 " \\
      "WHERE id IN (SELECT id FROM #{@s}.ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < now()) " \\
      "ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING id, tenant_id, event_type, payload, traceparent",
      [worker_id, @lease_seconds, limit]
    ).to_a
    rows.count { |row| publish(conn, row, worker_id) }
  ensure
    conn&.close
  end

  private

  def publish(conn, row, worker_id)
    parent = RuntimeTelemetry.context_from(row["traceparent"])
    span = RuntimeTelemetry.tracer.start_span("#{@exchange.name} publish", with_parent: parent, kind: :producer,
                                              attributes: { "messaging.system" => "rabbitmq", "messaging.destination.name" => @exchange.name,
                                                            "messaging.message.id" => row["id"], "tenant.id" => row["tenant_id"] })
    headers = { "tenant_id" => row["tenant_id"] }
    traceparent = RuntimeTelemetry.traceparent_of(span, parent)
    headers["traceparent"] = traceparent if traceparent
    @exchange.publish(row["payload"], routing_key: row["event_type"], message_id: row["id"], persistent: true,
                                      content_type: "application/json", type: row["event_type"], headers: headers)
    raise "broker did not confirm #{row['id']}" unless @channel.wait_for_confirms

    conn.exec_params("UPDATE #{@s}.ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = $1 AND claimed_by = $2", [row["id"], worker_id])
    true
  rescue StandardError => e
    span.record_exception(e)
    span.status = OpenTelemetry::Trace::Status.error(e.message)
    conn.exec_params("UPDATE #{@s}.ghk_outbox SET claimed_until = NULL, last_error = $2, failed_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END WHERE id = $1",
                     [row["id"], e.message, @max_attempts])
    false
  ensure
    span.finish
  end
end
`;

  const inbox = `# frozen_string_literal: true

require "json"

# Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
# handler, so redeliveries are acknowledged without running the handler twice. A handler error
# rejects the message without requeue, so RabbitMQ dead-letters it to the DLQ.
class InboxConsumer
  def initialize(database_url, channel, queue, consumer_name, schema = "public", &handler)
    @database_url = database_url
    @channel = channel
    @queue = channel.queue(queue, passive: true)
    @consumer_name = consumer_name
    @handler = handler
    @s = RuntimeSchema.name_for(schema)
  end

  # Processes messages until the queue stays empty for idle_seconds; returns how many were processed.
  def drain(idle_seconds = 1.0)
    processed = 0
    idle_since = Time.now
    while Time.now - idle_since < idle_seconds
      delivery, properties, body = @queue.pop(manual_ack: true)
      if delivery.nil?
        sleep 0.05
        next
      end
      process(delivery, properties, body)
      processed += 1
      idle_since = Time.now
    end
    processed
  end

  private

  def process(delivery, properties, body)
    headers = properties.headers || {}
    span = RuntimeTelemetry.tracer.start_span("#{@queue.name} process", with_parent: RuntimeTelemetry.context_from(headers["traceparent"]), kind: :consumer,
                                              attributes: { "messaging.system" => "rabbitmq", "messaging.destination.name" => @queue.name,
                                                            "messaging.message.id" => properties.message_id.to_s })
    conn = PG.connect(@database_url)
    conn.transaction do |tx|
      first = tx.exec_params("INSERT INTO #{@s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [@consumer_name, properties.message_id])
      if first.cmd_tuples == 1
        @handler.call(JSON.parse(body), { message_id: properties.message_id, tenant_id: headers["tenant_id"], event_type: properties.type, connection: tx })
      end
    end
    @channel.ack(delivery.delivery_tag)
  rescue StandardError => e
    span.record_exception(e)
    span.status = OpenTelemetry::Trace::Status.error(e.message)
    @channel.reject(delivery.delivery_tag, false)
  ensure
    conn&.close
    span.finish
  end
end
`;

  const saga = `# frozen_string_literal: true

# Orchestrated saga: progress is persisted after every step; when a step fails, the completed steps
# are compensated in reverse order. Re-running a saga id resumes after its completed steps.
class SagaOrchestrator
  Step = Struct.new(:name, :action, :compensate)

  def initialize(database_url, schema = "public")
    @database_url = database_url
    @s = RuntimeSchema.name_for(schema)
  end

  def run(saga_id, tenant_id, steps)
    conn = PG.connect(@database_url)
    conn.exec_params("INSERT INTO #{@s}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING", [saga_id, tenant_id])
    done = conn.exec_params("SELECT completed_steps FROM #{@s}.ghk_sagas WHERE id = $1 AND tenant_id = $2", [saga_id, tenant_id]).first&.fetch("completed_steps").to_s
    completed = done.empty? ? [] : done.split(",")
    steps.each do |step|
      next if completed.include?(step.name)

      begin
        step.action.call
      rescue StandardError
        save(conn, saga_id, "COMPENSATING", completed)
        completed.reverse.each do |name|
          steps.find { |s| s.name == name }.compensate.call
          completed.delete(name)
          save(conn, saga_id, "COMPENSATING", completed)
        end
        save(conn, saga_id, "COMPENSATED", completed)
        return "COMPENSATED"
      end
      completed << step.name
      save(conn, saga_id, "RUNNING", completed)
    end
    save(conn, saga_id, "COMPLETED", completed)
    "COMPLETED"
  ensure
    conn&.close
  end

  def status(saga_id)
    conn = PG.connect(@database_url)
    row = conn.exec_params("SELECT status, completed_steps FROM #{@s}.ghk_sagas WHERE id = $1", [saga_id]).first
    row && { status: row["status"], completed_steps: row["completed_steps"].empty? ? [] : row["completed_steps"].split(",") }
  ensure
    conn&.close
  end

  private

  def save(conn, saga_id, status, completed)
    conn.exec_params("UPDATE #{@s}.ghk_sagas SET status = $2, completed_steps = $3, updated_at = now() WHERE id = $1", [saga_id, status, completed.join(",")])
  end
end
`;

  const first = m.commands[0];
  const spec = `# frozen_string_literal: true

# Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and RabbitMQ.
# Requires DATABASE_URL and AMQP_URL. Run with: bundle exec rspec --tag integration
ENV["OTEL_TRACES_EXPORTER"] ||= "none"
require "rails_helper"
require "bunny"
require "opentelemetry/sdk"
require "securerandom"

EXPORTER = OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new
OpenTelemetry::SDK.configure { |c| c.add_span_processor(OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(EXPORTER)) }

RSpec.describe "${m.pascal} runtime (PostgreSQL + RabbitMQ)", :integration do
  let(:database_url) { ENV.fetch("DATABASE_URL") { raise "Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md)." } }
  let(:amqp_url) { ENV.fetch("AMQP_URL") { raise "Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md)." } }
  let(:uid) { SecureRandom.hex(6) }
  let(:schema) { "it_#{uid}" }
  let(:topology) { RuntimeTopology.for_prefix("it-#{uid}") }
  let(:command) { ${rb(first.snake)} }
  let(:event) { ${rb(first.event)} }
  let(:service) { CommandService.new(database_url, schema) }

  def connect_amqp
    Bunny.new(amqp_url, logger: Logger.new(nil)).tap(&:start)
  end

  def count(table, where = "true", params = [])
    conn = PG.connect(database_url)
    conn.exec_params("SELECT count(*) FROM #{schema}.#{table} WHERE #{where}", params).getvalue(0, 0).to_i
  ensure
    conn&.close
  end

  def drain_queue(channel, queue)
    q = channel.queue(queue, passive: true)
    out = []
    loop do
      _delivery, properties, _body = q.pop
      break if properties.nil?

      out << properties
    end
    out
  end

  def wait_for
    deadline = Time.now + 10
    sleep 0.05 until yield || Time.now > deadline
    raise "timed out waiting for condition" unless yield
  end

  before do
    RuntimeSchema.migrate(database_url, schema)
    EXPORTER.reset
  end

  after do
    conn = PG.connect(database_url)
    conn.exec("DROP SCHEMA IF EXISTS #{schema} CASCADE")
    conn.close
  end

  it "IT1 persists the aggregate and one outbox row atomically; a domain error persists nothing" do
    result = service.handle(tenant_id: "t1", aggregate_id: "agg-1", command: command)
    expect([result.status, result.event_type, result.version]).to eq(["created", event, 1])
    expect(service.load("t1", "agg-1")[:version]).to eq(1)
    expect(count("ghk_outbox", "aggregate_id = $1", ["agg-1"])).to eq(1)
    expect { service.handle(tenant_id: "t1", aggregate_id: "agg-2", command: "no_such_command", idempotency_key: "k-fail") }
      .to raise_error(DomainValidationError, /Unknown command/)
    expect(service.load("t1", "agg-2")).to be_nil
    expect(count("ghk_outbox", "aggregate_id = $1", ["agg-2"])).to eq(0)
    expect(count("ghk_idempotency", "key = $1", ["k-fail"])).to eq(0)
  end

  it "IT2 five concurrent requests with one idempotency key produce one effect and identical responses" do
    results = Array.new(5) { Thread.new { service.handle(tenant_id: "t1", aggregate_id: "agg-1", command: command, idempotency_key: "key-1") } }.map(&:value)
    expect(count("ghk_outbox")).to eq(1)
    expect(service.load("t1", "agg-1")[:version]).to eq(1)
    expect(results.count { |r| r.status == "created" }).to eq(1)
    expect(results.map { |r| [r.event_type, r.version] }.uniq).to eq([[event, 1]])
  end

  it "IT3 two concurrent relays publish every outbox event exactly once" do
    20.times { |i| service.handle(tenant_id: "t1", aggregate_id: "agg-#{i}", command: command) }
    amqp = connect_amqp
    setup = amqp.create_channel
    topology.declare(setup)
    totals = %w[relay-a relay-b].map do |worker|
      Thread.new do
        relay = OutboxRelay.new(database_url, amqp.create_channel, topology.exchange, schema)
        total = 0
        while (n = relay.publish_batch(worker, 3)).positive?
          total += n
        end
        total
      end
    end.map(&:value)
    expect(totals.sum).to eq(20)
    expect(count("ghk_outbox", "published_at IS NULL")).to eq(0)
    wait_for { setup.queue(topology.queue, passive: true).message_count == 20 }
    expect(drain_queue(setup, topology.queue).map(&:message_id).uniq.size).to eq(20)
  ensure
    amqp&.close
  end

  it "IT4 tenants cannot read or change each other's aggregates" do
    service.handle(tenant_id: "tenant-a", aggregate_id: "shared-id", command: command)
    expect(service.load("tenant-b", "shared-id")).to be_nil
    service.handle(tenant_id: "tenant-b", aggregate_id: "shared-id", command: command)
    expect(service.load("tenant-a", "shared-id")[:version]).to eq(1)
    expect(service.load("tenant-b", "shared-id")[:version]).to eq(1)
    expect(count("ghk_outbox", "tenant_id = $1", ["tenant-a"])).to eq(1)
  end

  it "IT5 a failing saga step compensates the completed steps in reverse order" do
    saga = SagaOrchestrator.new(database_url, schema)
    log = []
    step = lambda do |name, fail = false|
      SagaOrchestrator::Step.new(name, -> { raise "#{name} failed" if fail; log << "do:#{name}" }, -> { log << "undo:#{name}" })
    end
    expect(saga.run("saga-1", "t1", [step.call("reserve"), step.call("charge"), step.call("ship", true)])).to eq("COMPENSATED")
    expect(log).to eq(%w[do:reserve do:charge undo:charge undo:reserve])
    expect(saga.status("saga-1")).to eq(status: "COMPENSATED", completed_steps: [])
    expect(saga.run("saga-2", "t1", [step.call("reserve"), step.call("charge")])).to eq("COMPLETED")
  end

  it "IT6 a redelivered message is handled once and a failing message is dead-lettered" do
    amqp = connect_amqp
    channel = amqp.create_channel
    topology.declare(channel)
    handled = []
    consumer = InboxConsumer.new(database_url, channel, topology.queue, "it-consumer", schema) do |payload, meta|
      raise "cannot process" if payload["poison"]

      handled << meta[:message_id]
    end
    exchange = channel.topic(topology.exchange, durable: true)
    [["m-1", '{"ok": true}'], ["m-1", '{"ok": true}'], ["m-poison", '{"poison": true}']].each do |id, body|
      exchange.publish(body, routing_key: "Test", message_id: id, headers: { "tenant_id" => "t1" })
    end
    consumer.drain(1.0)
    expect(handled).to eq(["m-1"])
    expect(count("ghk_inbox", "consumer = $1", ["it-consumer"])).to eq(1)
    wait_for { channel.queue(topology.dlq, passive: true).message_count == 1 }
    expect(drain_queue(channel, topology.dlq).map(&:message_id)).to eq(["m-poison"])
  ensure
    amqp&.close
  end

  it "IT7 the incoming trace context flows through command, outbox, publish and consume spans" do
    service.handle(tenant_id: "t1", aggregate_id: "agg-1", command: command, traceparent: ${rb(TEST_TRACEPARENT)})
    conn = PG.connect(database_url)
    expect(conn.exec("SELECT traceparent FROM #{schema}.ghk_outbox").getvalue(0, 0)).to include(${rb(TEST_TRACE_ID)})
    conn.close
    amqp = connect_amqp
    channel = amqp.create_channel
    topology.declare(channel)
    expect(OutboxRelay.new(database_url, channel, topology.exchange, schema).publish_batch("relay", 10)).to eq(1)
    received = []
    InboxConsumer.new(database_url, amqp.create_channel, topology.queue, "trace-consumer", schema) { |_payload, meta| received << meta }.drain(1.0)
    expect(received.size).to eq(1)

    spans = EXPORTER.finished_spans.group_by(&:kind).transform_values(&:last)
    expect(spans[:internal].hex_trace_id).to eq(${rb(TEST_TRACE_ID)})
    expect(spans[:internal].hex_parent_span_id).to eq(${rb(TEST_PARENT_SPAN_ID)})
    expect(spans[:producer].hex_trace_id).to eq(${rb(TEST_TRACE_ID)})
    expect(spans[:consumer].hex_trace_id).to eq(${rb(TEST_TRACE_ID)})
    expect(spans[:consumer].hex_parent_span_id).to eq(spans[:producer].hex_span_id)
  ensure
    amqp&.close
  end
end
`;

  return [
    { filename: 'app/runtime/runtime_schema.rb', content: schema },
    { filename: 'app/runtime/runtime_telemetry.rb', content: telemetry },
    { filename: 'app/runtime/command_service.rb', content: commandService },
    { filename: 'app/runtime/runtime_topology.rb', content: topologyRb },
    { filename: 'app/runtime/outbox_relay.rb', content: relay },
    { filename: 'app/runtime/inbox_consumer.rb', content: inbox },
    { filename: 'app/runtime/saga_orchestrator.rb', content: saga },
    { filename: 'spec/integration/runtime_spec.rb', content: spec }
  ];
}
