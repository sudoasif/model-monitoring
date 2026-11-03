from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import WorkspaceContext, get_current_user, get_workspace_context, project_context_for_user
from app.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.models import (
    Alert,
    AlertRule,
    Deployment,
    Incident,
    ModelVersion,
    Project,
    User,
    WorkspaceMember,
)
from app.schemas import (
    AlertOut,
    AlertRuleCreate,
    AlertRuleUpdate,
    IncidentCreate,
    IncidentUpdate,
    RemediationRequest,
    ResolveAlertRequest,
)
from app.services.audit import record_audit
from app.services.retraining import label_stats, queue_retraining
from app.services.serializers import serialize_alert, serialize_incident
from app.utils import utcnow

router = APIRouter(tags=["alerts"])
rule_router = APIRouter(prefix="/alert-rules", tags=["alert-rules"])
incident_router = APIRouter(prefix="/incidents", tags=["incidents"])


def _workspace_or_403(db: Session, user: User, workspace_id: str) -> WorkspaceContext:
    from app.models import Workspace

    workspace = db.get(Workspace, workspace_id)
    if not workspace:
        raise NotFoundError("Workspace not found")
    if user.role == "admin":
        return WorkspaceContext(workspace=workspace, role="admin", user=user)
    member = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.user_id == user.id,
        )
    )
    if not member:
        raise ForbiddenError("You do not have access to this alert.")
    return WorkspaceContext(workspace=workspace, role=member.role, user=user)


