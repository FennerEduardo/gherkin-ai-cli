/* ==========================================================================
   gherkin-ai-cli - Application layer for Phoenix over the Elixir runtime
   kernel: controller with a JWT tenant, Postgrex pool and outbox relay in
   the supervision tree, and tests. Contract: ./shared.ts.
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';

export interface ExAppFile {
  filename: string;
  content: string;
}

const ex = (s: string) => JSON.stringify(s).replace(/#\{/g, '\\#{');

export function renderPhoenixAppLayer(m: DomainModel, n: { otp: string; mod: string }, claim: string, opts: { liveview?: boolean } = {}): ExAppFile[] {
  const web = `${n.mod}Web`;
  const rt = `${n.mod}.Runtime`;
  const first = m.commands[0];
  const route = commandRoute(m);

  const jwt = `defmodule ${n.mod}.JwtTenant do
  @moduledoc """
  HS256 bearer tokens. The tenant comes only from the ${ex(claim)} claim of a validated token, never from a
  header such as X-Tenant-Id, and there is no default tenant.
  """

  @tenant_claim ${ex(claim)}
  def tenant_claim, do: @tenant_claim

  @doc "Tenant claim of a valid token (signature, exp, nbf checked), else nil."
  def tenant_from(authorization, secret \\\\ System.get_env("JWT_SECRET", ""))

  def tenant_from("Bearer " <> token, secret) when is_binary(secret) and secret != "" do
    with [head, body, sig] <- String.split(String.trim(token), "."),
         {:ok, %{"alg" => "HS256"}} <- decode_json(head),
         {:ok, given} <- Base.url_decode64(sig, padding: false),
         true <- Plug.Crypto.secure_compare(given, :crypto.mac(:hmac, :sha256, secret, head <> "." <> body)),
         {:ok, claims} when is_map(claims) <- decode_json(body),
         true <- valid_time?(claims),
         tenant when is_binary(tenant) <- claims[@tenant_claim],
         false <- String.trim(tenant) == "" do
      tenant
    else
      _ -> nil
    end
  end

  def tenant_from(_authorization, _secret), do: nil

  @doc "Signs an HS256 token (tests and local tooling; production tokens come from your identity provider)."
  def sign(claims, secret) do
    head = Base.url_encode64(~s({"alg":"HS256","typ":"JWT"}), padding: false)
    body = Base.url_encode64(Jason.encode!(claims), padding: false)
    head <> "." <> body <> "." <> Base.url_encode64(:crypto.mac(:hmac, :sha256, secret, head <> "." <> body), padding: false)
  end

  defp decode_json(part) do
    with {:ok, raw} <- Base.url_decode64(part, padding: false), do: Jason.decode(raw)
  end

  defp valid_time?(claims) do
    now = System.os_time(:second)
    not ((is_number(claims["exp"]) and now >= claims["exp"]) or (is_number(claims["nbf"]) and now < claims["nbf"]))
  end
end
`;

  const commands = `defmodule ${n.mod}.Commands do
  @moduledoc "The command port: the runtime kernel's CommandService over the ${n.mod}.DB pool (tests swap it via :command_port)."

  def handle(request), do: impl().handle(request)

  def impl, do: Application.get_env(:${n.otp}, :command_port, __MODULE__.Runtime)

  defmodule Runtime do
    @moduledoc false
    def handle(request), do: ${rt}.CommandService.handle(${n.mod}.DB, "public", request)
  end
end
`;

  const relay = `defmodule ${n.mod}.OutboxRelayWorker do
  @moduledoc "Publishes the outbox every ${RELAY_INTERVAL_MS} ms through the configured broker (Runtime.Broker); reconnects after broker errors."
  use GenServer
  require Logger

  def start_link(_opts), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @impl true
  def init(_) do
    send(self(), :connect)
    {:ok, %{publisher: nil, worker_id: "${m.kebab}-" <> Base.encode16(:crypto.strong_rand_bytes(6), case: :lower)}}
  end

  @impl true
  def handle_info(:connect, state) do
    try do
      broker = ${rt}.Broker.connect()
      # GHK_DECLARE_TOPOLOGY=false when infrastructure as code owns the topology (least-privilege credentials).
      if System.get_env("GHK_DECLARE_TOPOLOGY") != "false", do: :ok = ${rt}.Broker.declare(broker, %${rt}.Topology{})
      send(self(), :tick)
      {:noreply, %{state | publisher: ${rt}.Broker.publisher(broker, %${rt}.Topology{}.exchange)}}
    rescue
      e ->
        Logger.error("outbox relay cannot connect: #{Exception.message(e)}")
        Process.send_after(self(), :connect, 5_000)
        {:noreply, state}
    end
  end

  def handle_info(:tick, %{publisher: publisher} = state) do
    try do
      ${rt}.OutboxRelay.publish_batch(${n.mod}.DB, publisher, "public", state.worker_id)
    rescue
      e -> Logger.error("outbox relay failed: #{Exception.message(e)}")
    end

    Process.send_after(self(), :tick, ${RELAY_INTERVAL_MS})
    {:noreply, state}
  end
end
`;

  const application = `defmodule ${n.mod}.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    database_url = System.get_env("DATABASE_URL")
    # The command service needs DATABASE_URL; the relay also needs a broker (AMQP_URL or PUBSUB_*; off in tests: config :outbox_relay).
    # Children start in order: the kernel's tables exist before the relay and the endpoint start.
    children =
      if(database_url,
        do: [
          {Postgrex, ${rt}.Schema.connection_opts(database_url) ++ [name: ${n.mod}.DB, pool_size: 10]},
          %{id: :ghk_runtime_schema, start: {__MODULE__, :migrate, []}, restart: :temporary}
        ],
        else: []
      ) ++
        if(database_url && ${rt}.Broker.configured?() && Application.get_env(:${n.otp}, :outbox_relay, true), do: [{${n.mod}.OutboxRelayWorker, []}], else: []) ++
        [${web}.Endpoint]

    Supervisor.start_link(children, strategy: :one_for_one, name: ${n.mod}.Supervisor)
  end

  @doc "Creates the runtime kernel's tables (idempotent, serialized across replicas). GHK_MIGRATE=false when a migration job owns them."
  def migrate do
    if System.get_env("GHK_MIGRATE") != "false", do: ${rt}.Schema.migrate(${n.mod}.DB)
    :ignore
  end
end
`;

  const controller = `defmodule ${web}.${m.pascal}Controller do
  @moduledoc "POST ${route}/:id/:command (${m.commands.map(c => c.snake).join(', ')})."
  # ghk:implements ${m.pascal}
  use Phoenix.Controller, formats: [:json]

  alias ${rt}.CommandService.DomainError

  @status %{"created" => :accepted, "replayed" => :ok, "in-progress" => :conflict}

  def health(conn, _params), do: json(conn, %{status: "ok"})

  def execute(conn, %{"id" => id, "command" => command} = params) do
    case ${n.mod}.JwtTenant.tenant_from(conn |> Plug.Conn.get_req_header("authorization") |> List.first()) do
      nil ->
        conn |> put_status(:unauthorized) |> json(%{detail: "A valid bearer token with a tenant is required"})

      tenant ->
        request = %{
          tenant_id: tenant,
          aggregate_type: ${ex(m.pascal)},
          aggregate_id: id,
          command: command,
          payload: Map.drop(params, ["id", "command"]),
          idempotency_key: conn |> Plug.Conn.get_req_header("idempotency-key") |> List.first(),
          traceparent: conn |> Plug.Conn.get_req_header("traceparent") |> List.first()
        }

        try do
          result = ${n.mod}.Commands.handle(request)
          conn |> put_status(Map.get(@status, result.status, :ok)) |> json(result)
        rescue
          e in DomainError -> conn |> put_status(:unprocessable_entity) |> json(%{detail: e.message})
        end
    end
  end
end
`;

  const controllerTest = `defmodule ${web}.${m.pascal}ControllerTest do
  # Not async: the command port and JWT_SECRET are global.
  use ExUnit.Case, async: false
  import Plug.Conn
  import Phoenix.ConnTest

  alias ${n.mod}.JwtTenant

  @endpoint ${web}.Endpoint
  @secret "unit-test-secret-with-at-least-32-chars"

  defmodule FakeCommands do
    def handle(%{command: "does_not_exist"}), do: raise(${rt}.CommandService.DomainError, "Unknown command")

    def handle(request) do
      send(self(), {:handled, request})
      %{status: if(request.idempotency_key == "seen", do: "replayed", else: "created"), aggregate_id: request.aggregate_id, event_type: ${ex(first.event)}, version: 1}
    end
  end

  setup do
    previous = System.get_env("JWT_SECRET")
    System.put_env("JWT_SECRET", @secret)
    Application.put_env(:${n.otp}, :command_port, FakeCommands)

    on_exit(fn ->
      Application.delete_env(:${n.otp}, :command_port)
      if previous, do: System.put_env("JWT_SECRET", previous), else: System.delete_env("JWT_SECRET")
    end)
  end

  defp bearer(claims, secret \\\\ @secret), do: "Bearer " <> JwtTenant.sign(claims, secret)

  defp post_json(headers, path) do
    Enum.reduce(headers, put_req_header(build_conn(), "content-type", "application/json"), fn {k, v}, conn -> put_req_header(conn, k, v) end)
    |> post(path, Jason.encode!(%{source: "api-test"}))
  end

  test "reports health" do
    assert json_response(get(build_conn(), "/health"), 200) == %{"status" => "ok"}
  end

  test "runs a command for the token tenant" do
    conn = post_json([{"authorization", bearer(%{JwtTenant.tenant_claim() => "acme"})}, {"x-tenant-id", "someone-else"}], ${ex(route + '/agg-api/' + first.snake)})
    assert json_response(conn, 202)["status"] == "created"
    assert_received {:handled, %{tenant_id: "acme", command: ${ex(first.snake)}, payload: %{"source" => "api-test"}}}
  end

  test "returns 200 for an idempotent replay" do
    conn = post_json([{"authorization", bearer(%{JwtTenant.tenant_claim() => "acme"})}, {"idempotency-key", "seen"}], ${ex(route + '/agg-api/' + first.snake)})
    assert json_response(conn, 200)
  end

  test "rejects missing or invalid tokens and X-Tenant-Id" do
    for headers <- [[], [{"x-tenant-id", "acme"}], [{"authorization", bearer(%{"sub" => "u1"})}], [{"authorization", bearer(%{JwtTenant.tenant_claim() => "acme"}, "wrong")}]] do
      assert json_response(post_json(headers, ${ex(route + '/agg-api/' + first.snake)}), 401)
    end
  end

  test "maps domain validation errors to 422" do
    conn = post_json([{"authorization", bearer(%{JwtTenant.tenant_claim() => "acme"})}], ${ex(route + '/agg-api/does_not_exist')})
    assert json_response(conn, 422)
  end
end
`;

  const httpTest = `defmodule ${web}.${m.pascal}HttpIntegrationTest do
  @moduledoc "HTTP contract of the application layer against PostgreSQL (needs DATABASE_URL)."
  use ExUnit.Case, async: false
  import Plug.Conn
  import Phoenix.ConnTest

  alias ${n.mod}.JwtTenant

  @moduletag :integration
  @endpoint ${web}.Endpoint
  @secret "integration-test-secret-with-32-chars!"

  setup do
    System.put_env("JWT_SECRET", @secret)
    Application.delete_env(:${n.otp}, :command_port)
    ${rt}.Schema.migrate(${n.mod}.DB)
    on_exit(fn -> System.delete_env("JWT_SECRET") end)
  end

  test "runs a command into the outbox for the token tenant, idempotently" do
    tenant = "tenant-" <> Base.encode16(:crypto.strong_rand_bytes(6), case: :lower)
    id = "agg-" <> Base.encode16(:crypto.strong_rand_bytes(6), case: :lower)
    path = ${ex(route + '/')} <> id <> ${ex('/' + first.snake)}
    send_cmd = fn headers -> Enum.reduce(headers, put_req_header(build_conn(), "content-type", "application/json"), fn {k, v}, c -> put_req_header(c, k, v) end) |> post(path, "{}") end

    assert json_response(send_cmd.([{"x-tenant-id", tenant}]), 401)
    headers = [{"authorization", "Bearer " <> JwtTenant.sign(%{JwtTenant.tenant_claim() => tenant}, @secret)}, {"idempotency-key", id}, {"x-tenant-id", "someone-else"}]
    assert json_response(send_cmd.(headers), 202)
    assert json_response(send_cmd.(headers), 200)["status"] == "replayed"
    assert %{rows: [[^tenant]]} = Postgrex.query!(${n.mod}.DB, "SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = $1", [id])
  end
end
`;

  void opts;
  return [
    { filename: `lib/${n.otp}/jwt_tenant.ex`, content: jwt },
    { filename: `lib/${n.otp}/commands.ex`, content: commands },
    { filename: `lib/${n.otp}/outbox_relay_worker.ex`, content: relay },
    { filename: `lib/${n.otp}/application.ex`, content: application },
    { filename: `lib/${n.otp}_web/controllers/${m.snake}_controller.ex`, content: controller },
    { filename: `test/${n.otp}_web/${m.snake}_controller_test.exs`, content: controllerTest },
    { filename: `test/${n.otp}_web/${m.snake}_http_integration_test.exs`, content: httpTest }
  ];
}
