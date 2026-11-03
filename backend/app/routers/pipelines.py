from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import WorkspaceContext, get_current_user, get_workspace_context, project_context_for_user
from app.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.models import (
    Deployment,
    ModelVersion,
    PipelineJob,
    Project,
    TrainingRun,
    User,
    Workspace,
    WorkspaceMember,
)
from app.schemas import (
    DemoSeedRequest,
    PipelineJobDetail,
    PipelineJobOut,
    RetrainRequest,
    SimulationRequest,
)
from app.services.audit import record_audit
from app.services.datasets import SAMPLE_DATASETS
from app.services.demo import queue_simulation, seed_demo
from app.services.jobs import dispatch_job
from app.services.retraining import label_stats, last_successful_retraining, queue_retraining
from app.services.serializers import serialize_job
from app.utils import utcnow

router = APIRouter(tags=["pipelines"])
demo_router = APIRouter(prefix="/demo", tags=["demo"])


def _workspace_access(db: Session, user: User, workspace_id: str) -> WorkspaceContext:
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
        raise ForbiddenError("You do not have access to this pipeline job.")
    return WorkspaceContext(workspace=workspace, role=member.role, user=user)


def _job_access(db: Session, user: User, job_id: str) -> tuple[PipelineJob, WorkspaceContext]:
    job = db.get(PipelineJob, job_id)
    if not job:
        raise NotFoundError("Pipeline job not found")
    return job, _workspace_access(db, user, job.workspace_id)


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


def _active_job_for_retry(db: Session, job: PipelineJob) -> PipelineJob | None:
    if job.job_type in {"training", "retraining"} and job.project_id:
        return db.scalar(
            select(PipelineJob)
            .where(
                PipelineJob.project_id == job.project_id,
                PipelineJob.job_type.in_(["training", "retraining"]),
                PipelineJob.status.in_(["queued", "running"]),
            )
            .limit(1)
        )
    if job.job_type == "retraining" and job.deployment_id:
        return db.scalar(
            select(PipelineJob)
            .where(
                PipelineJob.deployment_id == job.deployment_id,
                PipelineJob.job_type == "retraining",
                PipelineJob.status.in_(["queued", "running"]),
            )
            .limit(1)
        )
    if job.job_type == "drift_analysis" and job.project_id:
        return db.scalar(
            select(PipelineJob)
            .where(
                PipelineJob.project_id == job.project_id,
                PipelineJob.job_type == "drift_analysis",
                PipelineJob.status.in_(["queued", "running"]),
            )
            .limit(1)
        )
    if job.job_type == "simulation" and job.deployment_id:
        return db.scalar(
            select(PipelineJob)
            .where(
                PipelineJob.deployment_id == job.deployment_id,
                PipelineJob.job_type == "simulation",
                PipelineJob.status.in_(["queued", "running"]),
            )
            .limit(1)
        )
    return None