def _alert_context(db: Session, user: User, alert_id: str) -> tuple[Alert, Project, WorkspaceContext]:
    alert = db.get(Alert, alert_id)
    if not alert:
        raise NotFoundError("Alert not found")
    project = db.get(Project, alert.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    return alert, project, _workspace_or_403(db, user, alert.workspace_id)


def _incident_context(db: Session, user: User, incident_id: str) -> tuple[Incident, Project, WorkspaceContext]:
    incident = db.get(Incident, incident_id)
    if not incident:
        raise NotFoundError("Incident not found")
    project = db.get(Project, incident.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    return incident, project, _workspace_or_403(db, user, incident.workspace_id)


@router.get("/alerts/summary")
def alert_summary(
    days: int = Query(default=30, ge=1, le=365),
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from datetime import timedelta

    start = utcnow() - timedelta(days=days)
    base = [Alert.workspace_id == ctx.workspace.id, Alert.created_at >= start]
    by_status = {
        str(status): int(count)
        for status, count in db.execute(
            select(Alert.status, func.count(Alert.id)).where(*base).group_by(Alert.status)
        ).all()
    }
    by_severity = {
        str(severity): int(count)
        for severity, count in db.execute(
            select(Alert.severity, func.count(Alert.id)).where(*base).group_by(Alert.severity)
        ).all()
    }
    by_type = [
        {"type": str(alert_type), "count": int(count)}
        for alert_type, count in db.execute(
            select(Alert.type, func.count(Alert.id)).where(*base).group_by(Alert.type).order_by(func.count(Alert.id).desc())
        ).all()
    ]
    unacknowledged = int(
        db.scalar(
            select(func.count(Alert.id)).where(
                Alert.workspace_id == ctx.workspace.id,
                Alert.status == "open",
                Alert.acknowledged_at.is_(None),
            )
        )
        or 0
    )
    open_incidents = int(
        db.scalar(
            select(func.count(Incident.id)).where(
                Incident.workspace_id == ctx.workspace.id,
                Incident.status.in_(["open", "investigating"]),
            )
        )
        or 0
    )
    return {
        "workspace_id": ctx.workspace.id,
        "window_days": days,
        "by_status": by_status,
        "by_severity": by_severity,
        "by_type": by_type,
        "unacknowledged": unacknowledged,
        "open_incidents": open_incidents,
    }


@router.get("/alerts", response_model=dict[str, Any])
def list_alerts(
    status: Literal["open", "acknowledged", "resolved", "all"] = "all",
    severity: Literal["info", "warning", "high", "critical"] | None = None,
    type: str | None = Query(default=None, max_length=60),
    project_id: str | None = None,
    deployment_id: str | None = None,
    simulated: Literal["all", "true", "false"] = "all",
    q: str | None = Query(default=None, max_length=200),
    sort: Literal["created_at", "severity"] = "created_at",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = [Alert.workspace_id == ctx.workspace.id]
    if status != "all":
        filters.append(Alert.status == status)
    if severity:
        filters.append(Alert.severity == severity)
    if type:
        filters.append(Alert.type == type)
    if project_id:
        filters.append(Alert.project_id == project_id)
    if deployment_id:
        filters.append(Alert.deployment_id == deployment_id)
    if simulated != "all":
        filters.append(Alert.simulated.is_(simulated == "true"))
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(or_(Alert.title.ilike(pattern), Alert.message.ilike(pattern), Alert.type.ilike(pattern)))
    total = int(db.scalar(select(func.count(Alert.id)).where(*filters)) or 0)
    if sort == "severity":
        severity_rank = {
            "critical": 0,
            "high": 1,
            "warning": 2,
            "info": 3,
        }
        alerts = db.scalars(
            select(Alert).where(*filters).order_by(Alert.created_at.desc()).limit(1000)
        ).all()
        alerts = sorted(
            alerts,
            key=lambda alert: (severity_rank.get(alert.severity, 9), -alert.created_at.timestamp()),
            reverse=order == "asc",
        )[offset : offset + limit]
    else:
        column = Alert.created_at
        alerts = db.scalars(
            select(Alert)
            .where(*filters)
            .order_by(column.asc() if order == "asc" else column.desc())
            .limit(limit)
            .offset(offset)
        ).all()
    return {
        "items": [serialize_alert(db, alert) for alert in alerts],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/alerts/{alert_id}")
def get_alert(
    alert_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    alert, _project, _ctx = _alert_context(db, user, alert_id)
    payload = serialize_alert(db, alert)
    incident = db.scalar(
        select(Incident).where(Incident.alert_id == alert.id).order_by(Incident.created_at.desc()).limit(1)
    )
    rule = db.get(AlertRule, alert.rule_id) if alert.rule_id else None
    payload["incident"] = serialize_incident(db, incident) if incident else None
    payload["rule"] = (
        {
            "id": rule.id,
            "name": rule.name,
            "metric_type": rule.metric_type,
            "threshold": rule.threshold,
            "comparison": rule.comparison,
            "window_minutes": rule.window_minutes,
            "channels": rule.channels_json or [],
            "enabled": rule.enabled,
        }
        if rule
        else None
    )
    payload["remediation_log"] = (alert.details_json or {}).get("remediation_log") or []
    return payload


@router.post("/alerts/{alert_id}/acknowledge", response_model=AlertOut)
def acknowledge_alert(
    alert_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AlertOut:
    alert, project, _ctx = _alert_context(db, user, alert_id)
    if alert.status == "resolved":
        raise ConflictError("Resolved alerts cannot be acknowledged. Reopen is not supported; create an incident instead.")
    if alert.status == "open":
        alert.status = "acknowledged"
        alert.acknowledged_by = user.id
        alert.acknowledged_at = utcnow()
        record_audit(
            db,
            workspace_id=project.workspace_id,
            actor=user,
            action="alert.acknowledged",
            entity_type="alert",
            entity_id=alert.id,
            details={"type": alert.type, "severity": alert.severity},
            request=request,
        )
        db.commit()
    return AlertOut(**serialize_alert(db, alert))


@router.post("/alerts/{alert_id}/resolve", response_model=AlertOut)
def resolve_alert(
    alert_id: str,
    payload: ResolveAlertRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AlertOut:
    alert, project, _ctx = _alert_context(db, user, alert_id)
    if alert.status == "resolved":
        return AlertOut(**serialize_alert(db, alert))
    alert.status = "resolved"
    alert.resolved_by = user.id
    alert.resolved_at = utcnow()
    alert.resolution_note = payload.note.strip()
    if not alert.acknowledged_at:
        alert.acknowledged_by = user.id
        alert.acknowledged_at = utcnow()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="alert.resolved",
        entity_type="alert",
        entity_id=alert.id,
        details={"note": payload.note[:500], "type": alert.type},
        request=request,
    )
    db.commit()
    return AlertOut(**serialize_alert(db, alert))


@router.post("/alerts/{alert_id}/remediation")
def remediate_alert(
    alert_id: str,
    payload: RemediationRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Perform an explicit, audited remediation action.

    Actions are intentionally conservative: scheduling retraining creates a
    normal approval-gated job, and recommending a rollback never changes the
    deployment. Automatic deployment or rollback is not permitted here.
    """
    alert, project, ctx = _alert_context(db, user, alert_id)
    if payload.action != "open_incident" and not ctx.is_admin:
        raise ForbiddenError("Workspace administrator privileges are required for this remediation action.")

    log_entry: dict[str, Any] = {
        "action": payload.action,
        "note": payload.note.strip(),
        "actor_id": user.id,
        "actor_name": user.full_name,
        "at": utcnow().isoformat(),
        "automatic_change": False,
    }

    if payload.action == "open_incident":
        existing = db.scalar(
            select(Incident).where(
                Incident.alert_id == alert.id,
                Incident.status.in_(["open", "investigating", "mitigated"]),
            )
        )
        if existing:
            raise ConflictError(
                "An active incident is already linked to this alert.",
                {"incident_id": existing.id},
            )
        incident = Incident(
            workspace_id=alert.workspace_id,
            project_id=alert.project_id,
            alert_id=alert.id,
            deployment_id=alert.deployment_id,
            title=f"Incident · {alert.title}",
            description=(
                f"Opened from alert {alert.id} ({alert.severity}, {alert.type}).\n\n{alert.message}\n\n"
                f"Remediation note: {payload.note.strip() or 'None provided.'}"
            ),
            severity=alert.severity,
            status="open",
            owner_id=user.id,
            notes=[
                {
                    "at": utcnow().isoformat(),
                    "by": user.full_name,
                    "note": payload.note.strip() or "Incident opened from alert.",
                }
            ],
            metadata_json={"source": "alert_remediation", "alert_type": alert.type},
        )
        db.add(incident)
        db.flush()
        log_entry["incident_id"] = incident.id
        if alert.status == "open":
            alert.status = "acknowledged"
            alert.acknowledged_by = user.id
            alert.acknowledged_at = utcnow()
        result: dict[str, Any] = {"incident": serialize_incident(db, incident)}
    elif payload.action == "schedule_retraining":
        if not alert.deployment_id:
            raise ValidationAppError("This alert is not linked to a deployment, so retraining cannot be scheduled.")
        deployment = db.get(Deployment, alert.deployment_id)
        if not deployment:
            raise NotFoundError("The deployment linked to this alert no longer exists.")
        if deployment.project_id != project.id:
            raise ValidationAppError("The alert's deployment does not belong to its project.")
        job = queue_retraining(
            db,
            project=project,
            deployment=deployment,
            user=user,
            tune=False,
            min_new_labels=30,
            notes=(
                f"Scheduled from alert {alert.id} ({alert.type}). "
                f"{payload.note.strip() or 'No operator note provided.'}"
            ),
            request=request,
        )
        log_entry["job_id"] = job.id
        stats = label_stats(db, deployment)
        result = {
            "job": {
                "id": job.id,
                "status": job.status,
                "job_type": job.job_type,
                "deployment_id": deployment.id,
            },
            "label_stats": stats,
            "warning": (
                "The job will re-check label sufficiency before training and will fail explicitly if "
                "there are not enough labelled predictions with captured features."
            ),
        }
    else:  # recommend_rollback
        deployment = db.get(Deployment, alert.deployment_id) if alert.deployment_id else None
        if not deployment:
            raise ValidationAppError("This alert is not linked to a deployment; rollback cannot be recommended.")
        current = db.get(ModelVersion, deployment.model_version_id)
        history = list((deployment.config_json or {}).get("deployed_version_history") or [])
        history_ids = {
            item.get("model_version_id")
            for item in history
            if item.get("model_version_id") and item.get("model_version_id") != deployment.model_version_id
        }
        previous_versions = db.scalars(
            select(ModelVersion)
            .where(
                ModelVersion.project_id == project.id,
                ModelVersion.registered_model_id == current.registered_model_id if current else "",
                ModelVersion.approval_status == "approved",
                ModelVersion.id != deployment.model_version_id,
            )
            .order_by(ModelVersion.created_at.desc())
            .limit(10)
        ).all() if current else []
        candidates = [
            {
                "version_id": version.id,
                "version": version.version,
                "created_at": version.created_at,
                "in_deployment_history": version.id in history_ids,
                "stage": version.stage,
            }
            for version in previous_versions
        ]
        log_entry["recommended_version_ids"] = [item["version_id"] for item in candidates]
        result = {
            "deployment_id": deployment.id,
            "current_model_version_id": deployment.model_version_id,
            "candidates": candidates,
            "action_taken": "none",
            "message": (
                "Recommendation recorded only. No rollback was performed. A workspace administrator must "
                "execute an explicit rollback from the Deployments page after reviewing the candidate versions."
            ),
        }

    details = dict(alert.details_json or {})
    remediation_log = list(details.get("remediation_log") or [])
    remediation_log.append(log_entry)
    details["remediation_log"] = remediation_log[-25:]
    alert.details_json = details
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action=f"alert.remediation.{payload.action}",
        entity_type="alert",
        entity_id=alert.id,
        details={**log_entry, "deployment_id": alert.deployment_id},
        request=request,
    )
    db.commit()
    return {
        "alert_id": alert.id,
        "action": payload.action,
        "automatic_change": False,
        "audit_recorded": True,
        **result,
    }


# ------------------------------------------------------------------ alert rules


def _rule_access(db: Session, user: User, rule_id: str) -> tuple[AlertRule, WorkspaceContext]:
    rule = db.get(AlertRule, rule_id)
    if not rule:
        raise NotFoundError("Alert rule not found")
    ctx = _workspace_or_403(db, user, rule.workspace_id)
    return rule, ctx


@rule_router.get("")
def list_alert_rules(
    project_id: str | None = None,
    enabled: bool | None = None,
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    stmt = select(AlertRule).where(AlertRule.workspace_id == ctx.workspace.id)
    if project_id:
        stmt = stmt.where(AlertRule.project_id == project_id)
    if enabled is not None:
        stmt = stmt.where(AlertRule.enabled.is_(enabled))
    rules = db.scalars(stmt.order_by(AlertRule.created_at.desc())).all()
    return {
        "items": [
            {
                "id": rule.id,
                "workspace_id": rule.workspace_id,
                "project_id": rule.project_id,
                "project_name": (
                    db.get(Project, rule.project_id).name if rule.project_id else None
                ),
                "name": rule.name,
                "metric_type": rule.metric_type,
                "comparison": rule.comparison,
                "threshold": rule.threshold,
                "window_minutes": rule.window_minutes,
                "severity": rule.severity,
                "enabled": rule.enabled,
                "cooldown_minutes": rule.cooldown_minutes,
                "channels": rule.channels_json or ["in_app"],
                "min_samples": rule.min_samples,
                "created_at": rule.created_at,
                "updated_at": rule.updated_at,
            }
            for rule in rules
        ],
        "total": len(rules),
    }


@rule_router.post("", status_code=201)
def create_alert_rule(
    payload: AlertRuleCreate,
    request: Request,
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not ctx.is_admin:
        raise ForbiddenError("Workspace administrator privileges are required to manage alert rules.")
    if payload.project_id:
        project = db.get(Project, payload.project_id)
        if not project or project.workspace_id != ctx.workspace.id:
            raise NotFoundError("Project not found in this workspace")
    rule = AlertRule(
        workspace_id=ctx.workspace.id,
        project_id=payload.project_id,
        name=payload.name.strip(),
        metric_type=payload.metric_type,
        comparison=payload.comparison,
        threshold=float(payload.threshold),
        window_minutes=payload.window_minutes,
        severity=payload.severity,
        enabled=payload.enabled,
        cooldown_minutes=payload.cooldown_minutes,
        channels_json=payload.channels or ["in_app"],
        min_samples=payload.min_samples,
        created_by=ctx.user.id,
    )
    db.add(rule)
    db.flush()
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=ctx.user,
        action="alert_rule.created",
        entity_type="alert_rule",
        entity_id=rule.id,
        details={
            "name": rule.name,
            "metric_type": rule.metric_type,
            "threshold": rule.threshold,
            "comparison": rule.comparison,
            "project_id": rule.project_id,
        },
        request=request,
    )
    db.commit()
    return {
        "id": rule.id,
        "message": "Alert rule created.",
    }


@rule_router.patch("/{rule_id}")
def update_alert_rule(
    rule_id: str,
    payload: AlertRuleUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    rule, ctx = _rule_access(db, user, rule_id)
    if not ctx.is_admin:
        raise ForbiddenError("Workspace administrator privileges are required to manage alert rules.")
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is None:
            continue
        if key == "channels":
            rule.channels_json = value or ["in_app"]
        else:
            setattr(rule, key, value)
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=user,
        action="alert_rule.updated",
        entity_type="alert_rule",
        entity_id=rule.id,
        details={"fields": sorted(payload.model_dump(exclude_unset=True).keys())},
        request=request,
    )
    db.commit()
    return {"id": rule.id, "message": "Alert rule updated."}


@rule_router.delete("/{rule_id}", status_code=204)
def delete_alert_rule(
    rule_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    rule, ctx = _rule_access(db, user, rule_id)
    if not ctx.is_admin:
        raise ForbiddenError("Workspace administrator privileges are required to manage alert rules.")
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=user,
        action="alert_rule.deleted",
        entity_type="alert_rule",
        entity_id=rule.id,
        details={"name": rule.name, "metric_type": rule.metric_type},
        request=request,
    )
    db.delete(rule)
    db.commit()


# --------------------------------------------------------------------- incidents


@incident_router.get("")
def list_incidents(
    status: Literal["open", "investigating", "mitigated", "resolved", "all"] = "all",
    severity: Literal["info", "warning", "high", "critical"] | None = None,
    project_id: str | None = None,
    deployment_id: str | None = None,
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = [Incident.workspace_id == ctx.workspace.id]
    if status != "all":
        filters.append(Incident.status == status)
    if severity:
        filters.append(Incident.severity == severity)
    if project_id:
        filters.append(Incident.project_id == project_id)
    if deployment_id:
        filters.append(Incident.deployment_id == deployment_id)
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(or_(Incident.title.ilike(pattern), Incident.description.ilike(pattern)))
    total = int(db.scalar(select(func.count(Incident.id)).where(*filters)) or 0)
    incidents = db.scalars(
        select(Incident)
        .where(*filters)
        .order_by(Incident.updated_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return {
        "items": [serialize_incident(db, incident) for incident in incidents],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@incident_router.post("", status_code=201)
def create_incident(
    payload: IncidentCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    project = db.get(Project, payload.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    if payload.deployment_id:
        deployment = db.get(Deployment, payload.deployment_id)
        if not deployment or deployment.project_id != project.id:
            raise ValidationAppError("The deployment must belong to the project.")
    if payload.alert_id:
        alert = db.get(Alert, payload.alert_id)
        if not alert or alert.workspace_id != project.workspace_id:
            raise ValidationAppError("The alert does not belong to this workspace.")
    if payload.owner_id:
        member = db.scalar(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == project.workspace_id,
                WorkspaceMember.user_id == payload.owner_id,
            )
        )
        if not member:
            raise ValidationAppError("The incident owner must be a member of this workspace.")
    incident = Incident(
        workspace_id=project.workspace_id,
        project_id=project.id,
        alert_id=payload.alert_id,
        deployment_id=payload.deployment_id,
        title=payload.title.strip(),
        description=payload.description.strip(),
        severity=payload.severity,
        status="open",
        owner_id=payload.owner_id or user.id,
        notes=[
            {
                "at": utcnow().isoformat(),
                "by": user.full_name,
                "note": "Incident created.",
            }
        ],
        metadata_json={"source": "manual"},
    )
    db.add(incident)
    db.flush()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="incident.created",
        entity_type="incident",
        entity_id=incident.id,
        details={
            "title": incident.title,
            "severity": incident.severity,
            "alert_id": incident.alert_id,
            "deployment_id": incident.deployment_id,
        },
        request=request,
    )
    db.commit()
    return serialize_incident(db, incident)


@incident_router.get("/{incident_id}")
def get_incident(
    incident_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    incident, _project, _ctx = _incident_context(db, user, incident_id)
    return serialize_incident(db, incident)


@incident_router.patch("/{incident_id}")
def update_incident(
    incident_id: str,
    payload: IncidentUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    incident, project, _ctx = _incident_context(db, user, incident_id)
    updates = payload.model_dump(exclude_unset=True)
    notes = list(incident.notes or [])
    changed: list[str] = []
    if updates.get("status"):
        new_status = updates["status"]
        if new_status != incident.status:
            incident.status = new_status
            changed.append("status")
            if new_status == "resolved":
                incident.resolved_at = utcnow()
                incident.resolution_note = (updates.get("resolution_note") or "").strip()
                notes.append(
                    {
                        "at": utcnow().isoformat(),
                        "by": user.full_name,
                        "note": f"Resolved. {incident.resolution_note}".strip(),
                    }
                )
            else:
                notes.append(
                    {
                        "at": utcnow().isoformat(),
                        "by": user.full_name,
                        "note": f"Status changed to {new_status}.",
                    }
                )
    if updates.get("severity"):
        incident.severity = updates["severity"]
        changed.append("severity")
    if "owner_id" in updates:
        owner_id = updates["owner_id"]
        if owner_id:
            member = db.scalar(
                select(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == project.workspace_id,
                    WorkspaceMember.user_id == owner_id,
                )
            )
            if not member and user.role != "admin":
                raise ValidationAppError("The incident owner must be a member of this workspace.")
        incident.owner_id = owner_id
        changed.append("owner")
    if updates.get("note"):
        notes.append({"at": utcnow().isoformat(), "by": user.full_name, "note": updates["note"].strip()})
        changed.append("note")
    incident.notes = notes[-100:]
    incident.updated_at = utcnow()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="incident.updated",
        entity_type="incident",
        entity_id=incident.id,
        details={"changed": sorted(set(changed)), "status": incident.status},
        request=request,
    )
    db.commit()
    return serialize_incident(db, incident)


@incident_router.delete("/{incident_id}", status_code=204)
def delete_incident(
    incident_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    incident, project, ctx = _incident_context(db, user, incident_id)
    if not ctx.is_admin:
        raise ForbiddenError("Workspace administrator privileges are required to delete incidents.")
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="incident.deleted",
        entity_type="incident",
        entity_id=incident.id,
        details={"title": incident.title, "status": incident.status},
        request=request,
    )
    db.delete(incident)
    db.commit()
