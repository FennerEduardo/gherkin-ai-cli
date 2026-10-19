/* ==========================================================================
   gherkin-ai-cli - Application layer for Rails over the Ruby runtime kernel:
   controller with a JWT tenant, CommandService from DATABASE_URL,
   `rails outbox:relay`, and specs. Contract: ./shared.ts.
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';

export interface RbAppFile {
  filename: string;
  content: string;
}

const rb = (s: string) => JSON.stringify(s);

export function renderRailsAppLayer(m: DomainModel, claim: string, siblings: DomainModel[] = []): RbAppFile[] {
  const first = m.commands[0];
  const route = commandRoute(m);

  const jwt = `# frozen_string_literal: true

require "base64"
require "json"
require "openssl"

# HS256 bearer tokens. The tenant comes only from the ${rb(claim)} claim of a validated token, never from a
# header such as X-Tenant-Id, and there is no default tenant.
module JwtTenant
  TENANT_CLAIM = ${rb(claim)}

  module_function

  # Tenant claim of a valid token (signature, exp, nbf checked), else nil.
  def tenant_from(authorization, secret = ENV.fetch("JWT_SECRET", ""))
    return nil if secret.to_s.empty? || !authorization.to_s.match?(/\\ABearer /i)

    head, body, sig = authorization.to_s[7..].strip.split(".")
    return nil unless head && body && sig
    return nil unless JSON.parse(decode(head))["alg"] == "HS256"

    expected = OpenSSL::HMAC.digest("SHA256", secret, "#{head}.#{body}")
    given = decode(sig)
    return nil unless given.bytesize == expected.bytesize && OpenSSL.fixed_length_secure_compare(given, expected)

    claims = JSON.parse(decode(body))
    now = Time.now.to_i
    return nil if claims["exp"].is_a?(Numeric) && now >= claims["exp"]
    return nil if claims["nbf"].is_a?(Numeric) && now < claims["nbf"]

    tenant = claims[TENANT_CLAIM]
    tenant.is_a?(String) && !tenant.strip.empty? ? tenant : nil
  rescue JSON::ParserError, ArgumentError, NoMethodError
    nil
  end

  # Signs an HS256 token (tests and local tooling; production tokens come from your identity provider).
  def sign(claims, secret)
    head = encode({ alg: "HS256", typ: "JWT" }.to_json)
    body = encode(claims.to_json)
    "#{head}.#{body}.#{encode(OpenSSL::HMAC.digest("SHA256", secret, "#{head}.#{body}"))}"
  end

  def decode(part) = Base64.urlsafe_decode64(part + ("=" * ((4 - (part.length % 4)) % 4)))
  def encode(data) = Base64.urlsafe_encode64(data, padding: false)
end
`;

  const controller = `# frozen_string_literal: true

# POST ${route}/:id/:command (${m.commands.map(c => c.snake).join(', ')}).
# ghk:implements ${m.pascal}
class ${m.pascal}Controller < ApplicationController
  STATUS = { "created" => :accepted, "replayed" => :ok, "in-progress" => :conflict }.freeze

  class << self
    # The runtime kernel's CommandService (DATABASE_URL); tests assign a fake.
    attr_writer :commands

    def commands
      @commands ||= CommandService.new(ENV.fetch("DATABASE_URL"))
    end
  end

  def health
    render json: { status: "ok" }
  end

  def execute
    tenant = JwtTenant.tenant_from(request.headers["Authorization"])
    return render(json: { detail: "A valid bearer token with a tenant is required" }, status: :unauthorized) unless tenant

    payload = params.to_unsafe_h.except("controller", "action", "id", "command", "${m.snake}")
    result = self.class.commands.handle(tenant_id: tenant, aggregate_id: params[:id], command: params[:command], payload: payload,
                                        idempotency_key: request.headers["Idempotency-Key"], traceparent: request.headers["traceparent"],
                                        aggregate_type: ${rb(m.pascal)})
    render json: result.to_h, status: STATUS.fetch(result.status, :ok)
  rescue DomainValidationError => e
    render json: { detail: e.message }, status: :unprocessable_entity
  end
end
`;

  const rake = `# frozen_string_literal: true

namespace :outbox do
  desc "Publish the transactional outbox to the event broker until interrupted (DATABASE_URL; AMQP_URL or PUBSUB_*)"
  task relay: :environment do
    broker = EventBroker.connect
    # GHK_DECLARE_TOPOLOGY=false when infrastructure as code owns the topology (least-privilege credentials).
    broker.declare(RuntimeTopology.default) unless ENV["GHK_DECLARE_TOPOLOGY"] == "false"
    publisher = broker.publisher(RuntimeTopology.default.exchange)
    relay = OutboxRelay.new(ENV.fetch("DATABASE_URL"), publisher)
    worker_id = "${m.kebab}-#{SecureRandom.hex(6)}"
    loop do
      relay.publish_batch(worker_id)
      sleep ${RELAY_INTERVAL_MS / 1000.0}
    end
  ensure
    publisher&.close
    broker&.close
  end
end
`;

  const requestSpec = `# frozen_string_literal: true

RSpec.describe "${m.pascal} API", type: :request do
  secret = "unit-test-secret-with-at-least-32-chars"

  fake = Class.new do
    attr_reader :calls

    def initialize = @calls = []

    def handle(tenant_id:, aggregate_id:, command:, payload: {}, idempotency_key: nil, traceparent: nil, aggregate_type: nil)
      @calls << [tenant_id, aggregate_id, command, payload]
      raise DomainValidationError, "Unknown command #{command}" if command == "does_not_exist"

      CommandService::Result.new(status: idempotency_key == "seen" ? "replayed" : "created", aggregate_id: aggregate_id, event_type: ${rb(first.event)}, version: 1)
    end
  end

  let(:commands) { fake.new }
  let(:bearer) { ->(claims, key = secret) { { "Authorization" => "Bearer #{JwtTenant.sign(claims, key)}" } } }

  around do |example|
    previous = ENV["JWT_SECRET"]
    ENV["JWT_SECRET"] = secret
    ${m.pascal}Controller.commands = commands
    example.run
  ensure
    ENV["JWT_SECRET"] = previous
    ${m.pascal}Controller.commands = nil
  end

  it "reports health" do
    get "/health"
    expect(response).to have_http_status(:ok)
  end

  it "runs a command for the token tenant" do
    post ${rb(route + '/agg-api/' + first.snake)}, params: { source: "api-test" }, as: :json,
                                                   headers: bearer.call({ JwtTenant::TENANT_CLAIM => "acme" }).merge("X-Tenant-Id" => "someone-else")
    expect(response).to have_http_status(:accepted)
    expect(commands.calls.last).to eq(["acme", "agg-api", ${rb(first.snake)}, { "source" => "api-test" }])
  end

  it "returns 200 for an idempotent replay" do
    post ${rb(route + '/agg-api/' + first.snake)}, headers: bearer.call({ JwtTenant::TENANT_CLAIM => "acme" }).merge("Idempotency-Key" => "seen")
    expect(response).to have_http_status(:ok)
  end

  it "rejects missing or invalid tokens and X-Tenant-Id" do
    url = ${rb(route + '/agg-api/' + first.snake)}
    [{}, { "X-Tenant-Id" => "acme" }, bearer.call({ "sub" => "u1" }), bearer.call({ JwtTenant::TENANT_CLAIM => "acme" }, "wrong")].each do |headers|
      post url, headers: headers
      expect(response).to have_http_status(:unauthorized)
    end
  end

  it "maps domain validation errors to 422" do
    post ${rb(route + '/agg-api/does_not_exist')}, headers: bearer.call({ JwtTenant::TENANT_CLAIM => "acme" })
    expect(response).to have_http_status(:unprocessable_entity)
  end
end
`;

  const httpSpec = `# frozen_string_literal: true

# HTTP contract of the application layer against PostgreSQL (needs DATABASE_URL).
RSpec.describe "${m.pascal} HTTP application layer", :integration, type: :request do
  secret = "integration-test-secret-with-32-chars!"

  around do |example|
    previous = ENV["JWT_SECRET"]
    ENV["JWT_SECRET"] = secret
    RuntimeSchema.migrate(ENV.fetch("DATABASE_URL"))
    ${m.pascal}Controller.commands = nil
    example.run
  ensure
    ENV["JWT_SECRET"] = previous
  end

  it "runs a command into the outbox for the token tenant, idempotently" do
    tenant = "tenant-#{SecureRandom.hex(6)}"
    id = "agg-#{SecureRandom.hex(6)}"
    url = "${route}/#{id}/${first.snake}"
    post url, headers: { "X-Tenant-Id" => tenant }
    expect(response).to have_http_status(:unauthorized)

    headers = { "Authorization" => "Bearer #{JwtTenant.sign({ JwtTenant::TENANT_CLAIM => tenant }, secret)}", "Idempotency-Key" => SecureRandom.hex(8), "X-Tenant-Id" => "someone-else" }
    post url, headers: headers
    expect(response).to have_http_status(:accepted)
    post url, headers: headers
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body["status"]).to eq("replayed")

    conn = PG.connect(ENV.fetch("DATABASE_URL"))
    rows = conn.exec_params("SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = $1", [id]).to_a
    conn.close
    expect(rows).to eq([{ "tenant_id" => tenant }])
  end
end
`;

  return [
    { filename: 'app/auth/jwt_tenant.rb', content: jwt },
    { filename: `app/controllers/${m.snake}_controller.rb`, content: controller },
    { filename: 'lib/tasks/outbox.rake', content: rake },
    { filename: `spec/requests/${m.snake}_spec.rb`, content: requestSpec },
    { filename: `spec/integration/${m.snake}_http_spec.rb`, content: httpSpec }
  ];
}