@router.get("/jobs")
def list_jobs(
    job_type: str | None = Query(default=None, max_length=40),
    status: Literal["queued", "running", "succeeded", "failed", "cancelled", "all"] = "all",
    project_id: str | None = None,
    deployment_id: str | None = None,
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = [PipelineJob.workspace_id == ctx.workspace.id]
    if job_type:
        filters.append(PipelineJob.job_type == job_type)
    if status != "all":
        filters.append(PipelineJob.status == status)
    if project_id:
        filters.append(PipelineJob.project_id == project_id)
    if deployment_id:
        filters.append(PipelineJob.deployment_id == deployment_id)
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(or_(PipelineJob.stage.ilike(pattern), PipelineJob.error.ilike(pattern)))
    total = int(db.scalar(select(func.count(PipelineJob.id)).where(*filters)) or 0)
    jobs = db.scalars(
        select(PipelineJob)
        .where(*filters)
        .order_by(PipelineJob.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return {
        "items": [serialize_job(db, job) for job in jobs],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/jobs/summary")
def job_summary(
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    rows = db.execute(
        select(PipelineJob.status, func.count(PipelineJob.id))
        .where(PipelineJob.workspace_id == ctx.workspace.id)
        .group_by(PipelineJob.status)
    ).all()
    by_status = {str(status): int(count) for status, count in rows}
    by_type = [
        {"job_type": str(job_type), "count": int(count)}
        for job_type, count in db.execute(
            select(PipelineJob.job_type, func.count(PipelineJob.id))
            .where(PipelineJob.workspace_id == ctx.workspace.id)
            .group_by(PipelineJob.job_type)
        ).all()
    ]
    recent = db.scalars(
        select(PipelineJob)
        .where(PipelineJob.workspace_id == ctx.workspace.id)
        .order_by(PipelineJob.created_at.desc())
        .limit(5)
    ).all()
    return {
        "by_status": by_status,
        "by_type": by_type,
        "recent": [serialize_job(db, job) for job in recent],
        "active": int(by_status.get("queued", 0) + by_status.get("running", 0)),
    }


@router.get("/jobs/{job_id}", response_model=PipelineJobDetail)
def get_job(
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PipelineJobDetail:
    job, _ctx = _job_access(db, user, job_id)
    return PipelineJobDetail(**serialize_job(db, job, include_logs=True))


@router.get("/jobs/{job_id}/logs")
def get_job_logs(
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    job, _ctx = _job_access(db, user, job_id)
    logs = job.logs or ""
    return {
        "job_id": job.id,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "logs": logs,
        "truncated": len(logs) >= 120_000,
        "available": bool(logs),
    }


@router.post("/jobs/{job_id}/retry", response_model=PipelineJobOut, status_code=202)
def retry_job(
    job_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PipelineJobOut:
    job, ctx = _job_access(db, user, job_id)
    if job.status not in {"failed", "cancelled"}:
        raise ConflictError(
            "Only failed or cancelled jobs can be retried. Wait for an active job to finish.",
            {"status": job.status},
        )
    active = _active_job_for_retry(db, job)
    if active:
        raise ConflictError(
            "A related job is already queued or running.",
            {"job_id": active.id, "job_type": active.job_type, "status": active.status},
        )
    if job.job_type == "retraining" and job.deployment_id:
        deployment = db.get(Deployment, job.deployment_id)
        if not deployment:
            raise ValidationAppError("The deployment for this retraining job no longer exists.")
    retry = PipelineJob(
        workspace_id=job.workspace_id,
        project_id=job.project_id,
        deployment_id=job.deployment_id,
        job_type=job.job_type,
        status="queued",
        progress=0,
        stage="queued",
        params_json=job.params_json or {},
        triggered_by=user.id,
        dedupe_key=f"{job.dedupe_key or job.job_type}:retry:{uuid.uuid4().hex[:8]}",
        max_attempts=job.max_attempts or 2,
        parent_job_id=job.id,
        simulated=job.simulated,
        logs=f"[retry] Re-dispatched from failed job {job.id}.\n",
    )
    db.add(retry)
    db.flush()
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=user,
        action="pipeline_job.retried",
        entity_type="pipeline_job",
        entity_id=retry.id,
        details={
            "parent_job_id": job.id,
            "job_type": job.job_type,
            "previous_status": job.status,
            "project_id": job.project_id,
            "deployment_id": job.deployment_id,
        },
        request=request,
    )
    db.commit()
    db.refresh(retry)
    dispatch_job(retry.id)
    return PipelineJobOut(**serialize_job(db, retry))


@router.post("/jobs/{job_id}/cancel", response_model=PipelineJobOut)
def cancel_job(
    job_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PipelineJobOut:
    job, ctx = _job_access(db, user, job_id)
    if job.status != "queued":
        raise ConflictError(
            "Only queued jobs can be cancelled safely. A running job cannot be interrupted reliably by the current runner.",
            {"status": job.status},
        )
    job.status = "cancelled"
    job.stage = "cancelled"
    job.finished_at = utcnow()
    job.logs = (job.logs or "") + "[cancel] Cancelled before execution started.\n"
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=user,
        action="pipeline_job.cancelled",
        entity_type="pipeline_job",
        entity_id=job.id,
        details={"job_type": job.job_type},
        request=request,
    )
    db.commit()
    return PipelineJobOut(**serialize_job(db, job))


@router.post("/retrain", response_model=PipelineJobOut, status_code=202)
def start_retraining(
    payload: RetrainRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PipelineJobOut:
    project = db.get(Project, payload.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    if project.status != "active":
        raise ValidationAppError("Archived projects cannot be retrained.")
    deployment = db.get(Deployment, payload.deployment_id)
    if not deployment or deployment.project_id != project.id:
        raise NotFoundError("Deployment not found in this project")
    if deployment.status != "active":
        raise ValidationAppError("Activate the deployment before scheduling retraining.")
    job = queue_retraining(
        db,
        project=project,
        deployment=deployment,
        user=user,
        dataset_version_id=payload.dataset_version_id,
        tune=payload.tune,
        n_trials=payload.n_trials,
        min_new_labels=payload.min_new_labels,
        notes=payload.notes,
        request=request,
    )
    return PipelineJobOut(**serialize_job(db, job))


@router.get("/deployments/{deployment_id}/retraining")
def deployment_retraining_status(
    deployment_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, project = _deployment_access(db, user, deployment_id)
    baseline = db.get(ModelVersion, deployment.model_version_id)
    last = last_successful_retraining(db, deployment.id)
    since = last.finished_at if last else None
    stats = label_stats(db, deployment, since=since)
    active = db.scalar(
        select(PipelineJob)
        .where(
            PipelineJob.deployment_id == deployment.id,
            PipelineJob.job_type == "retraining",
            PipelineJob.status.in_(["queued", "running"]),
        )
        .order_by(PipelineJob.created_at.desc())
        .limit(1)
    )
    recent_jobs = db.scalars(
        select(PipelineJob)
        .where(PipelineJob.deployment_id == deployment.id, PipelineJob.job_type == "retraining")
        .order_by(PipelineJob.created_at.desc())
        .limit(10)
    ).all()
    min_labels = int(
        (deployment.config_json or {}).get("min_label_samples") or settings.default_min_label_samples
    )
    comparison = (last.result_json or {}).get("comparison") if last else None
    return {
        "deployment_id": deployment.id,
        "project_id": project.id,
        "baseline_model_version": {
            "id": baseline.id if baseline else None,
            "version": baseline.version if baseline else None,
            "stage": baseline.stage if baseline else None,
            "metrics": (baseline.metrics_json or {}) if baseline else {},
        },
        "label_stats": stats,
        "min_labels_required": min_labels,
        "label_status": "sufficient" if stats["labels_with_features"] >= min_labels else "insufficient_labels",
        "active_job": serialize_job(db, active) if active else None,
        "last_successful_job": serialize_job(db, last) if last else None,
        "recent_jobs": [serialize_job(db, job) for job in recent_jobs],
        "last_comparison": comparison,
        "approval_required": True,
        "note": (
            "A retrained candidate is registered as pending approval. It is never deployed automatically, "
            "even when its offline metrics improve."
        ),
    }


@router.get("/runs")
def list_workspace_runs(
    project_id: str | None = None,
    status: Literal["running", "succeeded", "failed", "cancelled", "all"] = "all",
    algorithm: str | None = Query(default=None, max_length=80),
    q: str | None = Query(default=None, max_length=200),
    sort: Literal["created_at", "duration_seconds", "name"] = "created_at",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    stmt = (
        select(TrainingRun)
        .join(Project, Project.id == TrainingRun.project_id)
        .where(Project.workspace_id == ctx.workspace.id)
    )
    count_stmt = (
        select(func.count(TrainingRun.id))
        .join(Project, Project.id == TrainingRun.project_id)
        .where(Project.workspace_id == ctx.workspace.id)
    )
    if project_id:
        stmt = stmt.where(TrainingRun.project_id == project_id)
        count_stmt = count_stmt.where(TrainingRun.project_id == project_id)
    if status != "all":
        stmt = stmt.where(TrainingRun.status == status)
        count_stmt = count_stmt.where(TrainingRun.status == status)
    if algorithm:
        stmt = stmt.where(TrainingRun.algorithm == algorithm)
        count_stmt = count_stmt.where(TrainingRun.algorithm == algorithm)
    if q:
        pattern = f"%{q.strip()}%"
        condition = or_(TrainingRun.name.ilike(pattern), TrainingRun.algorithm.ilike(pattern))
        stmt = stmt.where(condition)
        count_stmt = count_stmt.where(condition)
    total = int(db.scalar(count_stmt) or 0)
    column = getattr(TrainingRun, sort)
    runs = db.scalars(
        stmt.order_by(column.desc() if order == "desc" else column.asc()).limit(limit).offset(offset)
    ).all()
    from app.services.serializers import serialize_run

    return {
        "items": [serialize_run(db, run) for run in runs],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


# ------------------------------------------------------------------------- demo


@demo_router.get("/status")
def demo_status(
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    demo_projects = db.scalars(
        select(Project).where(
            Project.workspace_id == ctx.workspace.id,
            Project.name.like("Demo · %"),
        )
    ).all()
    return {
        "demo_mode": settings.demo_mode,
        "simulation_requires_explicit_start": True,
        "sample_datasets": [
            {
                "key": key,
                "name": meta["name"],
                "task_type": meta["task_type"],
                "target_column": meta["target_column"],
                "description": meta["description"],
            }
            for key, meta in SAMPLE_DATASETS.items()
        ],
        "demo_projects": [
            {"id": project.id, "name": project.name, "task_type": project.task_type}
            for project in demo_projects
        ],
        "seeded_project_count": len(demo_projects),
        "note": (
            "Demo datasets are synthetic. Training runs and predictions are real model executions, "
            "but any simulated traffic, labels and alerts are explicitly marked simulated."
        ),
    }


@demo_router.post("/seed", status_code=202)
def seed_demo_workspace(
    payload: DemoSeedRequest,
    request: Request,
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not settings.demo_mode:
        raise ForbiddenError("Demo mode is disabled (DEMO_MODE=false).")
    if not ctx.is_admin:
        raise ForbiddenError("Workspace administrator privileges are required to seed demo projects.")
    task_types = list(dict.fromkeys(payload.task_types))
    result = seed_demo(
        db,
        workspace=ctx.workspace,
        user=ctx.user,
        task_types=task_types,
        queue_training=True,
        request=request,
    )
    result["training_note"] = (
        "Training jobs were queued through the real pipeline. Model versions will require approval before deployment."
    )
    return result


@demo_router.post("/simulate", response_model=PipelineJobOut, status_code=202)
def start_simulation(
    payload: SimulationRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PipelineJobOut:
    if not settings.demo_mode:
        raise ForbiddenError("Demo mode is disabled (DEMO_MODE=false).")
    deployment, _project = _deployment_access(db, user, payload.deployment_id)
    if deployment.status != "active":
        raise ValidationAppError("Activate the deployment before generating simulated traffic.")
    if payload.interval_ms and payload.count * payload.interval_ms > 600_000:
        raise ValidationAppError("The requested simulation would run for more than 10 minutes. Reduce count or interval.")
    job = queue_simulation(
        db,
        deployment=deployment,
        user=user,
        count=payload.count,
        shift=payload.shift,
        provide_labels=payload.provide_labels,
        label_fraction=payload.label_fraction,
        interval_ms=payload.interval_ms,
        request=request,
    )
    return PipelineJobOut(**serialize_job(db, job))
