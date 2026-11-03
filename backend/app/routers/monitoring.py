from __future__ import annotations

import math
import os
from datetime import datetime, timedelta
from typing import Any, Literal

import psutil
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import (
    ProjectContext,
    WorkspaceContext,
    get_current_user,
    get_project_context,
    get_workspace_context,
    project_context_for_user,
)
from app.errors import ConflictError, NotFoundError, ValidationAppError
from app.models import (
    Alert,
    DatasetVersion,
    Deployment,
    DriftReport,
    GroundTruthLabel,
    ModelVersion,
    PerformanceReport,
    PipelineJob,
    PredictionEvent,
    Project,
    RegisteredModel,
    TrainingRun,
    User,
)
from app.schemas import DriftAnalyzeRequest, LabelSubmission, PipelineJobOut
from app.services.audit import record_audit
from app.services.jobs import dispatch_job
from app.services.monitoring import (
    compute_performance,
    data_quality,
    deployment_metrics,
    performance_trend,
    project_metrics,
    recent_predictions,
    timeseries,
)
from app.services.rate_limit import limiter
from app.services.serializers import (
    serialize_alert,
    serialize_deployment,
    serialize_job,
    serialize_project,
    serialize_run,
)
from app.services.storage import storage
from app.utils import ensure_utc, jsonable, percentile, utcnow

router = APIRouter(tags=["monitoring"])
drift_router = APIRouter(prefix="/drift", tags=["drift"])


