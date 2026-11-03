from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import ProjectContext, get_current_user, get_project_context, project_context_for_user
from app.errors import ConflictError, NotFoundError, ValidationAppError
from app.models import (
    Experiment,
    PipelineJob,
    Project,
    TrainingRun,
    User,
)
from app.schemas import (
    CompareRequest,
    ExperimentOut,
    PipelineJobOut,
    TrainingRunOut,
    TrainRequest,
)
from app.services.audit import record_audit
from app.services.datasets import get_dataset_version
from app.services.jobs import dispatch_job
from app.services.mlflow_tracker import tracker
from app.services.serializers import serialize_experiment, serialize_job, serialize_run
from app.services.training import ALGORITHM_CATALOG, get_algorithm_catalog

router = APIRouter(tags=["experiments"])


def _run_context(db: Session, user: User, run_id: str) -> tuple[TrainingRun, Project]:
    run = db.get(TrainingRun, run_id)
    if not run:
        raise NotFoundError("Training run not found")
    project = db.get(Project, run.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    return run, project


def _active_training_job(db: Session, project_id: str) -> PipelineJob | None:
    return db.scalar(
        select(PipelineJob)
        .where(
            PipelineJob.project_id == project_id,
            PipelineJob.job_type.in_(["training", "retraining"]),
            PipelineJob.status.in_(["queued", "running"]),
        )
        .order_by(PipelineJob.created_at.desc())
        .limit(1)
    )


@router.get("/projects/{project_id}/algorithms")
def algorithms(
    ctx: ProjectContext = Depends(get_project_context),
) -> dict[str, Any]:
    return {
        "task_type": ctx.project.task_type,
        "algorithms": get_algorithm_catalog(ctx.project.task_type),
    }


@router.post("/projects/{project_id}/train", response_model=PipelineJobOut, status_code=202)
def start_training(
    payload: TrainRequest,
    request: Request,
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> PipelineJobOut:
    if ctx.project.status != "active":
        raise ValidationAppError("Archived projects cannot start training.")
    if not ctx.project.target_column:
        raise ValidationAppError("Set the project's target column before training.")
    version = get_dataset_version(db, payload.dataset_version_id, ctx.project.id)
    target_present = any(
        column.get("name") == ctx.project.target_column for column in (version.schema_json or [])
    )
    if not target_present:
        raise ValidationAppError(
            f"The dataset does not contain the target column '{ctx.project.target_column}'."
        )
    if version.row_count < 50:
        raise ValidationAppError("At least 50 rows are required to train a model.")
    active = _active_training_job(db, ctx.project.id)
    if active:
        raise ConflictError(
            "A training or retraining job is already running for this project.",
            {"job_id": active.id},
        )
    algorithms_list = payload.algorithms or list(ALGORITHM_CATALOG.get(ctx.project.task_type, {}).keys())
    for algorithm in algorithms_list:
        if algorithm not in ALGORITHM_CATALOG.get(ctx.project.task_type, {}):
            raise ValidationAppError(f"Algorithm '{algorithm}' is not supported for {ctx.project.task_type}.")
    job = PipelineJob(
        workspace_id=ctx.project.workspace_id,
        project_id=ctx.project.id,
        job_type="training",
        status="queued",
        stage="queued",
        progress=0,
        params_json={
            "project_id": ctx.project.id,
            "dataset_version_id": version.id,
            "algorithms": list(dict.fromkeys(algorithms_list)),
            "tune": payload.tune,
            "n_trials": payload.n_trials,
            "test_size": payload.test_size,
            "random_state": payload.random_state,
            "model_name": payload.model_name,
            "notes": payload.notes,
            "task_type": ctx.project.task_type,
        },
        triggered_by=ctx.workspace_ctx.user.id,
        dedupe_key=f"training:{version.id}",
        max_attempts=2,
    )
    db.add(job)
    db.flush()
    record_audit(
        db,
        workspace_id=ctx.project.workspace_id,
        actor=ctx.workspace_ctx.user,
        action="training.queued",
        entity_type="pipeline_job",
        entity_id=job.id,
        details={
            "project_id": ctx.project.id,
            "dataset_version_id": version.id,
            "algorithms": job.params_json["algorithms"],
            "tune": payload.tune,
        },
        request=request,
    )
    db.commit()
    dispatch_job(job.id)
    return PipelineJobOut(**serialize_job(db, job))


@router.get("/projects/{project_id}/experiments", response_model=list[ExperimentOut])
def list_experiments(
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> list[ExperimentOut]:
    experiments = db.scalars(
        select(Experiment).where(Experiment.project_id == ctx.project.id).order_by(Experiment.created_at)
    ).all()
    return [ExperimentOut(**serialize_experiment(db, experiment)) for experiment in experiments]


@router.get("/projects/{project_id}/runs")
def list_runs(
    q: str | None = Query(default=None, max_length=200),
    algorithm: str | None = Query(default=None, max_length=80),
    status: Literal["running", "succeeded", "failed", "cancelled"] | None = None,
    sort: Literal["created_at", "duration_seconds", "name"] = "created_at",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    stmt = select(TrainingRun).where(TrainingRun.project_id == ctx.project.id)
    count_stmt = select(func.count(TrainingRun.id)).where(TrainingRun.project_id == ctx.project.id)
    if q:
        pattern = f"%{q.strip()}%"
        condition = TrainingRun.name.ilike(pattern)
        stmt = stmt.where(condition)
        count_stmt = count_stmt.where(condition)
    if algorithm:
        stmt = stmt.where(TrainingRun.algorithm == algorithm)
        count_stmt = count_stmt.where(TrainingRun.algorithm == algorithm)
    if status:
        stmt = stmt.where(TrainingRun.status == status)
        count_stmt = count_stmt.where(TrainingRun.status == status)
    total = int(db.scalar(count_stmt) or 0)
    column = getattr(TrainingRun, sort)
    stmt = stmt.order_by(column.desc() if order == "desc" else column.asc()).limit(limit).offset(offset)
    runs = db.scalars(stmt).all()
    return {
        "items": [serialize_run(db, run) for run in runs],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/runs/{run_id}", response_model=TrainingRunOut)
def get_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrainingRunOut:
    run, _project = _run_context(db, user, run_id)
    return TrainingRunOut(**serialize_run(db, run))


@router.get("/runs/{run_id}/artifacts")
def run_artifacts(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    run, _project = _run_context(db, user, run_id)
    artifacts: list[dict[str, Any]] = []
    warning = None
    if run.mlflow_run_id and settings.mlflow_enabled:
        try:
            def collect(path: str, depth: int) -> None:
                if len(artifacts) >= 1000:
                    return
                for item in tracker.client.list_artifacts(run.mlflow_run_id, path):
                    if getattr(item, "is_dir", False):
                        if depth < 4:
                            collect(item.path, depth + 1)
                        continue
                    artifacts.append(
                        {
                            "path": item.path,
                            "is_dir": False,
                            "file_size": getattr(item, "file_size", None),
                        }
                    )

            collect("", 0)
        except Exception as exc:
            warning = f"MLflow artifacts could not be listed: {str(exc)[:200]}"
    elif not run.mlflow_run_id:
        warning = "This run has no MLflow run id. MLflow may have been unavailable during training."
    return {
        "run_id": run.id,
        "mlflow_run_id": run.mlflow_run_id,
        "mlflow_ui_url": settings.mlflow_ui_url or None,
        "run_link": tracker.run_link(run.mlflow_run_id),
        "artifacts": artifacts,
        "warning": warning,
    }


@router.post("/runs/compare")
def compare_runs(
    payload: CompareRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    runs: list[TrainingRun] = []
    project_id = None
    for run_id in payload.run_ids:
        run, project = _run_context(db, user, run_id)
        if project_id and project.id != project_id:
            raise ValidationAppError("All runs in a comparison must belong to the same project.")
        project_id = project.id
        runs.append(run)
    project = db.get(Project, project_id)
    assert project is not None
    metric_names: set[str] = set()
    for run in runs:
        metric_names.update((run.metrics_json or {}).keys())
    numeric_metrics = sorted(
        name
        for name in metric_names
        if all(
            isinstance((run.metrics_json or {}).get(name), (int, float))
            and not isinstance((run.metrics_json or {}).get(name), bool)
            for run in runs
        )
    )
    primary = "roc_auc" if project.task_type == "classification" else "rmse"
    if primary not in numeric_metrics:
        primary = "f1_macro" if project.task_type == "classification" else "r2"
    best_run = None
    if primary in numeric_metrics:
        if project.task_type == "classification":
            best_run = max(runs, key=lambda run: float((run.metrics_json or {}).get(primary) or -1))
        else:
            best_run = min(
                runs,
                key=lambda run: float((run.metrics_json or {}).get(primary) or float("inf")),
            )
    baseline = runs[0]
    comparisons: dict[str, dict[str, float | None]] = {}
    for run in runs:
        deltas: dict[str, float | None] = {}
        for metric in numeric_metrics:
            base_value = (baseline.metrics_json or {}).get(metric)
            value = (run.metrics_json or {}).get(metric)
            if base_value is None or value is None:
                deltas[metric] = None
            else:
                deltas[metric] = round(float(value) - float(base_value), 6)
        comparisons[run.id] = deltas
    return {
        "project_id": project.id,
        "project_name": project.name,
        "task_type": project.task_type,
        "primary_metric": primary,
        "higher_is_better": project.task_type == "classification",
        "best_run_id": best_run.id if best_run else None,
        "baseline_run_id": baseline.id,
        "metric_names": numeric_metrics,
        "comparisons": comparisons,
        "runs": [serialize_run(db, run) for run in runs],
        "git_commits": {run.id: run.git_commit for run in runs},
    }


@router.get("/runs/{run_id}/mlflow")
def run_mlflow_link(
    run_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    run, _project = _run_context(db, user, run_id)
    return {
        "mlflow_run_id": run.mlflow_run_id,
        "mlflow_ui_url": settings.mlflow_ui_url or None,
        "run_link": tracker.run_link(run.mlflow_run_id),
    }
