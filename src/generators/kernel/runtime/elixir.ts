/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for Elixir (Phoenix)
   Postgrex + AMQP + OpenTelemetry Erlang/Elixir. Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface ExRuntimeFile {
  filename: string;
  content: string;
}

export const EX_RUNTIME_DEPS = `,
      {:postgrex, "~> 0.19"},
      {:amqp, "~> 4.0"},
      {:opentelemetry_api, "~> 1.4"},
      {:opentelemetry, "~> 1.5"}`;

/** Spans are exported only when configured (OTEL_* / config); keep the SDK quiet by default. */
export const EX_RUNTIME_CONFIG = `
# OpenTelemetry: no exporter unless configured (e.g. opentelemetry_exporter with OTEL_EXPORTER_OTLP_ENDPOINT).
config :opentelemetry, traces_exporter: :none

# Tests export spans synchronously so the runtime integration test can assert trace propagation.
if config_env() == :test do
  config :opentelemetry, processors: [{:otel_simple_processor, %{}}]
end
`;

const ex = (s: string) => JSON.stringify(s).replace(/#\{/g, '\\#{');

export function renderExRuntime(m: DomainModel, otp: string, mod: string): ExRuntimeFile[] {
  const t = topology(m);
  const agg = `${mod}.Domain.${m.pascal}Aggregate`;
  const ns = `${mod}.Runtime`;
  const dir = `lib/${otp}/runtime`;
  const statements = RUNTIME_SCHEMA_SQL.map(s => `    ${ex(s)}`).join(',\n');

  const schema = `defmodule ${ns}.Schema do
  @moduledoc "Runtime tables (docs/RUNTIME-KERNEL.md)."

  @statements [
${statements}
  ]

${RLS_NOTE.split('\n').map(l => `  ${l.replace(/^-- ?/, '# ')}`).join('\n')}

  @doc "Validated schema identifier."
  def name(schema \\\\ "public") do
    if Regex.match?(~r/^[a-z_][a-z0-9_]*$/, schema), do: schema, else: raise(ArgumentError, "Invalid schema name: #{schema}")
  end

  @doc "Postgrex options from a libpq-style URL: postgres://user:password@host:5432/database"
  def connection_opts(database_url) do
    uri = URI.parse(database_url)
    {user, password} =
      case String.split(uri.userinfo || "", ":", parts: 2) do
        [u, p] -> {URI.decode(u), URI.decode(p)}
        [u] -> {URI.decode(u), nil}
      end

    [hostname: uri.host, port: uri.port || 5432, database: String.trim_leading(uri.path || "", "/"), username: user, password: password]
  end

  @doc "Creates the runtime tables (idempotent)."
  def migrate(conn, schema \\\\ "public") do
    s = name(schema)
    Enum.each(@statements, &Postgrex.query!(conn, String.replace(&1, ${ex(SCHEMA_TOKEN)}, s), []))
  end
end
`;

  const telemetry = `defmodule ${ns}.Telemetry do
  @moduledoc """
  W3C trace-context helpers. Spans go to the configured OpenTelemetry SDK
  (exporters are configured with the OTEL_* variables or the :opentelemetry app env).
  """

  def tracer, do: :opentelemetry.get_tracer(:${otp})

  @doc "Context whose parent is the span described by an incoming traceparent header."
  def context_from(nil), do: :otel_ctx.new()
  def context_from(""), do: :otel_ctx.new()

  def context_from(traceparent) do
    :otel_propagator_text_map.extract_to(:otel_ctx.new(), :otel_propagator_trace_context, [{"traceparent", traceparent}])
  end

  @doc "Starts a span (kind: :internal | :producer | :consumer) under a parent context; returns {span_ctx, ctx_with_span}."
  def start_span(parent_ctx, name, kind, attributes) do
    span_ctx = :otel_tracer.start_span(parent_ctx, tracer(), name, %{kind: kind, attributes: attributes})
    {span_ctx, :otel_tracer.set_current_span(parent_ctx, span_ctx)}
  end

  @doc "traceparent header value for a context (nil when it carries no valid span)."
  def traceparent_of(ctx) do
    ctx
    |> :otel_propagator_text_map.inject_from(:otel_propagator_trace_context, [])
    |> List.keyfind("traceparent", 0)
    |> case do
      {_, value} -> value
      nil -> nil
    end
  end

  def error(span_ctx, exception) do
    :otel_span.set_status(span_ctx, :opentelemetry.status(:error, Exception.message(exception)))
  end
end
`;

  const commandService = `defmodule ${ns}.CommandService do
  @moduledoc """
  Executes a command in one transaction: idempotency claim, aggregate load (FOR UPDATE), domain
  logic, aggregate save and outbox insert. A domain error rolls back everything.
  """
  alias ${agg}
  alias ${ns}.{Schema, Telemetry}

  @aggregate_type ${ex(m.pascal)}
  @commands %{
${m.commands.map(c => `    ${ex(c.snake)} => &${m.pascal}Aggregate.${c.snake}/2`).join(',\n')}
  }

  defmodule DomainError do
    defexception [:message]
  end

  @doc """
  request: %{tenant_id, aggregate_id, command, payload, idempotency_key, traceparent}.
  Returns %{status: "created" | "replayed" | "in-progress", aggregate_id, event_type, version}.
  """
  def handle(conn, schema, request) do
    s = Schema.name(schema)
    if (request[:tenant_id] || "") == "", do: raise(DomainError, "tenant_id is required")

    {span, ctx} =
      Telemetry.start_span(Telemetry.context_from(request[:traceparent]), "${m.pascal}.#{request.command}", :internal, %{
        "tenant.id" => request.tenant_id,
        "aggregate.id" => request.aggregate_id
      })

    try do
      case Postgrex.transaction(conn, fn tx -> execute(tx, s, request, Telemetry.traceparent_of(ctx)) end) do
        {:ok, result} -> result
        {:error, reason} -> raise DomainError, inspect(reason)
      end
    rescue
      e ->
        Telemetry.error(span, e)
        reraise e, __STACKTRACE__
    after
      :otel_span.end_span(span)
    end
  end

  defp execute(tx, s, req, traceparent) do
    key = req[:idempotency_key]

    case claim(tx, s, req.tenant_id, key) do
      {:replay, result} -> result
      :claimed -> apply_command(tx, s, req, key, traceparent)
    end
  end

  defp claim(_tx, _s, _tenant, nil), do: :claimed

  defp claim(tx, s, tenant, key) do
    %{num_rows: inserted} = Postgrex.query!(tx, "INSERT INTO #{s}.ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING", [tenant, key])

    if inserted == 1 do
      :claimed
    else
      case Postgrex.query!(tx, "SELECT status, response FROM #{s}.ghk_idempotency WHERE tenant_id = $1 AND key = $2", [tenant, key]).rows do
        [["COMPLETED", response]] -> {:replay, response |> Jason.decode!(keys: :atoms) |> Map.put(:status, "replayed")}
        _ -> {:replay, %{status: "in-progress", aggregate_id: nil, event_type: nil, version: nil}}
      end
    end
  end

  defp apply_command(tx, s, req, key, traceparent) do
    aggregate =
      case Postgrex.query!(tx, "SELECT state, version FROM #{s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE",
             [req.tenant_id, @aggregate_type, req.aggregate_id]).rows do
        [[state, version]] -> ${m.pascal}Aggregate.restore(req.aggregate_id, state, version)
        [] -> unwrap(${m.pascal}Aggregate.new(req.aggregate_id))
      end

    handler = Map.get(@commands, req.command) || raise(DomainError, "Unknown command #{req.command}")
    {updated, event} = unwrap(handler.(aggregate, %{id: req.aggregate_id, payload: req[:payload] || %{}}))

    Postgrex.query!(
      tx,
      "INSERT INTO #{s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5) " <>
        "ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
      [req.tenant_id, @aggregate_type, req.aggregate_id, updated.state, updated.version]
    )

    Postgrex.query!(tx, "INSERT INTO #{s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES ($1, $2, $3, $4, $5, $6)", [
      uuid(),
      req.tenant_id,
      req.aggregate_id,
      event.type,
      Jason.encode!(event),
      traceparent
    ])

    result = %{status: "created", aggregate_id: req.aggregate_id, event_type: event.type, version: event.version}

    if key do
      Postgrex.query!(tx, "UPDATE #{s}.ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND key = $2", [req.tenant_id, key, Jason.encode!(result)])
    end

    result
  end

  defp unwrap({:ok, aggregate}), do: aggregate
  defp unwrap({:ok, aggregate, event}), do: {aggregate, event}
  defp unwrap({:error, reason}), do: raise(DomainError, reason)

  @doc "The aggregate as the tenant sees it (nil for other tenants' aggregates)."
  def load(conn, schema, tenant_id, aggregate_id) do
    case Postgrex.query!(conn, "SELECT state, version FROM #{Schema.name(schema)}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3",
           [tenant_id, @aggregate_type, aggregate_id]).rows do
      [[state, version]] -> %{state: state, version: version}
      [] -> nil
    end
  end

  def uuid do
    <<a::32, b::16, _::4, c::12, _::2, d::62>> = :crypto.strong_rand_bytes(16)
    <<a::32, b::16, 4::4, c::12, 2::2, d::62>> |> Base.encode16(case: :lower) |> then(fn h ->
      String.slice(h, 0, 8) <> "-" <> String.slice(h, 8, 4) <> "-" <> String.slice(h, 12, 4) <> "-" <> String.slice(h, 16, 4) <> "-" <> String.slice(h, 20, 12)
    end)
  end
end
`;

  const topologyEx = `defmodule ${ns}.Topology do
  @moduledoc "Topic exchange -> consumer queue, which dead-letters rejected messages to a fanout DLX -> DLQ."
  defstruct exchange: ${ex(t.exchange)}, queue: ${ex(t.queue)}, dlx: ${ex(t.dlx)}, dlq: ${ex(t.dlq)}

  def for_prefix(prefix), do: %__MODULE__{exchange: "#{prefix}.events", queue: "#{prefix}.consumer", dlx: "#{prefix}.dlx", dlq: "#{prefix}.dlq"}

  def declare(chan, %__MODULE__{} = t) do
    :ok = AMQP.Exchange.declare(chan, t.exchange, :topic, durable: true)
    :ok = AMQP.Exchange.declare(chan, t.dlx, :fanout, durable: true)
    {:ok, _} = AMQP.Queue.declare(chan, t.dlq, durable: true)
    :ok = AMQP.Queue.bind(chan, t.dlq, t.dlx)
    {:ok, _} = AMQP.Queue.declare(chan, t.queue, durable: true, arguments: [{"x-dead-letter-exchange", :longstr, t.dlx}])
    :ok = AMQP.Queue.bind(chan, t.queue, t.exchange, routing_key: "#")
  end
end
`;

  const relay = `defmodule ${ns}.OutboxRelay do
  @moduledoc """
  Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
  concurrent relays never publish the same row; publisher confirms guarantee delivery to the
  broker before a row is marked published. Use one relay (and channel) per process.
  """
  alias ${ns}.{Schema, Telemetry}

  @lease_seconds ${LEASE_SECONDS}
  @max_attempts ${MAX_PUBLISH_ATTEMPTS}

  @doc "Puts the channel in confirm mode; call once per channel."
  def prepare(chan), do: AMQP.Confirm.select(chan)

  def publish_batch(conn, chan, exchange, schema, worker_id, limit \\\\ 50) do
    s = Schema.name(schema)

    %{rows: rows} =
      Postgrex.query!(
        conn,
        "UPDATE #{s}.ghk_outbox SET claimed_by = $1, claimed_until = now() + make_interval(secs => $2), attempts = attempts + 1 " <>
          "WHERE id IN (SELECT id FROM #{s}.ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < now()) " <>
          "ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING id, tenant_id, event_type, payload, traceparent",
        [worker_id, @lease_seconds * 1.0, limit]
      )

    Enum.count(rows, fn row -> publish(conn, chan, exchange, s, worker_id, row) end)
  end

  defp publish(conn, chan, exchange, s, worker_id, [id, tenant, event_type, payload, traceparent]) do
    {span, ctx} =
      Telemetry.start_span(Telemetry.context_from(traceparent), "#{exchange} publish", :producer, %{
        "messaging.system" => "rabbitmq",
        "messaging.destination.name" => exchange,
        "messaging.message.id" => id,
        "tenant.id" => tenant
      })

    headers = [{"tenant_id", :longstr, tenant}] ++ Enum.map(List.wrap(Telemetry.traceparent_of(ctx)), &{"traceparent", :longstr, &1})

    try do
      :ok = AMQP.Basic.publish(chan, exchange, event_type, payload, message_id: id, persistent: true, content_type: "application/json", type: event_type, headers: headers)
      true = AMQP.Confirm.wait_for_confirms(chan, 10_000)
      Postgrex.query!(conn, "UPDATE #{s}.ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = $1 AND claimed_by = $2", [id, worker_id])
      true
    rescue
      e ->
        Telemetry.error(span, e)
        Postgrex.query!(conn, "UPDATE #{s}.ghk_outbox SET claimed_until = NULL, last_error = $2, failed_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END WHERE id = $1", [
          id,
          Exception.message(e),
          @max_attempts
        ])

        false
    after
      :otel_span.end_span(span)
    end
  end
end
`;

  const inbox = `defmodule ${ns}.InboxConsumer do
  @moduledoc """
  Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
  handler, so redeliveries are acknowledged without running the handler twice. A handler error
  rejects the message without requeue, so RabbitMQ dead-letters it to the DLQ.
  """
  alias ${ns}.{Schema, Telemetry}

  @doc "Processes messages until the queue stays empty for idle_ms; returns how many were processed. handler.(event, meta)"
  def drain(conn, chan, queue, consumer, schema, handler, idle_ms \\\\ 1000) do
    loop(conn, chan, queue, consumer, Schema.name(schema), handler, idle_ms, System.monotonic_time(:millisecond), 0)
  end

  defp loop(conn, chan, queue, consumer, s, handler, idle_ms, idle_since, processed) do
    if System.monotonic_time(:millisecond) - idle_since >= idle_ms do
      processed
    else
      case AMQP.Basic.get(chan, queue, no_ack: false) do
        {:ok, payload, meta} ->
          process(conn, chan, queue, consumer, s, handler, payload, meta)
          loop(conn, chan, queue, consumer, s, handler, idle_ms, System.monotonic_time(:millisecond), processed + 1)

        {:empty, _} ->
          Process.sleep(50)
          loop(conn, chan, queue, consumer, s, handler, idle_ms, idle_since, processed)
      end
    end
  end

  defp header(meta, name) do
    headers = if is_list(meta.headers), do: meta.headers, else: []

    case List.keyfind(headers, name, 0) do
      {_, _, value} -> value
      _ -> nil
    end
  end

  defp process(conn, chan, queue, consumer, s, handler, payload, meta) do
    {span, _ctx} =
      Telemetry.start_span(Telemetry.context_from(header(meta, "traceparent")), "#{queue} process", :consumer, %{
        "messaging.system" => "rabbitmq",
        "messaging.destination.name" => queue,
        "messaging.message.id" => to_string(meta.message_id)
      })

    try do
      {:ok, _} =
        Postgrex.transaction(conn, fn tx ->
          %{num_rows: first} = Postgrex.query!(tx, "INSERT INTO #{s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [consumer, meta.message_id])

          if first == 1 do
            handler.(Jason.decode!(payload), %{message_id: meta.message_id, tenant_id: header(meta, "tenant_id"), event_type: meta.type, conn: tx})
          end
        end)

      AMQP.Basic.ack(chan, meta.delivery_tag)
    rescue
      e ->
        Telemetry.error(span, e)
        AMQP.Basic.reject(chan, meta.delivery_tag, requeue: false)
    after
      :otel_span.end_span(span)
    end
  end
end
`;

  const saga = `defmodule ${ns}.Saga do
  @moduledoc """
  Orchestrated saga: progress is persisted after every step; when a step fails, the completed
  steps are compensated in reverse order. Re-running a saga id resumes after its completed steps.
  Steps are %{name: String.t(), action: (-> any), compensate: (-> any)}.
  """
  alias ${ns}.Schema

  def run(conn, schema, saga_id, tenant_id, steps) do
    s = Schema.name(schema)
    Postgrex.query!(conn, "INSERT INTO #{s}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING", [saga_id, tenant_id])
    completed = (status(conn, schema, saga_id) || %{completed_steps: []}).completed_steps
    advance(conn, s, saga_id, steps, steps, completed)
  end

  defp advance(conn, s, saga_id, [], _all, completed) do
    save(conn, s, saga_id, "COMPLETED", completed)
    "COMPLETED"
  end

  defp advance(conn, s, saga_id, [step | rest], all, completed) do
    if step.name in completed do
      advance(conn, s, saga_id, rest, all, completed)
    else
      try do
        step.action.()
        completed = completed ++ [step.name]
        save(conn, s, saga_id, "RUNNING", completed)
        advance(conn, s, saga_id, rest, all, completed)
      rescue
        _ -> compensate(conn, s, saga_id, all, completed)
      end
    end
  end

  defp compensate(conn, s, saga_id, all, completed) do
    save(conn, s, saga_id, "COMPENSATING", completed)

    remaining =
      Enum.reduce(Enum.reverse(completed), completed, fn name, acc ->
        Enum.find(all, &(&1.name == name)).compensate.()
        acc = List.delete(acc, name)
        save(conn, s, saga_id, "COMPENSATING", acc)
        acc
      end)

    save(conn, s, saga_id, "COMPENSATED", remaining)
    "COMPENSATED"
  end

  def status(conn, schema, saga_id) do
    case Postgrex.query!(conn, "SELECT status, completed_steps FROM #{Schema.name(schema)}.ghk_sagas WHERE id = $1", [saga_id]).rows do
      [[status, ""]] -> %{status: status, completed_steps: []}
      [[status, done]] -> %{status: status, completed_steps: String.split(done, ",")}
      [] -> nil
    end
  end

  defp save(conn, s, saga_id, status, completed) do
    Postgrex.query!(conn, "UPDATE #{s}.ghk_sagas SET status = $2, completed_steps = $3, updated_at = now() WHERE id = $1", [saga_id, status, Enum.join(completed, ",")])
  end
end
`;

  const first = m.commands[0];
  const test = `defmodule ${ns}.IntegrationTest do
  @moduledoc "Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7). Requires DATABASE_URL and AMQP_URL."
  use ExUnit.Case, async: false
  require Record

  @moduletag :integration

  Record.defrecordp(:span, Record.extract(:span, from_lib: "opentelemetry/include/otel_span.hrl"))

  alias ${ns}.{CommandService, InboxConsumer, OutboxRelay, Saga, Schema, Topology}

  @command ${ex(first.snake)}
  @event ${ex(first.event)}

  setup_all do
    database_url = System.get_env("DATABASE_URL") || flunk("Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md).")
    amqp_url = System.get_env("AMQP_URL") || flunk("Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md).")
    {:ok, conn} = Postgrex.start_link(Schema.connection_opts(database_url) ++ [pool_size: 10])
    %{conn: conn, amqp_url: amqp_url}
  end

  setup %{conn: conn} do
    uid = :crypto.strong_rand_bytes(6) |> Base.encode16(case: :lower)
    schema = "it_#{uid}"
    Schema.migrate(conn, schema)
    on_exit(fn ->
      {:ok, c} = Postgrex.start_link(Schema.connection_opts(System.get_env("DATABASE_URL")))
      Postgrex.query!(c, "DROP SCHEMA IF EXISTS #{schema} CASCADE", [])
    end)
    %{schema: schema, topology: Topology.for_prefix("it-#{uid}")}
  end

  defp count(conn, schema, table, where \\\\ "true", params \\\\ []) do
    %{rows: [[n]]} = Postgrex.query!(conn, "SELECT count(*) FROM #{schema}.#{table} WHERE #{where}", params)
    n
  end

  defp channel(url) do
    {:ok, connection} = AMQP.Connection.open(url)
    {:ok, chan} = AMQP.Channel.open(connection)
    {connection, chan}
  end

  defp drain_queue(chan, queue) do
    case AMQP.Basic.get(chan, queue, no_ack: true) do
      {:ok, _payload, meta} -> [meta | drain_queue(chan, queue)]
      {:empty, _} -> []
    end
  end

  defp wait_for(fun, deadline \\\\ System.monotonic_time(:millisecond) + 10_000) do
    cond do
      fun.() -> :ok
      System.monotonic_time(:millisecond) > deadline -> flunk("timed out waiting for condition")
      true -> Process.sleep(50) && wait_for(fun, deadline)
    end
  end

  defp request(tenant, id, extra \\\\ %{}), do: Map.merge(%{tenant_id: tenant, aggregate_id: id, command: @command}, extra)

  test "IT1 persists the aggregate and one outbox row atomically; a domain error persists nothing", %{conn: conn, schema: schema} do
    result = CommandService.handle(conn, schema, request("t1", "agg-1"))
    assert {result.status, result.event_type, result.version} == {"created", @event, 1}
    assert CommandService.load(conn, schema, "t1", "agg-1").version == 1
    assert count(conn, schema, "ghk_outbox", "aggregate_id = $1", ["agg-1"]) == 1

    assert_raise CommandService.DomainError, ~r/Unknown command/, fn ->
      CommandService.handle(conn, schema, request("t1", "agg-2", %{command: "no_such_command", idempotency_key: "k-fail"}))
    end

    assert CommandService.load(conn, schema, "t1", "agg-2") == nil
    assert count(conn, schema, "ghk_outbox", "aggregate_id = $1", ["agg-2"]) == 0
    assert count(conn, schema, "ghk_idempotency", "key = $1", ["k-fail"]) == 0
  end

  test "IT2 five concurrent requests with one idempotency key produce one effect and identical responses", %{conn: conn, schema: schema} do
    results =
      1..5
      |> Enum.map(fn _ -> Task.async(fn -> CommandService.handle(conn, schema, request("t1", "agg-1", %{idempotency_key: "key-1"})) end) end)
      |> Task.await_many(30_000)

    assert count(conn, schema, "ghk_outbox") == 1
    assert CommandService.load(conn, schema, "t1", "agg-1").version == 1
    assert Enum.count(results, &(&1.status == "created")) == 1
    assert Enum.uniq(Enum.map(results, &{&1.event_type, &1.version})) == [{@event, 1}]
  end

  test "IT3 two concurrent relays publish every outbox event exactly once", %{conn: conn, schema: schema, topology: t, amqp_url: url} do
    for i <- 0..19, do: CommandService.handle(conn, schema, request("t1", "agg-#{i}"))
    {setup_connection, setup} = channel(url)
    Topology.declare(setup, t)

    totals =
      ["relay-a", "relay-b"]
      |> Enum.map(fn worker ->
        Task.async(fn ->
          {connection, chan} = channel(url)
          :ok = OutboxRelay.prepare(chan)
          total = Stream.repeatedly(fn -> OutboxRelay.publish_batch(conn, chan, t.exchange, schema, worker, 3) end) |> Enum.take_while(&(&1 > 0)) |> Enum.sum()
          AMQP.Connection.close(connection)
          total
        end)
      end)
      |> Task.await_many(60_000)

    assert Enum.sum(totals) == 20
    assert count(conn, schema, "ghk_outbox", "published_at IS NULL") == 0
    wait_for(fn -> AMQP.Queue.message_count(setup, t.queue) == 20 end)
    assert drain_queue(setup, t.queue) |> Enum.map(& &1.message_id) |> Enum.uniq() |> length() == 20
    AMQP.Connection.close(setup_connection)
  end

  test "IT4 tenants cannot read or change each other's aggregates", %{conn: conn, schema: schema} do
    CommandService.handle(conn, schema, request("tenant-a", "shared-id"))
    assert CommandService.load(conn, schema, "tenant-b", "shared-id") == nil
    CommandService.handle(conn, schema, request("tenant-b", "shared-id"))
    assert CommandService.load(conn, schema, "tenant-a", "shared-id").version == 1
    assert CommandService.load(conn, schema, "tenant-b", "shared-id").version == 1
    assert count(conn, schema, "ghk_outbox", "tenant_id = $1", ["tenant-a"]) == 1
  end

  test "IT5 a failing saga step compensates the completed steps in reverse order", %{conn: conn, schema: schema} do
    {:ok, log} = Agent.start_link(fn -> [] end)
    record = fn entry -> Agent.update(log, &(&1 ++ [entry])) end

    step = fn name, fail ->
      %{name: name, action: fn -> if fail, do: raise("#{name} failed"), else: record.("do:#{name}") end, compensate: fn -> record.("undo:#{name}") end}
    end

    assert Saga.run(conn, schema, "saga-1", "t1", [step.("reserve", false), step.("charge", false), step.("ship", true)]) == "COMPENSATED"
    assert Agent.get(log, & &1) == ["do:reserve", "do:charge", "undo:charge", "undo:reserve"]
    assert Saga.status(conn, schema, "saga-1") == %{status: "COMPENSATED", completed_steps: []}
    assert Saga.run(conn, schema, "saga-2", "t1", [step.("reserve", false), step.("charge", false)]) == "COMPLETED"
  end

  test "IT6 a redelivered message is handled once and a failing message is dead-lettered", %{conn: conn, schema: schema, topology: t, amqp_url: url} do
    {connection, chan} = channel(url)
    Topology.declare(chan, t)
    {:ok, handled} = Agent.start_link(fn -> [] end)

    for {id, body} <- [{"m-1", ~s({"ok": true})}, {"m-1", ~s({"ok": true})}, {"m-poison", ~s({"poison": true})}] do
      :ok = AMQP.Basic.publish(chan, t.exchange, "Test", body, message_id: id, headers: [{"tenant_id", :longstr, "t1"}])
    end

    InboxConsumer.drain(conn, chan, t.queue, "it-consumer", schema, fn event, meta ->
      if event["poison"], do: raise("cannot process")
      Agent.update(handled, &(&1 ++ [meta.message_id]))
    end)

    assert Agent.get(handled, & &1) == ["m-1"]
    assert count(conn, schema, "ghk_inbox", "consumer = $1", ["it-consumer"]) == 1
    wait_for(fn -> AMQP.Queue.message_count(chan, t.dlq) == 1 end)
    assert drain_queue(chan, t.dlq) |> Enum.map(& &1.message_id) == ["m-poison"]
    AMQP.Connection.close(connection)
  end

  test "IT7 the incoming trace context flows through command, outbox, publish and consume spans", %{conn: conn, schema: schema, topology: t, amqp_url: url} do
    # The test env uses otel_simple_processor (config/config.exs); route its exports to this process.
    # Restarting the SDK is not an option: tracers are cached with their processors in persistent_term.
    :otel_simple_processor.set_exporter(:otel_exporter_pid, self())
    # set_exporter is asynchronous: wait until a probe span arrives before producing real spans.
    await_exporter()

    CommandService.handle(conn, schema, request("t1", "agg-1", %{traceparent: ${ex(TEST_TRACEPARENT)}}))
    %{rows: [[stored]]} = Postgrex.query!(conn, "SELECT traceparent FROM #{schema}.ghk_outbox", [])
    assert stored =~ ${ex(TEST_TRACE_ID)}

    {connection, chan} = channel(url)
    Topology.declare(chan, t)
    :ok = OutboxRelay.prepare(chan)
    assert OutboxRelay.publish_batch(conn, chan, t.exchange, schema, "relay", 10) == 1
    {:ok, received} = Agent.start_link(fn -> 0 end)
    InboxConsumer.drain(conn, chan, t.queue, "trace-consumer", schema, fn _event, _meta -> Agent.update(received, &(&1 + 1)) end)
    assert Agent.get(received, & &1) == 1
    AMQP.Connection.close(connection)

    hex = fn id, size -> id |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(size, "0") end
    command_name = "${m.pascal}.#{@command}"
    publish_name = "#{t.exchange} publish"
    process_name = "#{t.queue} process"
    assert_receive {:span, span(name: ^command_name, kind: :internal) = command}, 5_000
    assert_receive {:span, span(name: ^publish_name, kind: :producer) = producer}, 5_000
    assert_receive {:span, span(name: ^process_name, kind: :consumer) = consumer}, 5_000
    assert hex.(span(command, :trace_id), 32) == ${ex(TEST_TRACE_ID)}
    assert hex.(span(command, :parent_span_id), 16) == ${ex(TEST_PARENT_SPAN_ID)}
    assert hex.(span(producer, :trace_id), 32) == ${ex(TEST_TRACE_ID)}
    assert hex.(span(consumer, :trace_id), 32) == ${ex(TEST_TRACE_ID)}
    assert span(consumer, :parent_span_id) == span(producer, :span_id)
  end

  defp await_exporter(attempts \\\\ 50) do
    {probe, _} = ${ns}.Telemetry.start_span(:otel_ctx.new(), "exporter-probe", :internal, %{})
    :otel_span.end_span(probe)

    receive do
      {:span, span(name: "exporter-probe")} -> :ok
    after
      100 -> if attempts > 0, do: await_exporter(attempts - 1), else: flunk("span exporter did not start")
    end
  end
end
`;

  return [
    { filename: `${dir}/schema.ex`, content: schema },
    { filename: `${dir}/telemetry.ex`, content: telemetry },
    { filename: `${dir}/command_service.ex`, content: commandService },
    { filename: `${dir}/topology.ex`, content: topologyEx },
    { filename: `${dir}/outbox_relay.ex`, content: relay },
    { filename: `${dir}/inbox_consumer.ex`, content: inbox },
    { filename: `${dir}/saga.ex`, content: saga },
    { filename: `test/${otp}/runtime/integration_test.exs`, content: test }
  ];
}
