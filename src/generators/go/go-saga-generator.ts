import { featurePascalName } from '../../utils/naming';
// --------------------------------------------------------------------------
// Saga Orchestration Pattern for Go (pgx)
// PARAMETRIZED: Generates saga based on feature name
// --------------------------------------------------------------------------

export function generateGoSagaInfrastructure(packageName: string, featureName?: string): { filename: string; content: string }[] {
  const feature = featureName
    ? featurePascalName(featureName)
    : 'Payment';
  const featureLower = feature.charAt(0).toLowerCase() + feature.slice(1);
  // Exported (Go visibility) so JSON tags and other packages can use it.
  const entityId = feature + "ID";

  const modelsCode = `package ${packageName}

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type SagaState string

const (
	SagaStateStarted      SagaState = "STARTED"
	SagaStateAuthorized   SagaState = "AUTHORIZED"
	SagaStateCompleting   SagaState = "COMPLETING"
	SagaStateCompleted    SagaState = "COMPLETED"
	SagaStateCompensating SagaState = "COMPENSATING"
	SagaStateFailed       SagaState = "FAILED"
)

type ${feature}SagaInstance struct {
	CorrelationID uuid.UUID \`json:"correlation_id"\`
	${entityId}     uuid.UUID \`json:"${entityId.toLowerCase()}"\`
	CurrentState  SagaState \`json:"current_state"\`
	Metadata      string    \`json:"metadata"\`
	ErrorReason   string    \`json:"error_reason"\`
	CreatedAt     time.Time \`json:"created_at"\`
	UpdatedAt     time.Time \`json:"updated_at"\`
}

type ${feature}SagaRepository struct {
	pool *pgxpool.Pool
}

func New${feature}SagaRepository(pool *pgxpool.Pool) *${feature}SagaRepository {
	return &${feature}SagaRepository{pool: pool}
}

func (r *${feature}SagaRepository) Save(ctx context.Context, saga *${feature}SagaInstance) error {
	query := \`
		INSERT INTO ${featureLower}_sagas (correlation_id, ${entityId.toLowerCase()}, current_state, metadata, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (correlation_id) DO UPDATE SET
		current_state = EXCLUDED.current_state,
		error_reason = EXCLUDED.error_reason,
		updated_at = EXCLUDED.updated_at
	\`
	
	_, err := r.pool.Exec(ctx, query, saga.CorrelationID, saga.${entityId}, saga.CurrentState, saga.Metadata, saga.CreatedAt, saga.UpdatedAt)
	return err
}

func (r *${feature}SagaRepository) Get(ctx context.Context, correlationID uuid.UUID) (*${feature}SagaInstance, error) {
	query := \`
		SELECT correlation_id, ${entityId.toLowerCase()}, current_state, metadata, error_reason, created_at, updated_at
		FROM ${featureLower}_sagas
		WHERE correlation_id = $1
	\`
	
	var saga ${feature}SagaInstance
	err := r.pool.QueryRow(ctx, query, correlationID).Scan(
		&saga.CorrelationID, &saga.${entityId}, &saga.CurrentState, &saga.Metadata, &saga.ErrorReason, &saga.CreatedAt, &saga.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &saga, nil
}
`;

  const orchestratorCode = `package ${packageName}

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
)

// Events
type ${feature}InitiatedEvent struct {
	CorrelationID uuid.UUID
	${entityId}     uuid.UUID
	Metadata      map[string]interface{}
}

type ${feature}AuthorizedEvent struct {
	CorrelationID uuid.UUID
}

type ${feature}CompletedEvent struct {
	CorrelationID uuid.UUID
}

type ${feature}FailedEvent struct {
	CorrelationID uuid.UUID
	Reason        string
}

// Commands
type Authorize${feature}Command struct {
	${entityId} uuid.UUID
	Metadata  map[string]interface{}
}

type Complete${feature}Command struct {
	${entityId} uuid.UUID
}

type Compensate${feature}Command struct {
	${entityId} uuid.UUID
	Reason    string
}

// CommandPublisher dispatches saga commands (bridge it to your broker, ideally through the outbox).
type CommandPublisher interface {
	Publish(ctx context.Context, command string, payload interface{}) error
}

// Orchestrator
type ${feature}SagaOrchestrator struct {
	repo      *${feature}SagaRepository
	publisher CommandPublisher
}

func New${feature}SagaOrchestrator(repo *${feature}SagaRepository, publisher CommandPublisher) *${feature}SagaOrchestrator {
	return &${feature}SagaOrchestrator{
		repo:      repo,
		publisher: publisher,
	}
}

func (o *${feature}SagaOrchestrator) HandleInitiated(ctx context.Context, event ${feature}InitiatedEvent) error {
	log.Printf("Saga initiated: %s", event.CorrelationID)
	
	// Convert metadata map to JSON string
	metaJSON, _ := json.Marshal(event.Metadata)

	saga := &${feature}SagaInstance{
		CorrelationID: event.CorrelationID,
		${entityId}:     event.${entityId},
		CurrentState:  SagaStateStarted,
		Metadata:      string(metaJSON),
		CreatedAt:     time.Now(),
		UpdatedAt:     time.Now(),
	}

	if err := o.repo.Save(ctx, saga); err != nil {
		return err
	}

	return o.publisher.Publish(ctx, "Authorize${feature}Command", Authorize${feature}Command{${entityId}: event.${entityId}, Metadata: event.Metadata})
}

func (o *${feature}SagaOrchestrator) HandleAuthorized(ctx context.Context, event ${feature}AuthorizedEvent) error {
	log.Printf("Saga authorized: %s", event.CorrelationID)

	saga, err := o.repo.Get(ctx, event.CorrelationID)
	if err != nil {
		return err
	}

	saga.CurrentState = SagaStateCompleting
	saga.UpdatedAt = time.Now()

	if err := o.repo.Save(ctx, saga); err != nil {
		return err
	}

	return o.publisher.Publish(ctx, "Complete${feature}Command", Complete${feature}Command{${entityId}: saga.${entityId}})
}

func (o *${feature}SagaOrchestrator) HandleCompleted(ctx context.Context, event ${feature}CompletedEvent) error {
	log.Printf("Saga completed: %s", event.CorrelationID)

	saga, err := o.repo.Get(ctx, event.CorrelationID)
	if err != nil {
		return err
	}

	saga.CurrentState = SagaStateCompleted
	saga.UpdatedAt = time.Now()

	return o.repo.Save(ctx, saga)
}

func (o *${feature}SagaOrchestrator) HandleFailed(ctx context.Context, event ${feature}FailedEvent) error {
	log.Printf("Saga failed: %s, reason: %s", event.CorrelationID, event.Reason)

	saga, err := o.repo.Get(ctx, event.CorrelationID)
	if err != nil {
		return err
	}

	saga.CurrentState = SagaStateCompensating
	saga.ErrorReason = event.Reason
	saga.UpdatedAt = time.Now()

	if err := o.repo.Save(ctx, saga); err != nil {
		return err
	}

	if err := o.publisher.Publish(ctx, "Compensate${feature}Command", Compensate${feature}Command{${entityId}: saga.${entityId}, Reason: event.Reason}); err != nil {
		return err
	}

	saga.CurrentState = SagaStateFailed
	saga.UpdatedAt = time.Now()

	return o.repo.Save(ctx, saga)
}
`;

  return [
    { filename: `sagas/${featureLower}_models.go`, content: modelsCode },
    { filename: `sagas/${featureLower}_orchestrator.go`, content: orchestratorCode }
  ];
}