def _deployment_access(db: Session, user: User, deployment_id: str) -> tuple[Deployment, Project]:
    deployment = db.get(Deployment, deployment_id) or db.scalar(
        select(Deployment).where(Deployment.slug == deployment_id)
    )
    if not deployment:
        raise NotFoundError("Deployment not found")
    project = db.get(Project, deployment.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    return deployment, project


def _simulated_filter(value: str) -> bool | None:
    if value == "simulated":
        return True
    if value == "production":
        return False
    return None


def _window(days: int | None, hours: int | None) -> tuple[datetime, datetime]:
    end = utcnow()
    if hours is not None:
        start = end - timedelta(hours=max(1, min(int(hours), 24 * 365)))
    else:
        start = end - timedelta(days=max(1, min(int(days or 7), 365)))
    return start, end


def _process_resources() -> dict[str, Any]:
    try:
        process = psutil.Process(os.getpid())
        memory = process.memory_info()
        cpu = process.cpu_percent(interval=None)
        open_files = None
        try:
            open_files = len(process.open_files())
        except (psutil.AccessDenied, OSError):
            pass
        return {
            "scope": "api_process",
            "memory_rss_bytes": memory.rss,
            "memory_vms_bytes": memory.vms,
            "cpu_percent": cpu,
            "threads": process.num_threads(),
            "open_files": open_files,
            "measured_at": utcnow().isoformat(),
            "note": "Process-wide API resources, not per-deployment attribution.",
        }
    except Exception as exc:
        return {"scope": "api_process", "available": False, "error": str(exc)[:200]}


def _artifact_size(version: ModelVersion | None) -> int | None:
    if not version:
        return None
    try:
        return int(os.path.getsize(storage.materialize(version.artifact_key)))
    except Exception:
        return None


def _latest_drift_report(db: Session, deployment_id: str) -> DriftReport | None:
    return db.scalar(
        select(DriftReport)
        .where(DriftReport.deployment_id == deployment_id)
        .order_by(DriftReport.created_at.desc())
        .limit(1)
    )


@router.get("/overview")
def workspace_overview(
    days: int = Query(default=7, ge=1, le=90),
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    start, end = _window(days, None)
    project_ids = [
        row[0]
        for row in db.execute(select(Project.id).where(Project.workspace_id == ctx.workspace.id)).all()
    ]
    deployments = db.scalars(
        select(Deployment)
        .join(Project, Project.id == Deployment.project_id)
        .where(Project.workspace_id == ctx.workspace.id)
    ).all()
    deployment_ids = [deployment.id for deployment in deployments]
    volume = errors = simulated = 0
    latencies: list[float] = []
    if deployment_ids:
        rows = db.execute(
            select(PredictionEvent.status, PredictionEvent.latency_ms, PredictionEvent.simulated)
            .where(
                PredictionEvent.deployment_id.in_(deployment_ids),
                PredictionEvent.created_at >= start,
                PredictionEvent.created_at <= end,
            )
            .limit(200_000)
        ).all()
        volume = len(rows)
        errors = sum(1 for row in rows if row.status != "success")
        simulated = sum(1 for row in rows if row.simulated)
        latencies = [float(row.latency_ms) for row in rows if row.latency_ms is not None]
    open_alerts = int(
        db.scalar(
            select(func.count(Alert.id)).where(
                Alert.workspace_id == ctx.workspace.id, Alert.status.in_(["open", "acknowledged"])
            )
        )
        or 0
    )
    critical_alerts = int(
        db.scalar(
            select(func.count(Alert.id)).where(
                Alert.workspace_id == ctx.workspace.id,
                Alert.status.in_(["open", "acknowledged"]),
                Alert.severity == "critical",
            )
        )
        or 0
    )
    pending_approvals = int(
        db.scalar(
            select(func.count(ModelVersion.id))
            .join(Project, Project.id == ModelVersion.project_id)
            .where(Project.workspace_id == ctx.workspace.id, ModelVersion.approval_status == "pending")
        )
        or 0
    )
    unhealthy = sum(1 for deployment in deployments if deployment.last_health_status == "unhealthy")
    recent_runs = db.scalars(
        select(TrainingRun)
        .join(Project, Project.id == TrainingRun.project_id)
        .where(Project.workspace_id == ctx.workspace.id)
        .order_by(TrainingRun.created_at.desc())
        .limit(6)
    ).all()
    recent_alerts = db.scalars(
        select(Alert)
        .where(Alert.workspace_id == ctx.workspace.id)
        .order_by(Alert.created_at.desc())
        .limit(6)
    ).all()
    drift_reports = db.scalars(
        select(DriftReport)
        .join(Project, Project.id == DriftReport.project_id)
        .where(Project.workspace_id == ctx.workspace.id)
        .order_by(DriftReport.created_at.desc())
        .limit(5)
    ).all()
    projects = db.scalars(
        select(Project)
        .where(Project.workspace_id == ctx.workspace.id)
        .order_by(Project.updated_at.desc())
        .limit(5)
    ).all()
    return {
        "workspace": {"id": ctx.workspace.id, "name": ctx.workspace.name, "role": ctx.role},
        "window": {"start": start, "end": end, "days": days},
        "counts": {
            "projects": len(project_ids),
            "deployments": len(deployments),
            "active_deployments": sum(1 for deployment in deployments if deployment.status == "active"),
            "unhealthy_deployments": unhealthy,
            "open_alerts": open_alerts,
            "critical_alerts": critical_alerts,
            "pending_approvals": pending_approvals,
        },
        "traffic": {
            "requests": volume,
            "errors": errors,
            "error_rate": errors / max(1, volume),
            "simulated": simulated,
            "production": volume - simulated,
            "latency_p95_ms": percentile(latencies, 95),
            "source": "simulated" if volume and simulated == volume else "mixed" if simulated else "production" if volume else "none",
        },
        "recent_runs": [serialize_run(db, run) for run in recent_runs],
        "recent_alerts": [serialize_alert(db, alert) for alert in recent_alerts],
        "recent_drift_reports": [_serialize_drift_summary(db, report) for report in drift_reports],
        "projects": [serialize_project(db, project) for project in projects],
        "resources": _process_resources(),
    }


@router.get("/projects/{project_id}/monitoring/summary")
def project_monitoring_summary(
    days: int = Query(default=7, ge=1, le=90),
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    start, end = _window(days, None)
    deployments = db.scalars(
        select(Deployment).where(Deployment.project_id == ctx.project.id).order_by(Deployment.created_at.desc())
    ).all()
    metrics = project_metrics(db, project_id=ctx.project.id, start=start, end=end)
    open_alerts = int(
        db.scalar(
            select(func.count(Alert.id)).where(
                Alert.project_id == ctx.project.id, Alert.status.in_(["open", "acknowledged"])
            )
        )
        or 0
    )
    latest_runs = db.scalars(
        select(TrainingRun)
        .where(TrainingRun.project_id == ctx.project.id)
        .order_by(TrainingRun.created_at.desc())
        .limit(3)
    ).all()
    latest_model = db.scalar(
        select(RegisteredModel)
        .where(RegisteredModel.project_id == ctx.project.id)
        .order_by(RegisteredModel.created_at.desc())
        .limit(1)
    )
    deployment_cards = []
    for deployment in deployments:
        latest_drift = _latest_drift_report(db, deployment.id)
        deployment_cards.append(
            {
                **serialize_deployment(db, deployment),
                "latest_drift_severity": latest_drift.severity if latest_drift else None,
                "latest_drift_at": latest_drift.created_at if latest_drift else None,
            }
        )
    return {
        "project": serialize_project(db, ctx.project),
        "window": {"start": start, "end": end, "days": days},
        "metrics": metrics,
        "open_alerts": open_alerts,
        "deployments": deployment_cards,
        "recent_runs": [serialize_run(db, run) for run in latest_runs],
        "latest_model_id": latest_model.id if latest_model else None,
    }


@router.get("/deployments/{deployment_id}/monitoring")
def deployment_monitoring(
    deployment_id: str,
    days: int | None = Query(default=7, ge=1, le=365),
    hours: int | None = Query(default=None, ge=1, le=8760),
    granularity: Literal["hour", "day", "week"] = "hour",
    simulated: Literal["all", "production", "simulated"] = "all",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, project = _deployment_access(db, user, deployment_id)
    start, end = _window(days, hours)
    simulated_filter = _simulated_filter(simulated)
    metrics = deployment_metrics(
        db, deployment=deployment, start=start, end=end, simulated=simulated_filter
    )
    series = timeseries(
        db,
        deployment_id=deployment.id,
        project_id=None,
        start=start,
        end=end,
        granularity=granularity,
        simulated=simulated_filter,
    )
    version = db.get(ModelVersion, deployment.model_version_id)
    performance = compute_performance(
        db,
        deployment=deployment,
        start=start,
        end=end,
        persist=False,
        evaluate_alerts=False,
    )
    latest_drift = _latest_drift_report(db, deployment.id)
    latest_performance = db.scalar(
        select(PerformanceReport)
        .where(PerformanceReport.deployment_id == deployment.id)
        .order_by(PerformanceReport.created_at.desc())
        .limit(1)
    )
    return {
        "deployment": serialize_deployment(db, deployment),
        "project": serialize_project(db, project),
        "model_version": {
            "id": version.id if version else None,
            "version": version.version if version else None,
            "artifact_hash": version.artifact_hash if version else None,
            "artifact_size_bytes": _artifact_size(version),
            "model_card": (version.model_card_json if version else {}) or {},
        },
        "window": {"start": start, "end": end, "granularity": granularity},
        "simulated_filter": simulated,
        "metrics": metrics,
        "timeseries": series,
        "performance": performance,
        "performance_trend": performance_trend(db, deployment=deployment, start=start, end=end),
        "data_quality": data_quality(db, deployment=deployment, start=start, end=end),
        "recent_predictions": recent_predictions(db, deployment=deployment, limit=15),
        "latest_drift_report": _serialize_drift_summary(db, latest_drift) if latest_drift else None,
        "latest_performance_report_id": latest_performance.id if latest_performance else None,
        "resources": _process_resources(),
    }


@router.get("/deployments/{deployment_id}/monitoring/timeseries")
def deployment_timeseries(
    deployment_id: str,
    days: int | None = Query(default=7, ge=1, le=365),
    hours: int | None = Query(default=None, ge=1, le=8760),
    granularity: Literal["hour", "day", "week"] = "hour",
    simulated: Literal["all", "production", "simulated"] = "all",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_access(db, user, deployment_id)
    start, end = _window(days, hours)
    return timeseries(
        db,
        deployment_id=deployment.id,
        project_id=None,
        start=start,
        end=end,
        granularity=granularity,
        simulated=_simulated_filter(simulated),
    )


@router.get("/deployments/{deployment_id}/predictions")
def deployment_predictions(
    deployment_id: str,
    status: Literal["success", "error", "all"] = "all",
    simulated: Literal["all", "production", "simulated"] = "all",
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_access(db, user, deployment_id)
    filters = [PredictionEvent.deployment_id == deployment.id]
    if status != "all":
        filters.append(PredictionEvent.status == status)
    simulated_filter = _simulated_filter(simulated)
    if simulated_filter is not None:
        filters.append(PredictionEvent.simulated.is_(simulated_filter))
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(
            or_(
                PredictionEvent.request_id.ilike(pattern),
                PredictionEvent.prediction_label.ilike(pattern),
                PredictionEvent.error_type.ilike(pattern),
            )
        )
    total = int(db.scalar(select(func.count()).select_from(PredictionEvent).where(*filters)) or 0)
    events = db.scalars(
        select(PredictionEvent)
        .where(*filters)
        .order_by(PredictionEvent.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    labels = {
        label.prediction_event_id: label
        for label in db.scalars(
            select(GroundTruthLabel).where(
                GroundTruthLabel.prediction_event_id.in_([event.id for event in events])
            )
        ).all()
    } if events else {}
    return {
        "items": [
            {
                "id": event.id,
                "request_id": event.request_id,
                "timestamp": event.created_at,
                "status": event.status,
                "latency_ms": event.latency_ms,
                "error_type": event.error_type,
                "error_message": event.error_message,
                "prediction": (event.prediction_json or {}).get("prediction") if event.prediction_json else None,
                "confidence": event.confidence,
                "simulated": event.simulated,
                "is_batch": event.is_batch,
                "ground_truth": labels[event.id].label_value if event.id in labels else None,
                "label_received_at": labels[event.id].received_at if event.id in labels else None,
                "label_simulated": labels[event.id].simulated if event.id in labels else None,
            }
            for event in events
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/deployments/{deployment_id}/performance")
def deployment_performance(
    deployment_id: str,
    days: int = Query(default=7, ge=1, le=365),
    min_labels: int | None = Query(default=None, ge=1),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_access(db, user, deployment_id)
    start, end = _window(days, None)
    return compute_performance(
        db,
        deployment=deployment,
        start=start,
        end=end,
        min_labels=min_labels,
        persist=False,
        evaluate_alerts=False,
    )


@router.post("/deployments/{deployment_id}/performance/evaluate")
def evaluate_deployment_performance(
    deployment_id: str,
    request: Request,
    days: int = Query(default=7, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, project = _deployment_access(db, user, deployment_id)
    start, end = _window(days, None)
    result = compute_performance(
        db,
        deployment=deployment,
        start=start,
        end=end,
        persist=True,
        actor_id=user.id,
        evaluate_alerts=True,
    )
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="performance.evaluated",
        entity_type="deployment",
        entity_id=deployment.id,
        details={
            "status": result.get("status"),
            "label_count": result.get("label_count"),
            "degraded": result.get("degraded"),
            "report_id": result.get("report_id"),
        },
        request=request,
    )
    db.commit()
    return result


@router.get("/deployments/{deployment_id}/performance/trend")
def deployment_performance_trend(
    deployment_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_access(db, user, deployment_id)
    start, end = _window(days, None)
    return performance_trend(db, deployment=deployment, start=start, end=end)


@router.get("/deployments/{deployment_id}/labels/status")
def deployment_label_status(
    deployment_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_access(db, user, deployment_id)
    start, end = _window(days, None)
    prediction_count = int(
        db.scalar(
            select(func.count())
            .select_from(PredictionEvent)
            .where(
                PredictionEvent.deployment_id == deployment.id,
                PredictionEvent.created_at >= start,
                PredictionEvent.created_at <= end,
            )
        )
        or 0
    )
    label_count = int(
        db.scalar(
            select(func.count())
            .select_from(GroundTruthLabel)
            .join(PredictionEvent, PredictionEvent.id == GroundTruthLabel.prediction_event_id)
            .where(
                GroundTruthLabel.deployment_id == deployment.id,
                PredictionEvent.created_at >= start,
                PredictionEvent.created_at <= end,
            )
        )
        or 0
    )
    delays = []
    rows = db.execute(
        select(GroundTruthLabel.received_at, PredictionEvent.created_at)
        .join(PredictionEvent, PredictionEvent.id == GroundTruthLabel.prediction_event_id)
        .where(
            GroundTruthLabel.deployment_id == deployment.id,
            PredictionEvent.created_at >= start,
            PredictionEvent.created_at <= end,
        )
    ).all()
    for received, predicted in rows:
        try:
            delays.append(
                max(0.0, (ensure_utc(received) - ensure_utc(predicted)).total_seconds())
            )
        except (TypeError, AttributeError):
            continue
    min_labels = int(
        (deployment.config_json or {}).get("min_label_samples") or settings.default_min_label_samples
    )
    return {
        "deployment_id": deployment.id,
        "window": {"start": start, "end": end},
        "prediction_count": prediction_count,
        "label_count": label_count,
        "label_rate": label_count / max(1, prediction_count),
        "min_labels": min_labels,
        "status": "sufficient" if label_count >= min_labels else "insufficient_labels",
        "delayed_labels": {
            "p50_seconds": percentile(delays, 50),
            "p95_seconds": percentile(delays, 95),
            "sample_count": len(delays),
        },
        "message": (
            "Ground-truth labels are sufficient for performance evaluation."
            if label_count >= min_labels
            else f"{label_count} labels available; {min_labels} required. Accuracy is not reported without labels."
        ),
    }


@router.post("/labels")
def submit_labels(
    payload: LabelSubmission,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    limiter.hit(f"labels:{user.id}", 60, 60)
    deployment = db.get(Deployment, payload.deployment_id)
    if not deployment:
        raise NotFoundError("Deployment not found")
    project = db.get(Project, deployment.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    version = db.get(ModelVersion, deployment.model_version_id)
    if not version:
        raise NotFoundError("Deployed model version not found")
    class_labels: list[str] = []
    if project.task_type == "classification":
        class_labels = [str(value) for value in ((version.metrics_json or {}).get("class_labels") or [])]
        if not class_labels:
            raise ValidationAppError("The deployed model has no recorded class schema; labels cannot be validated.")
    created = 0
    skipped = 0
    errors: list[dict[str, Any]] = []
    label_rows: list[GroundTruthLabel] = []
    for item in payload.labels:
        event = db.get(PredictionEvent, item.prediction_id) or db.scalar(
            select(PredictionEvent).where(PredictionEvent.request_id == item.prediction_id)
        )
        if not event or event.deployment_id != deployment.id:
            errors.append({"prediction_id": item.prediction_id, "error": "Prediction not found for this deployment."})
            continue
        if event.status != "success":
            errors.append({"prediction_id": item.prediction_id, "error": "Only successful predictions can be labelled."})
            continue
        existing = db.scalar(
            select(GroundTruthLabel).where(GroundTruthLabel.prediction_event_id == event.id)
        )
        if existing:
            skipped += 1
            errors.append(
                {
                    "prediction_id": item.prediction_id,
                    "error": "A label already exists for this prediction; corrections are not applied automatically.",
                }
            )
            continue
        raw_value = item.label
        if project.task_type == "classification":
            value = str(raw_value).strip()
            if value not in class_labels:
                errors.append(
                    {
                        "prediction_id": item.prediction_id,
                        "error": f"Label must be one of: {', '.join(class_labels[:20])}",
                    }
                )
                continue
            label_json = {"value": value}
        else:
            try:
                value_number = float(raw_value)
                if not math.isfinite(value_number):
                    raise ValueError
            except (TypeError, ValueError):
                errors.append({"prediction_id": item.prediction_id, "error": "Regression labels must be finite numbers."})
                continue
            value = str(value_number)
            label_json = {"value": value_number}
        label = GroundTruthLabel(
            prediction_event_id=event.id,
            deployment_id=deployment.id,
            project_id=project.id,
            model_version_id=event.model_version_id,
            label_json={**label_json, "source": payload.source},
            label_value=value[:160],
            prediction_at=event.created_at,
            received_at=utcnow(),
            label_source=payload.source,
            simulated=bool(item.simulated),
        )
        db.add(label)
        label_rows.append(label)
        event.labels_available = True
        created += 1
    if created:
        db.commit()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="labels.submitted",
        entity_type="deployment",
        entity_id=deployment.id,
        details={
            "created": created,
            "skipped": skipped,
            "errors": len(errors),
            "source": payload.source,
            "simulated": any(item.simulated for item in payload.labels),
        },
        request=request,
    )
    db.commit()
    performance = None
    if created:
        start, end = _window(30, None)
        performance = compute_performance(
            db,
            deployment=deployment,
            start=start,
            end=end,
            persist=True,
            actor_id=user.id,
            evaluate_alerts=True,
        )
        record_audit(
            db,
            workspace_id=project.workspace_id,
            actor=user,
            action="performance.evaluated",
            entity_type="deployment",
            entity_id=deployment.id,
            details={
                "labels_submitted": created,
                "status": performance.get("status"),
                "report_id": performance.get("report_id"),
            },
        )
        db.commit()
    return {
        "deployment_id": deployment.id,
        "created": created,
        "skipped": skipped,
        "errors": errors[:100],
        "performance": performance,
    }


@router.get("/deployments/{deployment_id}/data-quality")
def deployment_data_quality(
    deployment_id: str,
    days: int = Query(default=7, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_access(db, user, deployment_id)
    start, end = _window(days, None)
    return data_quality(db, deployment=deployment, start=start, end=end)


@router.get("/deployments/{deployment_id}/performance/reports")
def performance_reports(
    deployment_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_access(db, user, deployment_id)
    total = int(
        db.scalar(
            select(func.count(PerformanceReport.id)).where(
                PerformanceReport.deployment_id == deployment.id
            )
        )
        or 0
    )
    reports = db.scalars(
        select(PerformanceReport)
        .where(PerformanceReport.deployment_id == deployment.id)
        .order_by(PerformanceReport.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return {
        "items": [
            {
                "id": report.id,
                "window_start": report.window_start,
                "window_end": report.window_end,
                "prediction_count": report.prediction_count,
                "label_count": report.label_count,
                "status": report.status,
                "primary_metric": report.primary_metric,
                "metrics": report.metrics_json or {},
                "baseline_metrics": report.baseline_metrics_json or {},
                "delta": report.delta_json or {},
                "degraded": report.degraded,
                "suspected_concept_drift": report.suspected_concept_drift,
                "notes": report.notes,
                "created_at": report.created_at,
            }
            for report in reports
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@drift_router.post("/analyze", response_model=PipelineJobOut, status_code=202)
def start_drift_analysis(
    payload: DriftAnalyzeRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PipelineJobOut:
    project = db.get(Project, payload.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    deployment_id = payload.deployment_id
    if deployment_id:
        deployment = db.get(Deployment, deployment_id)
        if not deployment or deployment.project_id != project.id:
            raise NotFoundError("Deployment not found in this project")
    if payload.current_dataset_version_id and not payload.reference_dataset_version_id:
        raise ValidationAppError("A reference dataset version is required when analyzing a dataset snapshot.")
    active = db.scalar(
        select(PipelineJob).where(
            PipelineJob.project_id == project.id,
            PipelineJob.job_type == "drift_analysis",
            PipelineJob.status.in_(["queued", "running"]),
        )
    )
    if active:
        raise ConflictError("A drift analysis is already queued or running for this project.", {"job_id": active.id})
    job = PipelineJob(
        workspace_id=project.workspace_id,
        project_id=project.id,
        deployment_id=deployment_id,
        job_type="drift_analysis",
        status="queued",
        stage="queued",
        params_json=jsonable(
            {
                "project_id": project.id,
                "deployment_id": deployment_id,
                "reference_dataset_version_id": payload.reference_dataset_version_id,
                "current_dataset_version_id": payload.current_dataset_version_id,
                "window_start": payload.window_start,
                "window_end": payload.window_end,
            }
        ),
        triggered_by=user.id,
        dedupe_key=f"drift:{project.id}:{deployment_id or 'dataset'}",
    )
    db.add(job)
    db.flush()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="drift.analysis_queued",
        entity_type="pipeline_job",
        entity_id=job.id,
        details={"project_id": project.id, "deployment_id": deployment_id},
        request=request,
    )
    db.commit()
    dispatch_job(job.id)
    return PipelineJobOut(**serialize_job(db, job))


@drift_router.get("/reports")
def list_drift_reports(
    project_id: str | None = None,
    deployment_id: str | None = None,
    severity: str | None = None,
    status: str | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    stmt = (
        select(DriftReport)
        .join(Project, Project.id == DriftReport.project_id)
        .where(Project.workspace_id == ctx.workspace.id)
    )
    count_stmt = (
        select(func.count(DriftReport.id))
        .join(Project, Project.id == DriftReport.project_id)
        .where(Project.workspace_id == ctx.workspace.id)
    )
    if project_id:
        stmt = stmt.where(DriftReport.project_id == project_id)
        count_stmt = count_stmt.where(DriftReport.project_id == project_id)
    if deployment_id:
        stmt = stmt.where(DriftReport.deployment_id == deployment_id)
        count_stmt = count_stmt.where(DriftReport.deployment_id == deployment_id)
    if severity:
        stmt = stmt.where(DriftReport.severity == severity)
        count_stmt = count_stmt.where(DriftReport.severity == severity)
    if status:
        stmt = stmt.where(DriftReport.status == status)
        count_stmt = count_stmt.where(DriftReport.status == status)
    total = int(db.scalar(count_stmt) or 0)
    reports = db.scalars(
        stmt.order_by(DriftReport.created_at.desc()).limit(limit).offset(offset)
    ).all()
    return {
        "items": [_serialize_drift_summary(db, report) for report in reports],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@drift_router.get("/reports/{report_id}")
def get_drift_report(
    report_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    report = db.get(DriftReport, report_id)
    if not report:
        raise NotFoundError("Drift report not found")
    project = db.get(Project, report.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    payload = _serialize_drift_summary(db, report)
    payload["report"] = report.report_json or {}
    payload["config"] = report.config_json or {}
    payload["window"] = {"start": report.window_start, "end": report.window_end}
    payload["features"] = [
        {
            "feature": result.feature,
            "feature_type": result.feature_type,
            "method": result.method,
            "statistic": result.statistic,
            "p_value": result.p_value,
            "adjusted_p_value": result.adjusted_p_value,
            "psi": result.psi,
            "threshold": result.threshold,
            "drifted": result.drifted,
            "severity": result.severity,
            "reference_missing_rate": result.reference_missing_rate,
            "current_missing_rate": result.current_missing_rate,
            "reference_sample_size": result.reference_sample_size,
            "current_sample_size": result.current_sample_size,
            "details": result.details_json or {},
            "recommendation": result.recommendation,
        }
        for result in sorted(
            report.results,
            key=lambda item: (
                {"critical": 0, "high": 1, "medium": 2, "low": 3, "none": 4, "unknown": 5}.get(item.severity, 6),
                item.feature,
            ),
        )
    ]
    return payload


@drift_router.get("/options")
def drift_options(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    project = db.get(Project, project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    deployments = db.scalars(
        select(Deployment).where(Deployment.project_id == project.id).order_by(Deployment.created_at.desc())
    ).all()
    from app.models import Dataset

    dataset_rows = db.execute(
        select(DatasetVersion, Dataset)
        .join(Dataset, Dataset.id == DatasetVersion.dataset_id)
        .where(Dataset.project_id == project.id)
        .order_by(DatasetVersion.created_at.desc())
        .limit(100)
    ).all()
    return {
        "project_id": project.id,
        "deployments": [
            {
                "id": deployment.id,
                "name": deployment.name,
                "status": deployment.status,
                "reference_dataset_version_id": (deployment.config_json or {}).get("reference_dataset_version_id"),
            }
            for deployment in deployments
        ],
        "dataset_versions": [
            {
                "id": version.id,
                "dataset_name": dataset.name,
                "version": version.version,
                "rows": version.row_count,
                "is_reference": version.is_reference,
                "notes": version.notes,
                "created_at": version.created_at,
            }
            for version, dataset in dataset_rows
        ],
    }


def _serialize_drift_summary(db: Session, report: DriftReport) -> dict[str, Any]:
    project = db.get(Project, report.project_id)
    deployment = db.get(Deployment, report.deployment_id) if report.deployment_id else None
    reference = db.get(DatasetVersion, report.reference_dataset_version_id)
    current = db.get(DatasetVersion, report.current_dataset_version_id) if report.current_dataset_version_id else None
    return {
        "id": report.id,
        "project_id": report.project_id,
        "project_name": project.name if project else None,
        "deployment_id": report.deployment_id,
        "deployment_name": deployment.name if deployment else None,
        "reference_dataset_version_id": report.reference_dataset_version_id,
        "reference_label": (
            f"v{reference.version} · {reference.original_filename}" if reference else None
        ),
        "current_dataset_version_id": report.current_dataset_version_id,
        "current_label": f"v{current.version} · {current.original_filename}" if current else "captured production samples",
        "status": report.status,
        "engine": report.engine,
        "severity": report.severity,
        "drift_share": report.drift_share,
        "drifted_feature_count": report.drifted_feature_count,
        "feature_count": report.feature_count,
        "reference_sample_size": report.reference_sample_size,
        "current_sample_size": report.current_sample_size,
        "summary": report.summary_json or {},
        "window": {"start": report.window_start, "end": report.window_end},
        "created_at": report.created_at,
        "created_by": report.created_by,
    }
