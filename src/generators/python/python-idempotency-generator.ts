// --------------------------------------------------------------------------
// Idempotency Pattern for Python (FastAPI + SQLAlchemy)
// WITH TTL AND BACKGROUND CLEANUP
// --------------------------------------------------------------------------

export function generatePythonIdempotencyInfrastructure(): { filename: string; content: string }[] {
  const modelsCode = `from sqlalchemy import Column, String, DateTime, Text, Integer, Enum
from sqlalchemy.sql import func
import enum
from .database import Base

class IdempotencyStatus(enum.Enum):
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"

class IdempotencyRecord(Base):
    __tablename__ = "idempotency_keys"

    idempotency_key = Column(String(255), primary_key=True)
    request_path = Column(String(255), nullable=False)
    response_body = Column(Text, nullable=True)
    status_code = Column(Integer, nullable=True)
    status = Column(Enum(IdempotencyStatus), default=IdempotencyStatus.PROCESSING, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
`;

  const middlewareCode = `import json
import logging
from datetime import datetime, timezone, timedelta
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from .models import IdempotencyRecord, IdempotencyStatus
from .database import SessionLocal

logger = logging.getLogger(__name__)
PROCESSING_TTL_MINUTES = 2

class IdempotencyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        idem_key = request.headers.get("X-Idempotency-Key")
        
        if not idem_key or request.method not in ["POST", "PUT", "PATCH"]:
            return await call_next(request)

        # 1. Atomic Check & Insert
        with SessionLocal() as db:
            record = db.query(IdempotencyRecord).filter_by(idempotency_key=idem_key).first()
            
            if record:
                if record.status == IdempotencyStatus.COMPLETED:
                    return Response(
                        content=record.response_body,
                        status_code=record.status_code,
                        media_type="application/json"
                    )
                elif record.status == IdempotencyStatus.PROCESSING:
                    age = datetime.now(timezone.utc) - record.updated_at.replace(tzinfo=timezone.utc)
                    if age.total_seconds() < (PROCESSING_TTL_MINUTES * 60):
                        return Response(
                            content=json.dumps({"error": "Request already in progress. Retry after a moment."}),
                            status_code=409,
                            media_type="application/json"
                        )
                    else:
                        logger.warning(f"Idempotency key {idem_key} stuck in PROCESSING. Allowing retry.")
                        record.status = IdempotencyStatus.PROCESSING
                        record.updated_at = datetime.now(timezone.utc)
                        db.commit()
            else:
                try:
                    new_record = IdempotencyRecord(
                        idempotency_key=idem_key,
                        request_path=request.url.path,
                        status=IdempotencyStatus.PROCESSING
                    )
                    db.add(new_record)
                    db.commit()
                except IntegrityError:
                    db.rollback()
                    return Response(
                        content=json.dumps({"error": "Duplicate concurrent request in progress"}),
                        status_code=409,
                        media_type="application/json"
                    )

        # 2. Execute Request
        try:
            response = await call_next(request)
            
            # Read response body
            body = b""
            async for chunk in response.body_iterator:
                body += chunk
            
            with SessionLocal() as db:
                record = db.query(IdempotencyRecord).filter_by(idempotency_key=idem_key).first()
                if record:
                    record.status = IdempotencyStatus.COMPLETED
                    record.status_code = response.status_code
                    record.response_body = body.decode()
                    record.updated_at = datetime.now(timezone.utc)
                    db.commit()

            # Return a new response with the read body
            return Response(
                content=body,
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=response.media_type
            )
            
        except Exception as e:
            with SessionLocal() as db:
                record = db.query(IdempotencyRecord).filter_by(idempotency_key=idem_key).first()
                if record:
                    record.status = IdempotencyStatus.FAILED
                    record.status_code = 500
                    record.response_body = json.dumps({"error": str(e)})
                    record.updated_at = datetime.now(timezone.utc)
                    db.commit()
            raise e
`;

  const workerCode = `import asyncio
import logging
from datetime import datetime, timezone, timedelta
from sqlalchemy.orm import sessionmaker
from .database import engine
from .models import IdempotencyRecord

logger = logging.getLogger(__name__)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

async def idempotency_cleanup_loop():
    """
    Background worker loop for cleaning up expired idempotency keys (older than 24h).
    """
    while True:
        try:
            with SessionLocal() as db:
                cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
                
                deleted_count = db.query(IdempotencyRecord).filter(
                    IdempotencyRecord.created_at < cutoff
                ).delete()
                
                if deleted_count > 0:
                    db.commit()
                    logger.info(f"Cleaned up {deleted_count} expired idempotency records.")
                    
        except Exception as e:
            logger.error(f"Error in idempotency cleanup loop: {str(e)}")
            
        # Run every hour
        await asyncio.sleep(3600)
`;

  return [
    { filename: 'infrastructure/idempotency/models.py', content: modelsCode },
    { filename: 'infrastructure/idempotency/middleware.py', content: middlewareCode },
    { filename: 'infrastructure/idempotency/worker.py', content: workerCode }
  ];
}
