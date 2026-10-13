/* ==========================================================================
   gherkin-ai-cli - Application layer for Go (chi) over the Go runtime
   kernel: router with JWT tenant, server wiring (pgx pool, CommandService,
   outbox relay goroutine) and tests. Contract: ./shared.ts.
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';

export interface GoAppFile {
  filename: string;
  content: string;
}

const goStr = (s: string) => JSON.stringify(s);

export function renderGoAppLayer(m: DomainModel, module: string, claim: string, siblings: DomainModel[] = []): GoAppFile[] {
  const all = [m, ...siblings];
  const first = m.commands[0];
  const route = commandRoute(m);

  const jwt = `package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// TenantClaim is the JWT claim that carries the tenant. The tenant never comes from a header such as
// X-Tenant-Id, and there is no default tenant.
const TenantClaim = ${goStr(claim)}

// TenantFrom returns the tenant claim of a valid HS256 bearer token (signature, exp, nbf checked), or "".
func TenantFrom(authorization, secret string) string {
	if secret == "" || len(authorization) < 7 || !strings.EqualFold(authorization[:7], "Bearer ") {
		return ""
	}
	parts := strings.Split(strings.TrimSpace(authorization[7:]), ".")
	if len(parts) != 3 {
		return ""
	}
	var header struct {
		Alg string \`json:"alg"\`
	}
	if raw, err := base64.RawURLEncoding.DecodeString(parts[0]); err != nil || json.Unmarshal(raw, &header) != nil || header.Alg != "HS256" {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return ""
	}
	var claims map[string]any
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	now := float64(time.Now().Unix())
	if exp, ok := claims["exp"].(float64); ok && now >= exp {
		return ""
	}
	if nbf, ok := claims["nbf"].(float64); ok && now < nbf {
		return ""
	}
	tenant, _ := claims[TenantClaim].(string)
	return strings.TrimSpace(tenant)
}

// SignJWT signs an HS256 token (tests and local tooling; production tokens come from your identity provider).
func SignJWT(claims map[string]any, secret string) string {
	head := base64.RawURLEncoding.EncodeToString([]byte(\`{"alg":"HS256","typ":"JWT"}\`))
	body, _ := json.Marshal(claims)
	payload := head + "." + base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
`;

  const router = `// Package httpapi exposes the runtime kernel's commands over HTTP (chi).
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"${module}/internal/domain"
	"${module}/internal/runtime"
)

// CommandPort is what the HTTP layer needs from the runtime kernel (*runtime.CommandService implements it).
type CommandPort interface {
	Handle(ctx context.Context, req runtime.CommandRequest) (runtime.CommandResult, error)
}

var statusCodes = map[string]int{"created": http.StatusAccepted, "replayed": http.StatusOK, "in-progress": http.StatusConflict}

// NewRouter wires POST ${route}/{id}/{command} (${m.commands.map(c => c.snake).join(', ')}).
// ghk:implements ${m.pascal}
func NewRouter(commands CommandPort, jwtSecret string) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	for path, aggregateType := range map[string]string{${all.map(f => `${goStr(commandRoute(f) + '/{id}/{command}')}: ${goStr(f.pascal)}`).join(', ')}} {
		r.Post(path, commandHandler(commands, jwtSecret, aggregateType))
	}
	return r
}

func commandHandler(commands CommandPort, jwtSecret, aggregateType string) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		tenant := TenantFrom(req.Header.Get("Authorization"), jwtSecret)
		if tenant == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"detail": "A valid bearer token with a tenant is required"})
			return
		}
		var payload map[string]any
		_ = json.NewDecoder(req.Body).Decode(&payload)
		result, err := commands.Handle(req.Context(), runtime.CommandRequest{
			TenantID:       tenant,
			AggregateType:  aggregateType,
			AggregateID:    chi.URLParam(req, "id"),
			Command:        chi.URLParam(req, "command"),
			Payload:        payload,
			IdempotencyKey: req.Header.Get("Idempotency-Key"),
			Traceparent:    req.Header.Get("traceparent"),
		})
		if errors.Is(err, domain.ErrValidation) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"detail": err.Error()})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"detail": "internal error"})
			return
		}
		status, ok := statusCodes[result.Status]
		if !ok {
			status = http.StatusOK
		}
		writeJSON(w, status, result)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
`;

  const routerTest = `package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"${module}/internal/domain"
	"${module}/internal/runtime"
)

const secret = "unit-test-secret-with-at-least-32-chars"

type fakeCommands struct{ last runtime.CommandRequest }

func (f *fakeCommands) Handle(_ context.Context, req runtime.CommandRequest) (runtime.CommandResult, error) {
	f.last = req
	if req.Command == "does_not_exist" {
		return runtime.CommandResult{}, fmt.Errorf("%w: unknown command", domain.ErrValidation)
	}
	status := "created"
	if req.IdempotencyKey == "seen" {
		status = "replayed"
	}
	return runtime.CommandResult{Status: status, AggregateID: req.AggregateID, EventType: ${goStr(first.event)}, Version: 1}, nil
}

func post(h http.Handler, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(\`{"source":"api-test"}\`))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func bearer(claims map[string]any, key string) string { return "Bearer " + SignJWT(claims, key) }

func TestHealth(t *testing.T) {
	rec := httptest.NewRecorder()
	NewRouter(&fakeCommands{}, secret).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestRunsACommandForTheTokenTenant(t *testing.T) {
	fake := &fakeCommands{}
	rec := post(NewRouter(fake, secret), ${goStr(route + '/agg-api/' + first.snake)}, map[string]string{
		"Authorization": bearer(map[string]any{TenantClaim: "acme"}, secret), "X-Tenant-Id": "someone-else"})
	if rec.Code != http.StatusAccepted || fake.last.TenantID != "acme" || fake.last.Payload["source"] != "api-test" {
		t.Fatalf("status %d, request %+v", rec.Code, fake.last)
	}
}

func TestIdempotentReplayReturns200(t *testing.T) {
	rec := post(NewRouter(&fakeCommands{}, secret), ${goStr(route + '/agg-api/' + first.snake)}, map[string]string{
		"Authorization": bearer(map[string]any{TenantClaim: "acme"}, secret), "Idempotency-Key": "seen"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestRejectsMissingOrInvalidTokensAndXTenantID(t *testing.T) {
	h := NewRouter(&fakeCommands{}, secret)
	path := ${goStr(route + '/agg-api/' + first.snake)}
	for _, headers := range []map[string]string{
		{},
		{"X-Tenant-Id": "acme"},
		{"Authorization": bearer(map[string]any{"sub": "u1"}, secret)},
		{"Authorization": bearer(map[string]any{TenantClaim: "acme"}, "wrong")},
	} {
		if rec := post(h, path, headers); rec.Code != http.StatusUnauthorized {
			t.Fatalf("headers %v: status %d", headers, rec.Code)
		}
	}
}

func TestDomainValidationErrorIs422(t *testing.T) {
	rec := post(NewRouter(&fakeCommands{}, secret), ${goStr(route + '/agg-api/does_not_exist')}, map[string]string{
		"Authorization": bearer(map[string]any{TenantClaim: "acme"}, secret)})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status %d", rec.Code)
	}
}
`;

  const main = `package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	amqp "github.com/rabbitmq/amqp091-go"

	"${module}/internal/httpapi"
	"${module}/internal/runtime"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("DATABASE_URL: %v", err)
	}
	defer pool.Close()
	commands, err := runtime.NewCommandService(pool, "public")
	if err != nil {
		log.Fatal(err)
	}
	if url := os.Getenv("AMQP_URL"); url != "" {
		go relayOutbox(ctx, pool, url)
	} else {
		log.Print("AMQP_URL is not set: outbox events are stored but not published")
	}

	server := &http.Server{Addr: ":" + envOr("PORT", "8080"), Handler: httpapi.NewRouter(commands, os.Getenv("JWT_SECRET"))}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// relayOutbox publishes the outbox every ${RELAY_INTERVAL_MS} ms, reconnecting after broker errors.
func relayOutbox(ctx context.Context, pool *pgxpool.Pool, url string) {
	workerID := ${goStr(m.kebab + '-')} + uuid.NewString()
	for ctx.Err() == nil {
		if err := relayUntilError(ctx, pool, url, workerID); err != nil {
			log.Printf("outbox relay: %v (retrying)", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

func relayUntilError(ctx context.Context, pool *pgxpool.Pool, url, workerID string) error {
	conn, err := amqp.Dial(url)
	if err != nil {
		return err
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	if err := runtime.DeclareTopology(ch, runtime.DefaultTopology); err != nil {
		return err
	}
	relay, err := runtime.NewOutboxRelay(pool, ch, runtime.DefaultTopology.Exchange, "public")
	if err != nil {
		return err
	}
	ticker := time.NewTicker(${RELAY_INTERVAL_MS} * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := relay.PublishBatch(ctx, workerID, 50); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
`;

  // External test package of internal/runtime: it may import httpapi (which imports runtime).
  const httpIntegration = `//go:build integration

// HTTP contract of the application layer against PostgreSQL (needs DATABASE_URL).
package runtime_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"${module}/internal/httpapi"
	"${module}/internal/runtime"
)

const httpSecret = "integration-test-secret-with-32-chars!"

func TestHTTPCommandReachesTheOutboxForTheTokenTenant(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := runtime.Migrate(ctx, pool, "public"); err != nil {
		t.Fatal(err)
	}
	commands, err := runtime.NewCommandService(pool, "public")
	if err != nil {
		t.Fatal(err)
	}
	router := httpapi.NewRouter(commands, httpSecret)
	tenant := "tenant-" + uuid.NewString()
	id := uuid.NewString()
	key := uuid.NewString()
	send := func(headers map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, ${goStr(route + '/')}+id+${goStr('/' + first.snake)}, strings.NewReader("{}"))
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	if rec := send(map[string]string{"X-Tenant-Id": tenant}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("X-Tenant-Id alone: status %d", rec.Code)
	}
	headers := map[string]string{"Authorization": "Bearer " + httpapi.SignJWT(map[string]any{httpapi.TenantClaim: tenant}, httpSecret), "Idempotency-Key": key, "X-Tenant-Id": "someone-else"}
	if rec := send(headers); rec.Code != http.StatusAccepted {
		t.Fatalf("first: status %d: %s", rec.Code, rec.Body.String())
	}
	replay := send(headers)
	var body map[string]any
	_ = json.Unmarshal(replay.Body.Bytes(), &body)
	if replay.Code != http.StatusOK || body["status"] != "replayed" {
		t.Fatalf("replay: status %d body %v", replay.Code, body)
	}
	var stored string
	if err := pool.QueryRow(ctx, "SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = $1", id).Scan(&stored); err != nil || stored != tenant {
		t.Fatalf("outbox tenant %q, err %v", stored, err)
	}
}
`;

  return [
    { filename: 'internal/httpapi/jwt.go', content: jwt },
    { filename: 'internal/httpapi/router.go', content: router },
    { filename: 'internal/httpapi/router_test.go', content: routerTest },
    { filename: 'cmd/server/main.go', content: main },
    { filename: 'internal/runtime/http_integration_test.go', content: httpIntegration }
  ];
}
