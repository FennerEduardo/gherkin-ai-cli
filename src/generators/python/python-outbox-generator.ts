// --------------------------------------------------------------------------
// Transactional Outbox Pattern for Python (FastAPI + SQLAlchemy)
// Uses with_for_update(skip_locked=True) for atomic claims
// --------------------------------------------------------------------------

export function generatePythonOutboxInfrastructure(): { filename: string; content: string }[] {
  const modelsCode = `from sqlalchemy import Column, String, DateTime, Text, Integer, Enum
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import enum
import uuid
from app.database import Base

class OutboxStatus(enum.Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    PUBLISHED = "PUBLISHED"
    FAILED = "FAILED"

class OutboxMessage(Base):
    __tablename__ = "outbox_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_type = Column(String(255), nullable=False)
    payload = Column(Text, nullable=False)
    occurred_on = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    processed_on = Column(DateTime(timezone=True), nullable=True)
    status = Column(Enum(OutboxStatus), default=OutboxStatus.PENDING, nullable=False)
    retry_count = Column(Integer, default=0, nullable=False)
    error = Column(Text, nullable=True)
`;

  const serviceCode = `import json
import logging
from sqlalchemy.orm import Session
from datetime import datetime, timezone
from typing import List, Dict, Any
from .models import OutboxMessage, OutboxStatus

logger = logging.getLogger(__name__)

class OutboxService:
    def __init__(self, db_session: Session):
        self.db = db_session

    def save_message(self, event_type: str, payload: Dict[str, Any]):
        """
        Save a message to the outbox.
        Must be called within an active transaction (e.g. FastAPI dependency).
        """
        msg = OutboxMessage(
            event_type=event_type,
            payload=json.dumps(payload),
            status=OutboxStatus.PENDING
        )
        self.db.add(msg)
        # We do NOT commit here. The caller commits the business transaction.

    def claim_pending_messages(self, batch_size: int = 50) -> List[OutboxMessage]:
        """
        Atomically claim pending messages using SKIP LOCKED.
        This prevents multiple workers from processing the same messages.
        """
        # SKIP LOCKED guarantees no blocking and no dual-publish
        query = self.db.query(OutboxMessage).filter(
            OutboxMessage.status == OutboxStatus.PENDING
        ).order_by(OutboxMessage.occurred_on.asc()).limit(batch_size).with_for_update(skip_locked=True)
        
        messages = query.all()
        
        for msg in messages:
            msg.status = OutboxStatus.PROCESSING
            
        if messages:
            self.db.commit()
            
        return messages

    def mark_published(self, msg: OutboxMessage):
        msg.status = OutboxStatus.PUBLISHED
        msg.processed_on = datetime.now(timezone.utc)
        self.db.commit()

    def mark_failed(self, msg: OutboxMessage, error_text: str):
        msg.retry_count += 1
        msg.error = error_text
        if msg.retry_count >= 5:
            msg.status = OutboxStatus.FAILED
        else:
            msg.status = OutboxStatus.PENDING
        self.db.commit()
`;

  const workerCode = `import asyncio
import logging
from sqlalchemy.orm import sessionmaker
from app.database import engine
from .outbox_service import OutboxService
# from .broker import MessageBroker

logger = logging.getLogger(__name__)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

async def process_outbox_loop():
    """
    Background worker loop for processing outbox messages.
    """
    while True:
        try:
            with SessionLocal() as db:
                outbox_svc = OutboxService(db)
                # Atomic claim prevents race conditions between multiple workers
                messages = outbox_svc.claim_pending_messages()
                
                for msg in messages:
                    try:
                        # MessageBroker.publish(msg.event_type, msg.payload)
                        outbox_svc.mark_published(msg)
                    except Exception as e:
                        logger.error(f"Failed to publish message {msg.id}: {str(e)}")
                        outbox_svc.mark_failed(msg, str(e))
                        
        except Exception as e:
            logger.error(f"Error in outbox processor loop: {str(e)}")
            
        await asyncio.sleep(5)
`;

  return [
    { filename: 'infrastructure/outbox/models.py', content: modelsCode },
    { filename: 'infrastructure/outbox/outbox_service.py', content: serviceCode },
    { filename: 'infrastructure/outbox/worker.py', content: workerCode }
  ];
}
