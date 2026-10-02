// --------------------------------------------------------------------------
// Idempotency Pattern for Go (net/http + pgx)
// WITH TTL AND BACKGROUND CLEANUP
// --------------------------------------------------------------------------

export function generateGoIdempotencyInfrastructure(packageName: string): { filename: string; content: string }[] {
  const modelsCode = `package ${packageName}

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type IdempotencyStatus string

const (
	IdempotencyStatusProcessing IdempotencyStatus = "PROCESSING"
	IdempotencyStatusCompleted  IdempotencyStatus = "COMPLETED"
	IdempotencyStatusFailed     IdempotencyStatus = "FAILED"
)

type IdempotencyRecord struct {
	IdempotencyKey string
	RequestPath    string
	ResponseBody   *string
	StatusCode     *int
	Status         IdempotencyStatus
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type IdempotencyRepository struct {
	pool *pgxpool.Pool
}

func NewIdempotencyRepository(pool *pgxpool.Pool) *IdempotencyRepository {
	return &IdempotencyRepository{pool: pool}
}

// TryInsert Atomically tries to insert a new idempotency key
func (r *IdempotencyRepository) TryInsert(ctx context.Context, key, path string) (bool, error) {
	query := \`
		INSERT INTO idempotency_keys (idempotency_key, request_path, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (idempotency_key) DO NOTHING
	\`
	
	now := time.Now().UTC()
	tag, err := r.pool.Exec(ctx, query, key, path, IdempotencyStatusProcessing, now, now)
	if err != nil {
		return false, err
	}
	
	return tag.RowsAffected() > 0, nil
}

func (r *IdempotencyRepository) Get(ctx context.Context, key string) (*IdempotencyRecord, error) {
	query := \`
		SELECT idempotency_key, request_path, response_body, status_code, status, created_at, updated_at
		FROM idempotency_keys
		WHERE idempotency_key = $1
	\`
	
	var rec IdempotencyRecord
	err := r.pool.QueryRow(ctx, query, key).Scan(
		&rec.IdempotencyKey, &rec.RequestPath, &rec.ResponseBody, &rec.StatusCode, 
		&rec.Status, &rec.CreatedAt, &rec.UpdatedAt,
	)
	
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

func (r *IdempotencyRepository) Update(ctx context.Context, rec *IdempotencyRecord) error {
	query := \`
		UPDATE idempotency_keys
		SET response_body = $1, status_code = $2, status = $3, updated_at = $4
		WHERE idempotency_key = $5
	\`
	
	_, err := r.pool.Exec(ctx, query, rec.ResponseBody, rec.StatusCode, rec.Status, time.Now().UTC(), rec.IdempotencyKey)
	return err
}

func (r *IdempotencyRepository) DeleteExpired(ctx context.Context, cutoff time.Time) (int64, error) {
	query := "DELETE FROM idempotency_keys WHERE created_at < $1"
	tag, err := r.pool.Exec(ctx, query, cutoff)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
`;

  const middlewareCode = `package ${packageName}

import (
	"bytes"
	"log"
	"net/http"
	"time"
)

const ProcessingTTL = 2 * time.Minute

// responseRecorder is a custom http.ResponseWriter to capture the body and status code
type responseRecorder struct {
	http.ResponseWriter
	statusCode int
	body       *bytes.Buffer
}

func (rec *responseRecorder) WriteHeader(statusCode int) {
	rec.statusCode = statusCode
	rec.ResponseWriter.WriteHeader(statusCode)
}

func (rec *responseRecorder) Write(b []byte) (int, error) {
	rec.body.Write(b)
	return rec.ResponseWriter.Write(b)
}

func IdempotencyMiddleware(repo *IdempotencyRepository) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.Header.Get("X-Idempotency-Key")

			if key == "" || (r.Method != http.MethodPost && r.Method != http.MethodPut && r.Method != http.MethodPatch) {
				next.ServeHTTP(w, r)
				return
			}

			ctx := r.Context()
			inserted, err := repo.TryInsert(ctx, key, r.URL.Path)
			if err != nil {
				http.Error(w, \`{"error": "Internal server error"}\`, http.StatusInternalServerError)
				return
			}

			if !inserted {
				// Key already exists, check status
				record, err := repo.Get(ctx, key)
				if err != nil || record == nil {
					http.Error(w, \`{"error": "Internal server error"}\`, http.StatusInternalServerError)
					return
				}

				if record.Status == IdempotencyStatusCompleted {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(*record.StatusCode)
					if record.ResponseBody != nil {
						w.Write([]byte(*record.ResponseBody))
					}
					return
				}

				if record.Status == IdempotencyStatusProcessing {
					if time.Since(record.UpdatedAt) < ProcessingTTL {
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(http.StatusConflict)
						w.Write([]byte(\`{"error": "Request already in progress. Retry after a moment."}\`))
						return
					}
					log.Printf("Idempotency key %s stuck in PROCESSING. Allowing retry.", key)
					record.Status = IdempotencyStatusProcessing
					repo.Update(ctx, record)
					// Proceed to process the retry
				}
			}

			// Capture response
			recorder := &responseRecorder{
				ResponseWriter: w,
				statusCode:     http.StatusOK, // Default if WriteHeader is not called
				body:           new(bytes.Buffer),
			}

			// Process Request
			defer func() {
				if r := recover(); r != nil {
					// Handle Panic
					log.Printf("Panic during request processing: %v", r)
					errResp := \`{"error": "Internal server error"}\`
					statusCode := http.StatusInternalServerError
					repo.Update(ctx, &IdempotencyRecord{
						IdempotencyKey: key,
						ResponseBody:   &errResp,
						StatusCode:     &statusCode,
						Status:         IdempotencyStatusFailed,
					})
					panic(r)
				}
			}()

			next.ServeHTTP(recorder, r)

			// Save Result
			bodyStr := recorder.body.String()
			repo.Update(ctx, &IdempotencyRecord{
				IdempotencyKey: key,
				ResponseBody:   &bodyStr,
				StatusCode:     &recorder.statusCode,
				Status:         IdempotencyStatusCompleted,
			})
		})
	}
}
`;

  const workerCode = `package ${packageName}

import (
	"context"
	"log"
	"time"
)

type IdempotencyCleanupWorker struct {
	repo *IdempotencyRepository
}

func NewIdempotencyCleanupWorker(repo *IdempotencyRepository) *IdempotencyCleanupWorker {
	return &IdempotencyCleanupWorker{repo: repo}
}

// Start runs a background loop to clean up expired idempotency keys (older than 24h).
func (w *IdempotencyCleanupWorker) Start(ctx context.Context) {
	go func() {
		// Run every hour
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				cutoff := time.Now().UTC().Add(-24 * time.Hour)
				deleted, err := w.repo.DeleteExpired(ctx, cutoff)
				if err != nil {
					log.Printf("Error cleaning up idempotency keys: %v", err)
				} else if deleted > 0 {
					log.Printf("Cleaned up %d expired idempotency records.", deleted)
				}
			}
		}
	}()
}
`;

  return [
    { filename: 'infrastructure/idempotency/repository.go', content: modelsCode },
    { filename: 'infrastructure/idempotency/middleware.go', content: middlewareCode },
    { filename: 'infrastructure/idempotency/worker.go', content: workerCode }
  ];
}
