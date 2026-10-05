// --------------------------------------------------------------------------
// Transactional Outbox Pattern for Go (pgx)
// Uses PostgreSQL FOR UPDATE SKIP LOCKED for atomic claims
// --------------------------------------------------------------------------

export function generateGoOutboxInfrastructure(packageName: string): { filename: string; content: string }[] {
  const modelsCode = `package ${packageName}

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type OutboxStatus string

const (
	OutboxStatusPending   OutboxStatus = "PENDING"
	OutboxStatusProcessing OutboxStatus = "PROCESSING"
	OutboxStatusPublished OutboxStatus = "PUBLISHED"
	OutboxStatusFailed    OutboxStatus = "FAILED"
)

type OutboxMessage struct {
	ID          uuid.UUID    \`json:"id"\`
	EventType   string       \`json:"event_type"\`
	Payload     string       \`json:"payload"\`
	OccurredOn  time.Time    \`json:"occurred_on"\`
	ProcessedOn *time.Time   \`json:"processed_on"\`
	Status      OutboxStatus \`json:"status"\`
	RetryCount  int          \`json:"retry_count"\`
	Error       *string      \`json:"error"\`
}

type OutboxRepository struct {
	pool *pgxpool.Pool
}

func NewOutboxRepository(pool *pgxpool.Pool) *OutboxRepository {
	return &OutboxRepository{pool: pool}
}

// SaveMessage stores an outbox message within an existing transaction.
// This ensures atomicity with the domain entity changes.
func (r *OutboxRepository) SaveMessage(ctx context.Context, tx pgx.Tx, eventType string, payload interface{}) error {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	query := \`
		INSERT INTO outbox_messages (id, event_type, payload, occurred_on, status, retry_count)
		VALUES ($1, $2, $3, $4, $5, $6)
	\`
	
	_, err = tx.Exec(ctx, query, uuid.New(), eventType, string(payloadBytes), time.Now(), OutboxStatusPending, 0)
	return err
}

// ClaimPendingMessages atomically claims pending messages using SKIP LOCKED.
// This prevents multiple workers from processing the same messages.
func (r *OutboxRepository) ClaimPendingMessages(ctx context.Context, batchSize int) ([]OutboxMessage, error) {
	// Begin transaction for claiming
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// SKIP LOCKED guarantees no blocking and no dual-publish
	query := \`
		UPDATE outbox_messages
		SET status = $1
		WHERE id IN (
			SELECT id FROM outbox_messages
			WHERE status = $2
			ORDER BY occurred_on ASC
			LIMIT $3
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, event_type, payload, occurred_on, processed_on, status, retry_count, error
	\`

	rows, err := tx.Query(ctx, query, OutboxStatusProcessing, OutboxStatusPending, batchSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []OutboxMessage
	for rows.Next() {
		var msg OutboxMessage
		err := rows.Scan(&msg.ID, &msg.EventType, &msg.Payload, &msg.OccurredOn, &msg.ProcessedOn, &msg.Status, &msg.RetryCount, &msg.Error)
		if err != nil {
			return nil, err
		}
		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	return messages, nil
}

func (r *OutboxRepository) MarkPublished(ctx context.Context, id uuid.UUID) error {
	query := \`
		UPDATE outbox_messages
		SET status = $1, processed_on = $2
		WHERE id = $3
	\`
	_, err := r.pool.Exec(ctx, query, OutboxStatusPublished, time.Now(), id)
	return err
}

func (r *OutboxRepository) MarkFailed(ctx context.Context, id uuid.UUID, errorText string) error {
	query := \`
		UPDATE outbox_messages
		SET retry_count = retry_count + 1,
		    error = $1,
		    status = CASE 
		        WHEN retry_count + 1 >= 5 THEN $2::varchar
		        ELSE $3::varchar 
		    END
		WHERE id = $4
	\`
	_, err := r.pool.Exec(ctx, query, errorText, OutboxStatusFailed, OutboxStatusPending, id)
	return err
}
`;

  const workerCode = `package ${packageName}

import (
	"context"
	"log"
	"time"
)

// MessageBroker defines the interface for publishing events to external systems.
type MessageBroker interface {
	Publish(ctx context.Context, eventType string, payload string) error
}

type OutboxWorker struct {
	repo   *OutboxRepository
	broker MessageBroker
}

func NewOutboxWorker(repo *OutboxRepository, broker MessageBroker) *OutboxWorker {
	return &OutboxWorker{
		repo:   repo,
		broker: broker,
	}
}

// Start begins the background processing loop for outbox messages.
func (w *OutboxWorker) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				w.processBatch(ctx)
			}
		}
	}()
}

func (w *OutboxWorker) processBatch(ctx context.Context) {
	// Claim messages atomically (avoids race conditions across instances)
	messages, err := w.repo.ClaimPendingMessages(ctx, 50)
	if err != nil {
		log.Printf("Failed to claim outbox messages: %v", err)
		return
	}

	for _, msg := range messages {
		err := w.broker.Publish(ctx, msg.EventType, msg.Payload)
		if err != nil {
			log.Printf("Failed to publish message %s: %v", msg.ID, err)
			err = w.repo.MarkFailed(ctx, msg.ID, err.Error())
			if err != nil {
				log.Printf("Failed to update outbox message status to FAILED: %v", err)
			}
			continue
		}

		err = w.repo.MarkPublished(ctx, msg.ID)
		if err != nil {
			log.Printf("Failed to update outbox message status to PUBLISHED: %v", err)
		}
	}
}
`;

  return [
    { filename: 'infrastructure/outbox/repository.go', content: modelsCode },
    { filename: 'infrastructure/outbox/worker.go', content: workerCode }
  ];
}
