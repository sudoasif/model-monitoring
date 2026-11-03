from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import WorkspaceContext, get_workspace_context, require_workspace_admin
from app.models import (
    Alert,
    AlertRule,
    AuditEvent,
    Dataset,
    Deployment,
    Incident,
    ModelVersion,
    PipelineJob,
    PredictionEvent,
    Project,
    RegisteredModel,
    TrainingRun,
    User,
    Workspace,
    WorkspaceMember,
)
from app.schemas import NotificationTestRequest
from app.services.alerts import test_notification
from app.services.audit import record_audit
from app.services.mlflow_tracker import tracker
from app.services.serializers import serialize_audit
from app.services.storage import storage

router = APIRouter(tags=["settings"])


def _safe_uri(uri: str) -> str:
    """Remove userinfo from a database/tracking URI before returning it."""
    try:
        parts = urlsplit(uri)
        if parts.password or parts.username:
            netloc = parts.hostname or ""
            if parts.port:
                netloc += f":{parts.port}"
            return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
        return uri
    except Exception:
        return "<configured>"


@router.get("/settings")
def get_settings(
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    project_count = int(
        db.scalar(select(func.count(Project.id)).where(Project.workspace_id == ctx.workspace.id)) or 0
    )
    member_count = int(
        db.scalar(select(func.count(User.id))) or 0
    )
    return {
        "workspace": {
            "id": ctx.workspace.id,
            "name": ctx.workspace.name,
            "slug": ctx.workspace.slug,
            "role": ctx.role,
            "settings": ctx.workspace.settings_json or {},
            "project_count": project_count,
        },
        "user": {
            "id": ctx.user.id,
            "email": ctx.user.email,
            "full_name": ctx.user.full_name,
            "system_role": ctx.user.role,
            "workspace_role": ctx.role,
            "is_workspace_admin": ctx.is_admin,
        },
        "platform": {
            "environment": settings.environment,
            "demo_mode": settings.demo_mode,
            "job_runner": settings.job_runner,
            "storage_backend": settings.storage_backend,
            "scheduler_enabled": settings.scheduler_enabled,
            "otel_enabled": settings.otel_enabled,
            "retention_days": settings.retention_days,
            "feature_sample_retention_days": settings.feature_sample_retention_days,
        },
        "mlflow": {
            "enabled": settings.mlflow_enabled,
            "registry_enabled": settings.mlflow_registry_enabled,
            "ui_url": settings.mlflow_ui_url or None,
            "tracking_uri": _safe_uri(settings.mlflow_tracking_uri),
            "artifact_root": _safe_uri(settings.mlflow_artifact_root),
            "mode": "remote" if settings.mlflow_tracking_uri.startswith(("http://", "https://")) else "local",
        },
        "limits": {
            "max_upload_mb": round(settings.max_upload_bytes / (1024 * 1024), 1),
            "max_dataset_rows": settings.max_dataset_rows,
            "max_dataset_columns": settings.max_dataset_columns,
            "max_batch_size": settings.max_batch_size,
            "max_prediction_body_kb": round(settings.max_prediction_body_bytes / 1024, 1),
            "rate_limit_predict_per_minute": settings.rate_limit_predict_per_minute,
            "rate_limit_api_per_minute": settings.rate_limit_api_per_minute,
        },
        "monitoring": {
            "drift_engine": settings.drift_engine,
            "drift_alpha": settings.drift_alpha,
            "drift_psi_threshold": settings.drift_psi_threshold,
            "drift_share_threshold": settings.drift_share_threshold,
            "min_drift_samples": settings.min_drift_samples,
            "default_min_label_samples": settings.default_min_label_samples,
            "performance_degradation_threshold": settings.performance_degradation_threshold,
            "capture_monitoring_samples": settings.capture_monitoring_samples,
            "monitoring_sample_rate": settings.monitoring_sample_rate,
            "raw_input_logging": settings.log_raw_prediction_input,
        },
        "notifications": {
            "email_configured": bool(settings.smtp_host and settings.alert_email_to),
            "smtp_host_configured": bool(settings.smtp_host),
            "recipients_configured": bool(settings.alert_email_to),
            "slack_configured": bool(settings.slack_webhook_url),
            "channels": ["in_app"]
            + (["email"] if settings.smtp_host and settings.alert_email_to else [])
            + (["slack"] if settings.slack_webhook_url else []),
        },
        "security": {
            "access_token_minutes": settings.access_token_minutes,
            "refresh_token_days": settings.refresh_token_days,
            "cookie_secure": settings.cookie_secure,
            "cors_origins": settings.cors_origin_list,
            "total_system_users": member_count if ctx.user.role == "admin" else None,
        },
        "features": [
            {"key": "experiment_tracking", "enabled": settings.mlflow_enabled},
            {"key": "model_registry", "enabled": settings.mlflow_registry_enabled},
            {"key": "drift_detection", "enabled": True},
            {"key": "explainability", "enabled": True},
            {"key": "email_alerts", "enabled": bool(settings.smtp_host and settings.alert_email_to)},
            {"key": "slack_alerts", "enabled": bool(settings.slack_webhook_url)},
            {"key": "demo_mode", "enabled": settings.demo_mode},
        ],
        "documentation": {
            "note": (
                "All values are derived from server configuration. Secrets are never returned. "
                "Operational limits are enforced by the API, not only displayed here."
            )
        },
    }


@router.get("/settings/mlflow")
def mlflow_status(
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> dict[str, Any]:
    health = tracker.health()
    health.pop("tracking_uri", None)
    return {
        **health,
        "ui_url": settings.mlflow_ui_url or None,
        "registry_enabled": settings.mlflow_registry_enabled,
        "tracking_uri": _safe_uri(settings.mlflow_tracking_uri),
    }


@router.post("/settings/notifications/test")
def test_notification_channel(
    payload: NotificationTestRequest,
    request: Request,
    ctx: WorkspaceContext = Depends(require_workspace_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    result = test_notification(payload.channel)
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=ctx.user,
        action="notification.test_sent",
        entity_type="workspace",
        entity_id=ctx.workspace.id,
        details={"channel": payload.channel, "status": result.get("status")},
        request=request,
    )
    db.commit()
    return {
        "channel": payload.channel,
        "result": result,
        "note": (
            "Test delivery is recorded in the audit log. A skipped result means the channel is not configured; "
            "no notification was sent."
        ),
    }


@router.get("/audit-events", response_model=dict[str, Any])
def list_audit_events(
    action: str | None = Query(default=None, max_length=80),
    entity_type: str | None = Query(default=None, max_length=60),
    actor_id: str | None = None,
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: WorkspaceContext = Depends(require_workspace_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = [AuditEvent.workspace_id == ctx.workspace.id]
    if action:
        filters.append(AuditEvent.action == action)
    if entity_type:
        filters.append(AuditEvent.entity_type == entity_type)
    if actor_id:
        filters.append(AuditEvent.actor_id == actor_id)
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(or_(AuditEvent.action.ilike(pattern), AuditEvent.entity_type.ilike(pattern)))
    total = int(db.scalar(select(func.count(AuditEvent.id)).where(*filters)) or 0)
    events = db.scalars(
        select(AuditEvent)
        .where(*filters)
        .order_by(AuditEvent.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    actions = [
        {"action": str(row[0]), "count": int(row[1])}
        for row in db.execute(
            select(AuditEvent.action, func.count(AuditEvent.id))
            .where(AuditEvent.workspace_id == ctx.workspace.id)
            .group_by(AuditEvent.action)
            .order_by(func.count(AuditEvent.id).desc())
            .limit(30)
        ).all()
    ]
    return {
        "items": [serialize_audit(db, event) for event in events],
        "total": total,
        "limit": limit,
        "offset": offset,
        "available_actions": actions,
    }


@router.get("/admin/overview")
def admin_overview(
    ctx: WorkspaceContext = Depends(require_workspace_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    project_ids = [
        row[0]
        for row in db.execute(select(Project.id).where(Project.workspace_id == ctx.workspace.id)).all()
    ]
    counts = {
        "projects": len(project_ids),
        "datasets": int(
            db.scalar(
                select(func.count(Dataset.id)).join(Project, Project.id == Dataset.project_id).where(
                    Project.workspace_id == ctx.workspace.id
                )
            )
            or 0
        ),
        "training_runs": int(
            db.scalar(
                select(func.count(TrainingRun.id)).join(Project, Project.id == TrainingRun.project_id).where(
                    Project.workspace_id == ctx.workspace.id
                )
            )
            or 0
        ),
        "registered_models": int(
            db.scalar(
                select(func.count(RegisteredModel.id))
                .join(Project, Project.id == RegisteredModel.project_id)
                .where(Project.workspace_id == ctx.workspace.id)
            )
            or 0
        ),
        "model_versions": int(
            db.scalar(
                select(func.count(ModelVersion.id))
                .join(Project, Project.id == ModelVersion.project_id)
                .where(Project.workspace_id == ctx.workspace.id)
            )
            or 0
        ),
        "pending_approvals": int(
            db.scalar(
                select(func.count(ModelVersion.id))
                .join(Project, Project.id == ModelVersion.project_id)
                .where(
                    Project.workspace_id == ctx.workspace.id,
                    ModelVersion.approval_status == "pending",
                )
            )
            or 0
        ),
        "deployments": int(
            db.scalar(
                select(func.count(Deployment.id)).join(Project, Project.id == Deployment.project_id).where(
                    Project.workspace_id == ctx.workspace.id
                )
            )
            or 0
        ),
        "predictions": int(
            db.scalar(
                select(func.count(PredictionEvent.id))
                .join(Deployment, Deployment.id == PredictionEvent.deployment_id)
                .join(Project, Project.id == Deployment.project_id)
                .where(Project.workspace_id == ctx.workspace.id)
            )
            or 0
        ),
        "open_alerts": int(
            db.scalar(
                select(func.count(Alert.id)).where(
                    Alert.workspace_id == ctx.workspace.id,
                    Alert.status.in_(["open", "acknowledged"]),
                )
            )
            or 0
        ),
        "open_incidents": int(
            db.scalar(
                select(func.count(Incident.id)).where(
                    Incident.workspace_id == ctx.workspace.id,
                    Incident.status.in_(["open", "investigating"]),
                )
            )
            or 0
        ),
        "active_jobs": int(
            db.scalar(
                select(func.count(PipelineJob.id)).where(
                    PipelineJob.workspace_id == ctx.workspace.id,
                    PipelineJob.status.in_(["queued", "running"]),
                )
            )
            or 0
        ),
        "alert_rules": int(
            db.scalar(select(func.count(AlertRule.id)).where(AlertRule.workspace_id == ctx.workspace.id))
            or 0
        ),
    }
    database: dict[str, Any] = {"dialect": db.bind.dialect.name if db.bind else "unknown"}
    if settings.database_url.startswith("sqlite"):
        path = settings.database_url.removeprefix("sqlite:///")
        try:
            database["size_bytes"] = os.path.getsize(path)
            database["path"] = path
        except OSError:
            database["size_bytes"] = None
    system: dict[str, Any] | None = None
    if ctx.user.role == "admin":
        system = {
            "users": int(db.scalar(select(func.count(User.id))) or 0),
            "workspaces": int(db.scalar(select(func.count(Workspace.id))) or 0),
            "workspace_members": int(db.scalar(select(func.count(WorkspaceMember.id))) or 0),
        }
    return {
        "workspace_id": ctx.workspace.id,
        "workspace_name": ctx.workspace.name,
        "counts": counts,
        "database": database,
        "system": system,
        "storage_health": storage.check_health(),
        "mlflow_health": {key: value for key, value in tracker.health().items() if key != "tracking_uri"},
        "environment": settings.environment,
        "background_runner": settings.job_runner,
    }
