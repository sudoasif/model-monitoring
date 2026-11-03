from __future__ import annotations

from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.models import AuditEvent, User
from app.observability import current_request_id
from app.utils import client_ip


def record_audit(
    db: Session,
    *,
    workspace_id: str,
    actor: User | None,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    details: dict[str, Any] | None = None,
    request: Request | None = None,
    commit: bool = False,
) -> AuditEvent:
    event = AuditEvent(
        workspace_id=workspace_id,
        actor_id=actor.id if actor else None,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        details_json=details or {},
        ip_address=client_ip(request) if request else "",
        request_id=current_request_id(),
    )
    db.add(event)
    if commit:
        db.commit()
    return event
