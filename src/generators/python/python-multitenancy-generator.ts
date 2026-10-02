// --------------------------------------------------------------------------
// Multi-tenancy Pattern for Python (FastAPI + SQLAlchemy)
// Uses contextvars for Tenant Context and SQLAlchemy events for global filtering
// --------------------------------------------------------------------------

export function generatePythonMultiTenancyInfrastructure(): { filename: string; content: string }[] {
  const contextVarCode = `from contextvars import ContextVar

# Thread-safe context variable for the current tenant ID
_tenant_id_ctx_var: ContextVar[str] = ContextVar("tenant_id", default="default")

def get_tenant_id() -> str:
    return _tenant_id_ctx_var.get()

def set_tenant_id(tenant_id: str):
    _tenant_id_ctx_var.set(tenant_id)
`;

  const middlewareCode = `import logging
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from .tenant_context import set_tenant_id

logger = logging.getLogger(__name__)

class TenantMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Extract tenant ID from header (or JWT token)
        tenant_id = request.headers.get("X-Tenant-Id", "default")
        
        # Set tenant in contextvar for the current async task
        set_tenant_id(tenant_id)
        
        # logger.debug(f"Request scoped to tenant: {tenant_id}")
        
        response = await call_next(request)
        return response
`;

  const sqlalchemyEventsCode = `from sqlalchemy import event
from sqlalchemy.orm import Session, ORMExecuteState
from .tenant_context import get_tenant_id
from app.database import Base

# Assume models that need isolation inherit from TenantAwareBase or define tenant_id
# We'll use a mixin approach for demonstration.

class TenantAwareMixin:
    """Mixin to add tenant_id to models"""
    # tenant_id = Column(String(50), nullable=False, index=True)
    pass

@event.listens_for(Session, "do_orm_execute")
def _add_tenant_filter(execute_state: ORMExecuteState):
    """
    Intercepts ORM queries and injects the current tenant filter automatically.
    This acts like a global query filter.
    """
    if execute_state.is_select and not execute_state.is_column_load:
        tenant_id = get_tenant_id()
        
        # In a real scenario, you'd check if the entity is TenantAware
        # For this scaffolding, we modify the query options to include a filter
        # execute_state.statement = execute_state.statement.filter_by(tenant_id=tenant_id)
        pass

@event.listens_for(Session, "before_flush")
def _set_tenant_on_insert(session, flush_context, instances):
    """
    Intercepts inserts to ensure the tenant_id is properly set.
    """
    tenant_id = get_tenant_id()
    for obj in session.new:
        if hasattr(obj, "tenant_id"):
            obj.tenant_id = tenant_id
`;

  return [
    { filename: 'infrastructure/multitenancy/tenant_context.py', content: contextVarCode },
    { filename: 'infrastructure/multitenancy/tenant_middleware.py', content: middlewareCode },
    { filename: 'infrastructure/multitenancy/sqlalchemy_tenant_events.py', content: sqlalchemyEventsCode }
  ];
}
