/* ==========================================================================
   gherkin-ai-cli - Application layer for Axum over the Rust runtime kernel:
   router with a JWT tenant and a command port, server wiring (sqlx pool,
   CommandService, outbox relay task) and tests. Contract: ./shared.ts.
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';

export interface RsAppFile {
  filename: string;
  content: string;
}

const rsStr = (s: string) => JSON.stringify(s);

/** Extra crates the application layer needs (JWT verification). */
export const RS_APP_DEPS = `base64 = "0.22"
hmac = "0.12"
sha2 = "0.10"`;

export function renderAxumAppLayer(m: DomainModel, crate: string, claim: string, siblings: DomainModel[] = []): RsAppFile[] {
  const all = [m, ...siblings];
  const first = m.commands[0];
  const route = commandRoute(m);

  const api = `//! HTTP API (Axum): POST ${route}/:id/:command (${m.commands.map(c => c.snake).join(', ')}).
//! The tenant comes only from the validated bearer token (claim ${rsStr(claim)}), never from a header such
//! as X-Tenant-Id, and there is no default tenant.
// ghk:implements ${m.pascal}
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::runtime::{CommandRequest, CommandResult, CommandService, RuntimeError};

pub const TENANT_CLAIM: &str = ${rsStr(claim)};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the HTTP layer needs from the runtime kernel (CommandService implements it; tests use a fake).
pub trait CommandPort: Send + Sync {
    fn handle(&self, req: CommandRequest) -> BoxFuture<'_, Result<CommandResult, RuntimeError>>;
}

impl CommandPort for CommandService {
    fn handle(&self, req: CommandRequest) -> BoxFuture<'_, Result<CommandResult, RuntimeError>> {
        Box::pin(CommandService::handle(self, req))
    }
}

#[derive(Clone)]
struct AppState {
    commands: Arc<dyn CommandPort>,
    jwt_secret: Arc<String>,
}

/// Routes of every feature of the service (each names its aggregate type).
const ROUTES: &[(&str, &str)] = &[${all.map(f => `(${rsStr(commandRoute(f) + '/:id/:command')}, ${rsStr(f.pascal)})`).join(', ')}];

pub fn router(commands: Arc<dyn CommandPort>, jwt_secret: impl Into<String>) -> Router {
    let mut router = Router::new().route("/health", get(|| async { Json(json!({ "status": "ok" })) }));
    for &(path, aggregate_type) in ROUTES {
        router = router.route(
            path,
            post(move |state: State<AppState>, params: Path<(String, String)>, headers: HeaderMap, body: Option<Json<Value>>| {
                execute(state, aggregate_type, params, headers, body)
            }),
        );
    }
    router.with_state(AppState { commands, jwt_secret: Arc::new(jwt_secret.into()) })
}

async fn execute(
    State(state): State<AppState>,
    aggregate_type: &'static str,
    Path((id, command)): Path<(String, String)>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> (StatusCode, Json<Value>) {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let Some(tenant) = tenant_from(header("authorization").as_deref(), &state.jwt_secret) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "detail": "A valid bearer token with a tenant is required" })));
    };
    let payload: HashMap<String, Value> = body.and_then(|Json(v)| v.as_object().cloned()).map(|m| m.into_iter().collect()).unwrap_or_default();
    let req = CommandRequest {
        tenant_id: tenant,
        aggregate_type: Some(aggregate_type.to_string()),
        aggregate_id: id,
        command,
        payload,
        idempotency_key: header("idempotency-key"),
        traceparent: header("traceparent"),
    };
    match state.commands.handle(req).await {
        Ok(result) => {
            let status = match result.status.as_str() {
                "created" => StatusCode::ACCEPTED,
                "in-progress" => StatusCode::CONFLICT,
                _ => StatusCode::OK,
            };
            (status, Json(serde_json::to_value(result).unwrap_or(Value::Null)))
        }
        Err(RuntimeError::Validation(detail)) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "detail": detail }))),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "detail": "internal error" }))),
    }
}

/// Tenant claim of a valid HS256 bearer token (signature, exp, nbf checked).
pub fn tenant_from(authorization: Option<&str>, secret: &str) -> Option<String> {
    let token = authorization?.strip_prefix("Bearer ").or_else(|| authorization?.strip_prefix("bearer "))?.trim();
    if secret.is_empty() {
        return None;
    }
    let mut parts = token.split('.');
    let (head, body, sig) = (parts.next()?, parts.next()?, parts.next()?);
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(head).ok()?).ok()?;
    if header["alg"] != "HS256" {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(format!("{head}.{body}").as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(sig).ok()?).ok()?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64();
    if claims["exp"].as_f64().is_some_and(|exp| now >= exp) || claims["nbf"].as_f64().is_some_and(|nbf| now < nbf) {
        return None;
    }
    claims[TENANT_CLAIM].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string)
}

/// Signs an HS256 token (tests and local tooling; production tokens come from your identity provider).
pub fn sign_jwt(claims: &Value, secret: &str) -> String {
    let head = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(claims.to_string());
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(format!("{head}.{body}").as_bytes());
    format!("{head}.{body}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}
`;

  const main = `use std::sync::Arc;
use std::time::Duration;

use ${crate}::runtime::{declare_topology, CommandService, OutboxRelay, Topology};

#[tokio::main]
async fn main() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL (postgres://user:password@host:5432/db)");
    let pool = sqlx::PgPool::connect(&database_url).await.expect("database");
    let commands = CommandService::new(pool.clone(), "public").expect("command service");
    if let Ok(amqp_url) = std::env::var("AMQP_URL") {
        tokio::spawn(relay_outbox(pool.clone(), amqp_url));
    } else {
        eprintln!("AMQP_URL is not set: outbox events are stored but not published");
    }

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.expect("bind");
    println!("listening on :{port}");
    let app = ${crate}::api::router(Arc::new(commands), std::env::var("JWT_SECRET").unwrap_or_default());
    axum::serve(listener, app).await.expect("server");
}

/// Publishes the outbox every ${RELAY_INTERVAL_MS} ms, reconnecting after broker errors.
async fn relay_outbox(pool: sqlx::PgPool, amqp_url: String) {
    let worker_id = format!("${m.kebab}-{}", uuid::Uuid::new_v4());
    loop {
        if let Err(e) = relay_until_error(&pool, &amqp_url, &worker_id).await {
            eprintln!("outbox relay: {e} (retrying)");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn relay_until_error(pool: &sqlx::PgPool, amqp_url: &str, worker_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let connection = lapin::Connection::connect(amqp_url, lapin::ConnectionProperties::default()).await?;
    let channel = connection.create_channel().await?;
    let topology = Topology::default();
    declare_topology(&channel, &topology).await?;
    let relay = OutboxRelay::new(pool.clone(), channel, &topology.exchange, "public").await?;
    loop {
        relay.publish_batch(worker_id, 50).await?;
        tokio::time::sleep(Duration::from_millis(${RELAY_INTERVAL_MS})).await;
    }
}
`;

  const apiTest = `use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use ${crate}::api::{router, sign_jwt, CommandPort, TENANT_CLAIM};
use ${crate}::runtime::{CommandRequest, CommandResult, RuntimeError};

const SECRET: &str = "unit-test-secret-with-at-least-32-chars";

#[derive(Default)]
struct FakeCommands {
    calls: Mutex<Vec<CommandRequest>>,
}

impl CommandPort for FakeCommands {
    fn handle(&self, req: CommandRequest) -> Pin<Box<dyn Future<Output = Result<CommandResult, RuntimeError>> + Send + '_>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(req.clone());
            if req.command == "does_not_exist" {
                return Err(RuntimeError::Validation("unknown command".into()));
            }
            let status = if req.idempotency_key.as_deref() == Some("seen") { "replayed" } else { "created" };
            Ok(CommandResult { status: status.into(), aggregate_id: req.aggregate_id, event_type: Some(${rsStr(first.event)}.into()), version: Some(1) })
        })
    }
}

async fn call(fake: Arc<FakeCommands>, uri: &str, headers: &[(&str, String)]) -> (StatusCode, Value) {
    let mut req = Request::builder().method("POST").uri(uri).header("content-type", "application/json");
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let res = router(fake, SECRET).oneshot(req.body(Body::from(r#"{"source":"api-test"}"#)).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn bearer(claims: Value, secret: &str) -> String {
    format!("Bearer {}", sign_jwt(&claims, secret))
}

#[tokio::test]
async fn reports_health() {
    let req = Request::builder().uri("/health").body(Body::empty()).unwrap();
    let res = router(Arc::new(FakeCommands::default()), SECRET).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn runs_a_command_for_the_token_tenant() {
    let fake = Arc::new(FakeCommands::default());
    let (status, body) = call(fake.clone(), ${rsStr(route + '/agg-api/' + first.snake)},
        &[("authorization", bearer(json!({ TENANT_CLAIM: "acme" }), SECRET)), ("x-tenant-id", "someone-else".into())]).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body["status"], "created");
    let last = fake.calls.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.tenant_id, "acme");
    assert_eq!(last.payload["source"], "api-test");
}

#[tokio::test]
async fn idempotent_replay_returns_200() {
    let (status, _) = call(Arc::new(FakeCommands::default()), ${rsStr(route + '/agg-api/' + first.snake)},
        &[("authorization", bearer(json!({ TENANT_CLAIM: "acme" }), SECRET)), ("idempotency-key", "seen".into())]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn rejects_missing_or_invalid_tokens_and_x_tenant_id() {
    for headers in [
        vec![],
        vec![("x-tenant-id", "acme".to_string())],
        vec![("authorization", bearer(json!({ "sub": "u1" }), SECRET))],
        vec![("authorization", bearer(json!({ TENANT_CLAIM: "acme" }), "wrong"))],
    ] {
        let (status, _) = call(Arc::new(FakeCommands::default()), ${rsStr(route + '/agg-api/' + first.snake)}, &headers).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn domain_validation_error_is_422() {
    let (status, _) = call(Arc::new(FakeCommands::default()), ${rsStr(route + '/agg-api/does_not_exist')},
        &[("authorization", bearer(json!({ TENANT_CLAIM: "acme" }), SECRET))]).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}
`;

  const httpIntegration = `#![cfg(feature = "integration")]
//! HTTP contract of the application layer against PostgreSQL (needs DATABASE_URL).
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use ${crate}::api::{router, sign_jwt, TENANT_CLAIM};
use ${crate}::runtime::{migrate, CommandService};

const SECRET: &str = "integration-test-secret-with-32-chars!";

#[tokio::test]
async fn http_command_reaches_the_outbox_for_the_token_tenant() {
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").expect("DATABASE_URL")).await.unwrap();
    migrate(&pool, "public").await.unwrap();
    let app = router(Arc::new(CommandService::new(pool.clone(), "public").unwrap()), SECRET);
    let tenant = format!("tenant-{}", uuid::Uuid::new_v4());
    let id = uuid::Uuid::new_v4().to_string();
    let uri = format!("${route}/{id}/${first.snake}");
    let send = |headers: Vec<(&'static str, String)>| {
        let app = app.clone();
        let uri = uri.clone();
        async move {
            let mut req = Request::builder().method("POST").uri(uri).header("content-type", "application/json");
            for (k, v) in headers {
                req = req.header(k, v);
            }
            let res = app.oneshot(req.body(Body::from("{}")).unwrap()).await.unwrap();
            let status = res.status();
            let bytes = res.into_body().collect().await.unwrap().to_bytes();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null))
        }
    };

    assert_eq!(send(vec![("x-tenant-id", tenant.clone())]).await.0, StatusCode::UNAUTHORIZED);
    let headers = vec![
        ("authorization", format!("Bearer {}", sign_jwt(&json!({ TENANT_CLAIM: tenant }), SECRET))),
        ("idempotency-key", uuid::Uuid::new_v4().to_string()),
        ("x-tenant-id", "someone-else".to_string()),
    ];
    assert_eq!(send(headers.clone()).await.0, StatusCode::ACCEPTED);
    let (status, body) = send(headers).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "replayed");

    let stored: (String,) = sqlx::query_as("SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = $1").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(stored.0, tenant);
}
`;

  return [
    { filename: 'src/api.rs', content: api },
    { filename: 'src/main.rs', content: main },
    { filename: 'tests/api.rs', content: apiTest },
    { filename: 'tests/http_integration.rs', content: httpIntegration }
  ];
}
