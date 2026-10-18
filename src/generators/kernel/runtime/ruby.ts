/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for Ruby (Rails)
   pg + bunny + OpenTelemetry Ruby. Contract: docs/RUNTIME-KERNEL.md.
   Files under app/runtime/ are autoloaded by Rails (one constant per file).
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { defaultJvmBroker as defaultBrokerFor } from './jvm';
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

export function renderRbRuntime(m: DomainModel, siblings: DomainModel[] = [], { messaging = undefined as string | undefined } = {}): RbRuntimeFile[] {
  // Service Bus has no official Ruby SDK: stack.messaging "servicebus" keeps RabbitMQ as the default broker.
  const defaultBroker = defaultBrokerFor(messaging) === 'pubsub' ? 'pubsub' : 'rabbitmq';
  const all = [m, ...siblings];
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
  # Aggregate type used when a request does not name one.
  DEFAULT_AGGREGATE = ${rb(m.pascal)}
  # Every aggregate of the service: aggregate class, command class and command names.
  AGGREGATES = {
${all.map(a => `    ${rb(a.pascal)} => { aggregate: ${a.pascal}Aggregate, command: ${a.pascal}Command, commands: %w[${a.commands.map(c => c.snake).join(' ')}] }`).join(',\n')}
  }.freeze

  Result = Struct.new(:status, :aggregate_id, :event_type, :version, keyword_init: true)

  def initialize(database_url, schema = "public")
    @database_url = database_url
    @s = RuntimeSchema.name_for(schema)
  end

  def handle(tenant_id:, aggregate_id:, command:, payload: {}, idempotency_key: nil, traceparent: nil, aggregate_type: nil)
    raise DomainValidationError, "tenant_id is required" if tenant_id.to_s.empty?

    aggregate_type ||= DEFAULT_AGGREGATE
    raise DomainValidationError, "Unknown aggregate type #{aggregate_type}" unless AGGREGATES.key?(aggregate_type)

    parent = RuntimeTelemetry.context_from(traceparent)
    span = RuntimeTelemetry.tracer.start_span("#{aggregate_type}.#{command}", with_parent: parent, kind: :internal,
                                              attributes: { "tenant.id" => tenant_id, "aggregate.id" => aggregate_id })
    conn = PG.connect(@database_url)
    begin
      conn.transaction do |tx|
        execute(tx, aggregate_type, tenant_id, aggregate_id, command, payload, idempotency_key, RuntimeTelemetry.traceparent_of(span, parent))
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
  def load(tenant_id, aggregate_id, aggregate_type = DEFAULT_AGGREGATE)
    conn = PG.connect(@database_url)
    row = conn.exec_params("SELECT state, version FROM #{@s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3",
                           [tenant_id, aggregate_type, aggregate_id]).first
    row && { state: row["state"], version: row["version"].to_i }
  ensure
    conn&.close
  end

  private

  def execute(tx, aggregate_type, tenant_id, aggregate_id, command, payload, key, traceparent)
    kind = AGGREGATES.fetch(aggregate_type)
    if key
      claim = tx.exec_params("INSERT INTO #{@s}.ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING", [tenant_id, key])
      if claim.cmd_tuples.zero?
        row = tx.exec_params("SELECT status, response FROM #{@s}.ghk_idempotency WHERE tenant_id = $1 AND key = $2", [tenant_id, key]).first
        return Result.new(**JSON.parse(row["response"], symbolize_names: true).merge(status: "replayed")) if row && row["status"] == "COMPLETED"

        return Result.new(status: "in-progress", aggregate_id: aggregate_id)
      end
    end
    row = tx.exec_params("SELECT state, version FROM #{@s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE",
                         [tenant_id, aggregate_type, aggregate_id]).first
    aggregate = row ? kind[:aggregate].restore(aggregate_id, row["state"], row["version"].to_i) : kind[:aggregate].new(aggregate_id)
    raise DomainValidationError, "Unknown command #{command}" unless kind[:commands].include?(command)

    event = aggregate.public_send(command, kind[:command].new(id: aggregate_id, payload: payload || {}))
    tx.exec_params("INSERT INTO #{@s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5) " \\
                   "ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
                   [tenant_id, aggregate_type, aggregate_id, aggregate.state, aggregate.version])
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

# Event bus destinations: publish to exchange (topic), consume from queue (subscription);
# dead-lettered messages go to dlx and are read from dlq.
RuntimeTopology = Struct.new(:exchange, :queue, :dlx, :dlq) do
  def self.default
    new(${rb(t.exchange)}, ${rb(t.queue)}, ${rb(t.dlx)}, ${rb(t.dlq)})
  end

  def self.for_prefix(prefix)
    new("#{prefix}.events", "#{prefix}.consumer", "#{prefix}.dlx", "#{prefix}.dlq")
  end
end
`;

  const brokerMessageRb = `# frozen_string_literal: true

# A domain event on the wire, independent of the broker.
BrokerMessage = Struct.new(:message_id, :event_type, :tenant_id, :traceparent, :body, keyword_init: true)
`;

  const brokerDeliveryRb = `# frozen_string_literal: true

# A received message: ack once processed; dead_letter moves it to the DLQ (it is not redelivered).
BrokerDelivery = Struct.new(:message, :on_ack, :on_dead_letter) do
  def ack
    on_ack.call
  end

  def dead_letter
    on_dead_letter.call
  end
end
`;

  const eventBrokerRb = `# frozen_string_literal: true

# The event broker behind the outbox relay and the inbox consumer, chosen at run time so one image runs on any
# cloud: GHK_BROKER=rabbitmq (AMQP_URL) or pubsub (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT; PUBSUB_EMULATOR_HOST).
# Without GHK_BROKER the configured variables decide, then stack.messaging.
# Azure Service Bus has no official Ruby SDK: on Azure use self-managed RabbitMQ or CloudAMQP (AMQP_URL).
#
# Brokers answer: system, dynamic_topology?, declare(topology), publisher(destination), subscribe(source, topology),
# close. Publishers: system, destination, publish(message) (returns once the broker accepted it), close.
# Subscriptions: system, source, poll (a BrokerDelivery or nil), close.
module EventBroker
  # Broker of the generated configuration (stack.messaging).
  DEFAULT_KIND = ${rb(defaultBroker)}

  def self.env(key)
    value = ENV.fetch(key, "").strip
    value.empty? ? nil : value
  end

  def self.kind
    return env("GHK_BROKER").downcase if env("GHK_BROKER")
    return "rabbitmq" if env("AMQP_URL")
    return "pubsub" if env("PUBSUB_PROJECT_ID") || env("PUBSUB_EMULATOR_HOST")

    DEFAULT_KIND
  end

  # Whether the variables of the selected broker are set.
  def self.configured?
    kind == "pubsub" ? !(env("PUBSUB_PROJECT_ID") || env("GOOGLE_CLOUD_PROJECT")).nil? : !env("AMQP_URL").nil?
  end

  def self.connect
    case kind
    when "rabbitmq"
      RabbitMqBroker.new(env("AMQP_URL") || raise("AMQP_URL is not set (amqp://user:password@host:5672)"))
    when "pubsub" then PubSubBroker.from_env
    when "servicebus" then raise "Azure Service Bus has no official Ruby SDK: use RabbitMQ (self-managed or CloudAMQP) on Azure"
    else raise "Unsupported GHK_BROKER: #{kind} (rabbitmq, pubsub)"
    end
  end
end
`;

  const rabbitRb = `# frozen_string_literal: true

require "bunny"

# RabbitMQ 0-9-1: topic exchange, publisher confirms, dead-lettering through the queue's DLX.
class RabbitMqBroker
  def initialize(url)
    @connection = Bunny.new(url, logger: Logger.new(nil)).tap(&:start)
  end

  def system = "rabbitmq"
  def dynamic_topology? = true

  def declare(topology)
    channel = @connection.create_channel
    events = channel.topic(topology.exchange, durable: true)
    dead = channel.fanout(topology.dlx, durable: true)
    channel.queue(topology.dlq, durable: true).bind(dead)
    channel.queue(topology.queue, durable: true, arguments: { "x-dead-letter-exchange" => topology.dlx }).bind(events, routing_key: "#")
  ensure
    channel&.close
  end

  def publisher(exchange)
    Publisher.new(@connection.create_channel, exchange)
  end

  def subscribe(queue, _topology)
    Subscription.new(@connection.create_channel, queue)
  end

  def close
    @connection.close if @connection.open?
  end

  # One channel per publisher (use one per thread).
  class Publisher
    attr_reader :destination

    def initialize(channel, exchange)
      @channel = channel
      @channel.confirm_select
      @exchange = channel.topic(exchange, durable: true)
      @destination = exchange
    end

    def system = "rabbitmq"

    def publish(message)
      headers = {}
      headers["tenant_id"] = message.tenant_id if message.tenant_id
      headers["traceparent"] = message.traceparent if message.traceparent
      @exchange.publish(message.body, routing_key: message.event_type.to_s, message_id: message.message_id, persistent: true,
                                      content_type: "application/json", type: message.event_type, headers: headers)
      raise "broker did not confirm #{message.message_id}" unless @channel.wait_for_confirms
    end

    def close
      @channel.close if @channel.open?
    end
  end

  class Subscription
    attr_reader :source

    def initialize(channel, queue)
      @channel = channel
      @queue = channel.queue(queue, passive: true)
      @source = queue
    end

    def system = "rabbitmq"

    def poll
      delivery, properties, body = @queue.pop(manual_ack: true)
      return nil if delivery.nil?

      headers = properties.headers || {}
      message = BrokerMessage.new(message_id: properties.message_id.to_s, event_type: properties.type, tenant_id: headers["tenant_id"]&.to_s,
                                  traceparent: headers["traceparent"]&.to_s, body: body)
      tag = delivery.delivery_tag
      # Rejected without requeue: RabbitMQ dead-letters it through the queue's DLX.
      BrokerDelivery.new(message, -> { @channel.ack(tag) }, -> { @channel.reject(tag, false) })
    end

    def close
      @channel.close if @channel.open?
    end
  end
end
`;

  const pubsubRb = `# frozen_string_literal: true

require "json"
require "net/http"
require "uri"

# Google Cloud Pub/Sub over its REST API (no client library): topics for the exchange and the DLX, pull subscriptions
# for the queue and the DLQ. publish returns once Pub/Sub has stored the message. A failed message is dead-lettered by
# the consumer: published to the DLX topic, then acknowledged.
# Auth: none against the emulator (PUBSUB_EMULATOR_HOST); otherwise GOOGLE_OAUTH_ACCESS_TOKEN or the metadata-server
# token of the workload's service account (Cloud Run, GKE workload identity).
class PubSubBroker
  METADATA_TOKEN = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

  def self.from_env
    project = EventBroker.env("PUBSUB_PROJECT_ID") || EventBroker.env("GOOGLE_CLOUD_PROJECT") ||
              raise("PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set")
    new(project, EventBroker.env("PUBSUB_EMULATOR_HOST"))
  end

  def initialize(project, emulator_host = nil)
    @project = project
    @emulator = !emulator_host.nil?
    @root = "#{@emulator ? "http://#{emulator_host}" : "https://pubsub.googleapis.com"}/v1/projects/#{project}"
    @lock = Mutex.new
  end

  def system = "gcp_pubsub"
  def dynamic_topology? = true
  def close; end

  def declare(topology)
    # 409: it already exists (created earlier or by infrastructure as code).
    call(:put, "/topics/#{topology.exchange}", {}, accepted: [409])
    call(:put, "/topics/#{topology.dlx}", {}, accepted: [409])
    call(:put, "/subscriptions/#{topology.queue}", { topic: "projects/#{@project}/topics/#{topology.exchange}", ackDeadlineSeconds: 60 }, accepted: [409])
    call(:put, "/subscriptions/#{topology.dlq}", { topic: "projects/#{@project}/topics/#{topology.dlx}", ackDeadlineSeconds: 60 }, accepted: [409])
  end

  def publisher(topic)
    Publisher.new(self, topic)
  end

  def subscribe(subscription, topology)
    Subscription.new(self, subscription, topology)
  end

  def publish_to(topic, message)
    attributes = { "ghk_message_id" => message.message_id }
    attributes["event_type"] = message.event_type if message.event_type
    attributes["tenant_id"] = message.tenant_id if message.tenant_id
    attributes["traceparent"] = message.traceparent if message.traceparent
    res = call(:post, "/topics/#{topic}:publish", { messages: [{ data: [message.body].pack("m0"), attributes: attributes }] })
    raise "Pub/Sub did not accept message #{message.message_id}" unless res&.dig("messageIds")&.size == 1
  end

  # Calls the API; a status listed in accepted returns nil instead of failing.
  def call(method, path, body = nil, accepted: [])
    uri = URI("#{@root}#{path}")
    request = (method == :put ? Net::HTTP::Put : Net::HTTP::Post).new(uri, "Content-Type" => "application/json")
    request.body = JSON.generate(body) unless body.nil?
    token = bearer
    request["Authorization"] = "Bearer #{token}" if token
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", read_timeout: 30) { |http| http.request(request) }
    code = response.code.to_i
    return (response.body.to_s.strip.empty? ? {} : JSON.parse(response.body)) if code.between?(200, 299)
    return nil if accepted.include?(code)

    raise "Pub/Sub #{method.upcase} #{path} failed: #{code} #{response.body}"
  end

  private

  def bearer
    return nil if @emulator
    return EventBroker.env("GOOGLE_OAUTH_ACCESS_TOKEN") if EventBroker.env("GOOGLE_OAUTH_ACCESS_TOKEN")

    @lock.synchronize do
      if @token.nil? || Time.now > @expires_at
        uri = URI(METADATA_TOKEN)
        body = Net::HTTP.start(uri.host, uri.port, read_timeout: 5) { |http| http.get(uri.path, "Metadata-Flavor" => "Google") }.body
        data = JSON.parse(body)
        @token = data.fetch("access_token")
        @expires_at = Time.now + data.fetch("expires_in").to_i - 60
      end
      @token
    end
  end

  class Publisher
    attr_reader :destination

    def initialize(broker, topic)
      @broker = broker
      @destination = topic
    end

    def system = "gcp_pubsub"

    def publish(message)
      @broker.publish_to(@destination, message)
    end

    def close; end
  end

  class Subscription
    attr_reader :source

    def initialize(broker, subscription, topology)
      @broker = broker
      @source = subscription
      @topology = topology
    end

    def system = "gcp_pubsub"

    def poll
      res = @broker.call(:post, "/subscriptions/#{@source}:pull", { maxMessages: 1, returnImmediately: true }) || {}
      first = (res["receivedMessages"] || []).first
      return nil if first.nil?

      msg = first["message"]
      attrs = msg["attributes"] || {}
      message = BrokerMessage.new(message_id: attrs["ghk_message_id"] || msg["messageId"], event_type: attrs["event_type"], tenant_id: attrs["tenant_id"],
                                  traceparent: attrs["traceparent"], body: msg.fetch("data", "").unpack1("m"))
      ack = -> { @broker.call(:post, "/subscriptions/#{@source}:acknowledge", { ackIds: [first["ackId"]] }) }
      BrokerDelivery.new(message, ack, lambda {
        @broker.publish_to(@topology.dlx, message)
        ack.call
      })
    end

    def close; end
  end
end
`;

  const relay = `# frozen_string_literal: true

# Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
# concurrent relays never publish the same row; the publisher returns only once the broker has
# accepted the message (RabbitMQ confirms, Pub/Sub publish), before a row is marked published.
# Use one relay (and publisher) per thread.
class OutboxRelay
  def initialize(database_url, publisher, schema = "public", lease_seconds: ${LEASE_SECONDS}, max_attempts: ${MAX_PUBLISH_ATTEMPTS})
    @database_url = database_url
    @publisher = publisher
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
    destination = @publisher.destination
    span = RuntimeTelemetry.tracer.start_span("#{destination} publish", with_parent: parent, kind: :producer,
                                              attributes: { "messaging.system" => @publisher.system, "messaging.destination.name" => destination,
                                                            "messaging.message.id" => row["id"], "tenant.id" => row["tenant_id"] })
    @publisher.publish(BrokerMessage.new(message_id: row["id"], event_type: row["event_type"], tenant_id: row["tenant_id"],
                                         traceparent: RuntimeTelemetry.traceparent_of(span, parent), body: row["payload"]))

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
# dead-letters the message (RabbitMQ DLX, Pub/Sub dead-letter topic): it is not redelivered.
class InboxConsumer
  def initialize(database_url, subscription, consumer_name, schema = "public", &handler)
    @database_url = database_url
    @subscription = subscription
    @consumer_name = consumer_name
    @handler = handler
    @s = RuntimeSchema.name_for(schema)
  end

  # Processes messages until the source stays empty for idle_seconds; returns how many were processed.
  def drain(idle_seconds = 1.0)
    processed = 0
    idle_since = Time.now
    while Time.now - idle_since < idle_seconds
      delivery = @subscription.poll
      if delivery.nil?
        sleep 0.05
        next
      end
      process(delivery)
      processed += 1
      idle_since = Time.now
    end
    processed
  end

  private

  def process(delivery)
    message = delivery.message
    source = @subscription.source
    span = RuntimeTelemetry.tracer.start_span("#{source} process", with_parent: RuntimeTelemetry.context_from(message.traceparent), kind: :consumer,
                                              attributes: { "messaging.system" => @subscription.system, "messaging.destination.name" => source,
                                                            "messaging.message.id" => message.message_id.to_s })
    conn = PG.connect(@database_url)
    conn.transaction do |tx|
      first = tx.exec_params("INSERT INTO #{@s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [@consumer_name, message.message_id])
      if first.cmd_tuples == 1
        @handler.call(JSON.parse(message.body), { message_id: message.message_id, tenant_id: message.tenant_id, event_type: message.event_type, connection: tx })
      end
    end
    delivery.ack
  rescue StandardError => e
    span.record_exception(e)
    span.status = OpenTelemetry::Trace::Status.error(e.message)
    delivery.dead_letter
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

# Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and the selected broker
# (GHK_BROKER: rabbitmq with AMQP_URL, pubsub with PUBSUB_PROJECT_ID [+ PUBSUB_EMULATOR_HOST]).
# Requires DATABASE_URL. Run with: bundle exec rspec --tag integration
ENV["OTEL_TRACES_EXPORTER"] ||= "none"
require "rails_helper"
require "opentelemetry/sdk"
require "securerandom"

EXPORTER = OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new
OpenTelemetry::SDK.configure { |c| c.add_span_processor(OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(EXPORTER)) }

RSpec.describe "${m.pascal} runtime (PostgreSQL + RabbitMQ)", :integration do
  let(:database_url) { ENV.fetch("DATABASE_URL") { raise "Integration tests need DATABASE_URL and the broker variables (see docs/RUNTIME-KERNEL.md)." } }
  let(:uid) { SecureRandom.hex(6) }
  let(:schema) { "it_#{uid}" }
  let(:topology) { RuntimeTopology.for_prefix("it-#{uid}") }
  let(:command) { ${rb(first.snake)} }
  let(:event) { ${rb(first.event)} }
  let(:service) { CommandService.new(database_url, schema) }
  let(:broker) do
    raise "Integration tests need the broker variables (see docs/RUNTIME-KERNEL.md)." unless EventBroker.configured?

    EventBroker.connect
  end

  def count(table, where = "true", params = [])
    conn = PG.connect(database_url)
    conn.exec_params("SELECT count(*) FROM #{schema}.#{table} WHERE #{where}", params).getvalue(0, 0).to_i
  ensure
    conn&.close
  end

  # Receives and acknowledges messages until expected arrived and the source stays quiet for 0.5 s (10 s at most).
  def receive(source, expected)
    subscription = broker.subscribe(source, topology)
    out = []
    deadline = Time.now + 10
    quiet_since = Time.now
    while Time.now < deadline && (out.size < expected || Time.now - quiet_since < 0.5)
      delivery = subscription.poll
      if delivery.nil?
        sleep 0.05
        next
      end
      out << delivery.message
      delivery.ack
      quiet_since = Time.now
    end
    out
  ensure
    subscription&.close
  end

  before do
    RuntimeSchema.migrate(database_url, schema)
    broker.declare(topology)
    EXPORTER.reset
  end

  after do
    conn = PG.connect(database_url)
    conn.exec("DROP SCHEMA IF EXISTS #{schema} CASCADE")
    conn.close
    broker.close
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
    totals = %w[relay-a relay-b].map do |worker|
      Thread.new do
        publisher = broker.publisher(topology.exchange)
        relay = OutboxRelay.new(database_url, publisher, schema)
        total = 0
        while (n = relay.publish_batch(worker, 3)).positive?
          total += n
        end
        publisher.close
        total
      end
    end.map(&:value)
    expect(totals.sum).to eq(20)
    expect(count("ghk_outbox", "published_at IS NULL")).to eq(0)
    received = receive(topology.queue, 20)
    expect(received.size).to eq(20)
    expect(received.map(&:message_id).uniq.size).to eq(20)
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
    handled = []
    publisher = broker.publisher(topology.exchange)
    [["m-1", '{"ok": true}'], ["m-1", '{"ok": true}'], ["m-poison", '{"poison": true}']].each do |id, body|
      publisher.publish(BrokerMessage.new(message_id: id, event_type: "Test", tenant_id: "t1", body: body))
    end
    publisher.close
    subscription = broker.subscribe(topology.queue, topology)
    consumer = InboxConsumer.new(database_url, subscription, "it-consumer", schema) do |payload, meta|
      raise "cannot process" if payload["poison"]

      handled << meta[:message_id]
    end
    consumer.drain(1.0)
    subscription.close
    expect(handled).to eq(["m-1"])
    expect(count("ghk_inbox", "consumer = $1", ["it-consumer"])).to eq(1)
    expect(receive(topology.dlq, 1).map(&:message_id)).to eq(["m-poison"])
  end

  it "IT7 the incoming trace context flows through command, outbox, publish and consume spans" do
    service.handle(tenant_id: "t1", aggregate_id: "agg-1", command: command, traceparent: ${rb(TEST_TRACEPARENT)})
    conn = PG.connect(database_url)
    expect(conn.exec("SELECT traceparent FROM #{schema}.ghk_outbox").getvalue(0, 0)).to include(${rb(TEST_TRACE_ID)})
    conn.close
    publisher = broker.publisher(topology.exchange)
    expect(OutboxRelay.new(database_url, publisher, schema).publish_batch("relay", 10)).to eq(1)
    publisher.close
    received = []
    subscription = broker.subscribe(topology.queue, topology)
    InboxConsumer.new(database_url, subscription, "trace-consumer", schema) { |_payload, meta| received << meta }.drain(1.0)
    subscription.close
    expect(received.size).to eq(1)

    spans = EXPORTER.finished_spans.group_by(&:kind).transform_values(&:last)
    expect(spans[:internal].hex_trace_id).to eq(${rb(TEST_TRACE_ID)})
    expect(spans[:internal].hex_parent_span_id).to eq(${rb(TEST_PARENT_SPAN_ID)})
    expect(spans[:producer].hex_trace_id).to eq(${rb(TEST_TRACE_ID)})
    expect(spans[:consumer].hex_trace_id).to eq(${rb(TEST_TRACE_ID)})
    expect(spans[:consumer].hex_parent_span_id).to eq(spans[:producer].hex_span_id)
  end
end
`;

  return [
    { filename: 'app/runtime/runtime_schema.rb', content: schema },
    { filename: 'app/runtime/runtime_telemetry.rb', content: telemetry },
    { filename: 'app/runtime/command_service.rb', content: commandService },
    { filename: 'app/runtime/runtime_topology.rb', content: topologyRb },
    { filename: 'app/runtime/broker_message.rb', content: brokerMessageRb },
    { filename: 'app/runtime/broker_delivery.rb', content: brokerDeliveryRb },
    { filename: 'app/runtime/event_broker.rb', content: eventBrokerRb },
    { filename: 'app/runtime/rabbit_mq_broker.rb', content: rabbitRb },
    { filename: 'app/runtime/pub_sub_broker.rb', content: pubsubRb },
    { filename: 'app/runtime/outbox_relay.rb', content: relay },
    { filename: 'app/runtime/inbox_consumer.rb', content: inbox },
    { filename: 'app/runtime/saga_orchestrator.rb', content: saga },
    { filename: 'spec/integration/runtime_spec.rb', content: spec }
  ];
}
