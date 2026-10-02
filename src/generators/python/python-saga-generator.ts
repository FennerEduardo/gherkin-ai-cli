import { featurePascalName } from '../../utils/naming';
// --------------------------------------------------------------------------
// Saga Orchestration Pattern for Python (FastAPI + SQLAlchemy)
// PARAMETRIZED: Generates saga based on feature name
// --------------------------------------------------------------------------

export function generatePythonSagaInfrastructure(featureName?: string): { filename: string; content: string }[] {
  const feature = featureName
    ? featurePascalName(featureName)
    : 'Payment';
  const featureLower = feature.charAt(0).toLowerCase() + feature.slice(1);
  const entityId = featureLower + '_id';

  const modelsCode = `from sqlalchemy import Column, String, DateTime, Text, Enum
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import enum
import uuid
from app.database import Base

class SagaState(enum.Enum):
    STARTED = "STARTED"
    AUTHORIZED = "AUTHORIZED"
    COMPLETING = "COMPLETING"
    COMPLETED = "COMPLETED"
    COMPENSATING = "COMPENSATING"
    FAILED = "FAILED"

class ${feature}SagaInstance(Base):
    __tablename__ = "${featureLower}_saga_instances"

    correlation_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ${entityId} = Column(UUID(as_uuid=True), nullable=False)
    current_state = Column(Enum(SagaState), default=SagaState.STARTED, nullable=False)
    metadata_json = Column(Text, nullable=True)
    error_reason = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
`;

  const orchestratorCode = `import logging
from uuid import UUID
from sqlalchemy.orm import Session
from app.infrastructure.event_bus import event_bus
from .${featureLower}_models import ${feature}SagaInstance, SagaState

logger = logging.getLogger(__name__)

class ${feature}SagaOrchestrator:
    def __init__(self, db_session: Session):
        self.db = db_session

    def handle_initiated(self, correlation_id: UUID, ${entityId}: UUID, meta: dict):
        logger.info(f"Saga initiated: {correlation_id}")
        
        saga = ${feature}SagaInstance(
            correlation_id=correlation_id,
            ${entityId}=${entityId},
            current_state=SagaState.STARTED,
            metadata_json=str(meta)
        )
        self.db.add(saga)
        self.db.commit()

        # Commands are dispatched in-process; bridge them to your broker (e.g. via the outbox) as needed.
        event_bus.publish("Authorize${feature}Command", {"${entityId}": str(${entityId})})

    def handle_authorized(self, correlation_id: UUID):
        logger.info(f"Saga authorized: {correlation_id}")
        
        saga = self.db.query(${feature}SagaInstance).filter_by(correlation_id=correlation_id).with_for_update().first()
        if not saga:
            raise ValueError(f"Saga not found: {correlation_id}")
            
        saga.current_state = SagaState.COMPLETING
        self.db.commit()

        event_bus.publish("Complete${feature}Command", {"${entityId}": str(saga.${entityId})})

    def handle_completed(self, correlation_id: UUID):
        logger.info(f"Saga completed: {correlation_id}")
        
        saga = self.db.query(${feature}SagaInstance).filter_by(correlation_id=correlation_id).with_for_update().first()
        if not saga:
            raise ValueError(f"Saga not found: {correlation_id}")
            
        saga.current_state = SagaState.COMPLETED
        self.db.commit()

    def handle_failed(self, correlation_id: UUID, reason: str):
        logger.warning(f"Saga failed: {correlation_id}, reason: {reason}")
        
        saga = self.db.query(${feature}SagaInstance).filter_by(correlation_id=correlation_id).with_for_update().first()
        if not saga:
            raise ValueError(f"Saga not found: {correlation_id}")
            
        saga.current_state = SagaState.COMPENSATING
        saga.error_reason = reason
        self.db.commit()

        event_bus.publish("Compensate${feature}Command", {"${entityId}": str(saga.${entityId}), "reason": reason})

        saga.current_state = SagaState.FAILED
        self.db.commit()
`;

  return [
    { filename: `sagas/${featureLower}_models.py`, content: modelsCode },
    { filename: `sagas/${featureLower}_orchestrator.py`, content: orchestratorCode }
  ];
}
