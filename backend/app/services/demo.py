from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import Any

import numpy as np
import pandas as pd
from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.errors import AppError, ConflictError, NotFoundError, ValidationAppError
from app.models import (
    AlertRule,
    Dataset,
    DatasetVersion,
    Deployment,
    GroundTruthLabel,
    ModelVersion,
    PipelineJob,
    PredictionEvent,
    Project,
    User,
    Workspace,
)
from app.observability import PIPELINE_JOBS
from app.services.audit import record_audit
from app.services.datasets import (
    SAMPLE_DATASETS,
    create_sample_version,
    load_dataset_frame,
)
from app.services.drift import analyze_drift
from app.services.jobs import dispatch_job
from app.services.monitoring import observed_monitoring_metrics
from app.services.prediction import load_bundle_for_deployment, predict_records
from app.services.training import _append_log
from app.utils import jsonable, slugify, utcnow

logger = logging.getLogger(__name__)

DEFAULT_ALERT_RULES = [
    {
        "name": "High data drift share",
        "metric_type": "data_drift_share",
        "comparison": "gt",
        "threshold": 0.3,
        "severity": "high",
        "window_minutes": 1440,
        "cooldown_minutes": 60,
        "min_samples": 50,
        "channels": ["in_app"],
    },
    {
        "name": "Prediction distribution shift",
        "metric_type": "prediction_distribution_psi",
        "comparison": "gt",
        "threshold": 0.2,
        "severity": "warning",
        "window_minutes": 120,
        "cooldown_minutes": 60,
        "min_samples": 30,
        "channels": ["in_app"],
    },
    {
        "name": "Elevated error rate",
        "metric_type": "error_rate",
        "comparison": "gt",
        "threshold": 0.05,
        "severity": "critical",
        "window_minutes": 30,
        "cooldown_minutes": 15,
        "min_samples": 10,
        "channels": ["in_app"],
    },
    {
        "name": "Slow predictions (p95)",
        "metric_type": "latency_p95",
        "comparison": "gt",
        "threshold": 1500.0,
        "severity": "warning",
        "window_minutes": 30,
        "cooldown_minutes": 30,
        "min_samples": 10,
        "channels": ["in_app"],
    },
]


def seed_demo(
    db: Session,
    *,
    workspace: Workspace,
    user: User,
    task_types: list[str] | None = None,
    queue_training: bool = True,
    request: Request | None = None,
) -> dict[str, Any]:
    """Create real projects, sample datasets and alert rules. Training is queued
    through the normal pipeline so every metric shown comes from a real fit."""
    task_types = task_types or ["classification"]
    keys = []
    if "classification" in task_types:
        keys.append("churn-classification")
    if "regression" in task_types:
        keys.append("house-regression")
    if not keys:
        raise ValidationAppError("Select classification, regression, or both for the demo.")
    created: list[dict[str, Any]] = []
    for key in keys:
        meta = SAMPLE_DATASETS[key]
        project_name = f"Demo · {meta['name']}"
        project = db.scalar(
            select(Project).where(
                Project.workspace_id == workspace.id,
                func.lower(Project.name) == project_name.lower(),
            )
        )
        if not project:
            project = Project(
                workspace_id=workspace.id,
                name=project_name,
                slug=slugify(f"{project_name}-{workspace.id[:6]}"),
                description=(
                    "Seeded demo project with synthetic data. Every model, metric and alert is produced by the "
                    "real pipeline; values are explicitly marked as simulated where applicable."
                ),
                task_type=meta["task_type"],
                target_column=meta["target_column"],
                positive_label="1" if meta["task_type"] == "classification" else None,
                config_json={"demo": True},
                created_by=user.id,
            )
            existing_slug = db.scalar(select(Project.id).where(Project.slug == project.slug))
            if existing_slug:
                project.slug = slugify(f"{project_name}-{project.id[:6]}")
            db.add(project)
            db.flush()
            record_audit(
                db,
                workspace_id=workspace.id,
                actor=user,
                action="demo.project_created",
                entity_type="project",
                entity_id=project.id,
                details={"sample": key},
                request=request,
            )

        baseline = db.scalar(
            select(DatasetVersion)
            .join(Dataset, Dataset.id == DatasetVersion.dataset_id)
            .where(
                Dataset.project_id == project.id,
                Dataset.name == meta["name"],
                DatasetVersion.original_filename.like("%baseline%"),
            )
            .order_by(DatasetVersion.version.desc())
            .limit(1)
        )
        if not baseline:
            baseline = create_sample_version(
                db,
                project=project,
                user=user,
                key=key,
                shifted=False,
                is_reference=True,
            )
        shifted = db.scalar(
            select(DatasetVersion)
            .join(Dataset, Dataset.id == DatasetVersion.dataset_id)
            .where(
                Dataset.project_id == project.id,
                Dataset.name == meta["name"],
                DatasetVersion.original_filename.like("%shifted%"),
            )
            .order_by(DatasetVersion.version.desc())
            .limit(1)
        )
        if not shifted:
            shifted = create_sample_version(
                db,
                project=project,
                user=user,
                key=key,
                shifted=True,
                dataset_name=f"{meta['name']} (shifted)",
                is_reference=False,
            )
        rules = []
        for spec in DEFAULT_ALERT_RULES:
            existing = db.scalar(
                select(AlertRule).where(
                    AlertRule.project_id == project.id,
                    AlertRule.metric_type == spec["metric_type"],
                    AlertRule.name == spec["name"],
                )
            )
            if existing:
                rules.append(existing.id)
                continue
            rule = AlertRule(
                workspace_id=workspace.id,
                project_id=project.id,
                name=spec["name"],
                metric_type=spec["metric_type"],
                comparison=spec["comparison"],
                threshold=float(spec["threshold"]),
                window_minutes=int(spec["window_minutes"]),
                severity=spec["severity"],
                enabled=True,
                cooldown_minutes=int(spec["cooldown_minutes"]),
                channels_json=spec["channels"],
                min_samples=int(spec["min_samples"]),
                created_by=user.id,
            )
            db.add(rule)
            db.flush()
            rules.append(rule.id)
        db.commit()

        job = None
        if queue_training:
            active = db.scalar(
                select(PipelineJob).where(
                    PipelineJob.project_id == project.id,
                    PipelineJob.job_type == "training",
                    PipelineJob.status.in_(["queued", "running"]),
                )
            )
            algorithms = (
                ["logistic_regression", "random_forest"]
                if project.task_type == "classification"
                else ["linear_regression", "random_forest_regressor"]
            )
            if active:
                job = active
            else:
                job = PipelineJob(
                    workspace_id=workspace.id,
                    project_id=project.id,
                    job_type="training",
                    status="queued",
                    stage="queued",
                    progress=0,
                    params_json={
                        "project_id": project.id,
                        "dataset_version_id": baseline.id,
                        "algorithms": algorithms,
                        "tune": False,
                        "n_trials": 10,
                        "test_size": 0.2,
                        "random_state": 42,
                        "model_name": f"{meta['name']} demo baseline",
                        "notes": "Seeded demo training run (real fit).",
                        "task_type": project.task_type,
                    },
                    triggered_by=user.id,
                    dedupe_key=f"demo-training:{baseline.id}",
                    max_attempts=2,
                    simulated=True,
                )
                db.add(job)
                db.commit()
                record_audit(
                    db,
                    workspace_id=workspace.id,
                    actor=user,
                    action="demo.training_queued",
                    entity_type="pipeline_job",
                    entity_id=job.id,
                    details={"project_id": project.id, "dataset_version_id": baseline.id},
                    request=request,
                )
                db.commit()
                dispatch_job(job.id)
        created.append(
            {
                "project_id": project.id,
                "project_name": project.name,
                "task_type": project.task_type,
                "target_column": project.target_column,
                "baseline_dataset_version_id": baseline.id,
                "baseline_dataset_rows": baseline.row_count,
                "shifted_dataset_version_id": shifted.id,
                "shifted_dataset_rows": shifted.row_count,
                "alert_rule_ids": rules,
                "training_job_id": job.id if job else None,
                "simulated": True,
            }
        )
    return {
        "items": created,
        "message": (
            "Demo data seeded. Datasets are synthetic; training jobs run the real ML pipeline. "
            "No model is deployed automatically — approve a version and create a deployment."
        ),
        "simulated": True,
    }


def _sample_reference_rows(
    db: Session, bundle: dict[str, Any], version: ModelVersion, count: int, *, shift: bool
) -> pd.DataFrame:
    if not version.dataset_version_id:
        raise ValidationAppError("The deployed model has no reference dataset version for simulation.")
    dataset_version = db.get(DatasetVersion, version.dataset_version_id)
    if not dataset_version:
        raise ValidationAppError("The deployed model's reference dataset no longer exists.")
    frame = load_dataset_frame(dataset_version)
    feature_columns = bundle.get("feature_columns") or []
    missing = [name for name in feature_columns if name not in frame.columns]
    if missing:
        raise ValidationAppError(
            "The reference dataset cannot produce the deployment's feature schema.",
            details={"missing_features": missing[:20]},
        )
    if frame.empty:
        raise ValidationAppError("The reference dataset is empty.")
    sample = frame.sample(n=count, replace=len(frame) < count, random_state=17).reset_index(drop=True)
    if shift:
        schema = {item.get("name"): item for item in (bundle.get("feature_schema") or [])}
        rng = np.random.default_rng(23)
        for column in feature_columns:
            kind = (schema.get(column) or {}).get("kind", "numeric")
            if kind == "numeric":
                numeric = pd.to_numeric(frame[column], errors="coerce")
                std = float(numeric.std() or 0.0)
                if std > 0:
                    noise = rng.normal(0, std * 0.25, len(sample))
                    sample[column] = pd.to_numeric(sample[column], errors="coerce") + std * 1.1 + noise
            elif kind == "categorical" and sample[column].notna().any():
                choices = [value for value in frame[column].dropna().unique().tolist() if isinstance(value, (str, int, float))]
                if len(choices) > 1:
                    mask = rng.random(len(sample)) < 0.65
                    replacements = rng.choice(choices, size=int(mask.sum()), replace=True)
                    sample.loc[mask, column] = replacements
    return sample


def run_simulation_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(PipelineJob, job_id)
        if not job:
            logger.error("simulation_job_missing", extra={"extra_fields": {"job_id": job_id}})
            return
        if job.status == "cancelled":
            return
        params = job.params_json or {}
        deployment = db.get(Deployment, params.get("deployment_id"))
        if not deployment:
            job.status = "failed"
            job.error = "Deployment no longer exists."
            job.finished_at = utcnow()
            db.commit()
            return
        project = db.get(Project, deployment.project_id)
        user = db.get(User, job.triggered_by)
        if not project:
            job.status = "failed"
            job.error = "Project no longer exists."
            job.finished_at = utcnow()
            db.commit()
            return
        job.status = "running"
        job.started_at = utcnow()
        job.attempts += 1
        job.stage = "generating_traffic"
        job.progress = 5
        _append_log(
            job,
            f"Simulation started for deployment '{deployment.name}'. "
            f"All generated predictions and labels are marked simulated=True.",
        )
        db.commit()

        count = max(1, min(int(params.get("count", 50)), 2000))
        shift = bool(params.get("shift", True))
        provide_labels = bool(params.get("provide_labels", True))
        label_fraction = float(params.get("label_fraction", 0.8))
        interval_ms = max(0, min(int(params.get("interval_ms", 0)), 5000))
        bundle, version, _model, _project = load_bundle_for_deployment(db, deployment)
        if deployment.status != "active":
            raise AppError(409, "deployment_inactive", "Activate the deployment before generating traffic.")
        sample = _sample_reference_rows(db, bundle, version, count, shift=shift)
        feature_columns = bundle["feature_columns"]
        target_column = bundle.get("target_column") or project.target_column
        targets = sample[target_column].tolist() if target_column in sample.columns else [None] * len(sample)
        records = []
        for _, row in sample[feature_columns].iterrows():
            record = {}
            for name in feature_columns:
                value = row[name]
                try:
                    missing = bool(pd.isna(value))
                except (TypeError, ValueError):
                    missing = False
                record[name] = None if missing else jsonable(value)
            records.append(record)

        end = utcnow()
        window = timedelta(minutes=120)
        prediction_ids: list[str] = []
        labelled = 0
        rng = np.random.default_rng(31)
        simulation_start = time.perf_counter()
        for index, record in enumerate(records):
            timestamp = end - window + window * (index / max(1, count))
            try:
                results = predict_records(
                    db,
                    deployment=deployment,
                    records=[record],
                    return_probabilities=True,
                    simulated=True,
                    timestamp=timestamp,
                    persist=True,
                    is_batch=False,
                )
            except Exception as exc:
                logger.warning("simulation_prediction_failed", exc_info=True, extra={"extra_fields": {"index": index}})
                _append_log(job, f"Prediction {index + 1} failed: {str(exc)[:300]}")
                db.commit()
                if index == 0:
                    raise
                continue
            result = results[0]
            prediction_ids.append(result["request_id"])
            event = db.scalar(select(PredictionEvent).where(PredictionEvent.request_id == result["request_id"]))
            target_value = targets[index]
            try:
                target_missing = bool(pd.isna(target_value))
            except (TypeError, ValueError):
                target_missing = target_value is None
            if (
                event
                and provide_labels
                and not target_missing
                and rng.random() < label_fraction
            ):
                label_payload = {
                    "value": jsonable(target_value),
                    "source": "demo_simulation",
                    "note": (
                        "Synthetic label taken from the sampled reference row. "
                        "For shifted simulations this is not a counterfactual outcome."
                    ),
                }
                db.add(
                    GroundTruthLabel(
                        prediction_event_id=event.id,
                        deployment_id=deployment.id,
                        project_id=project.id,
                        model_version_id=version.id,
                        label_json=jsonable(label_payload),
                        label_value=str(target_value)[:160],
                        prediction_at=timestamp,
                        received_at=utcnow(),
                        label_source="demo",
                        simulated=True,
                    )
                )
                event.labels_available = True
                labelled += 1
            if index % 10 == 0 or index == count - 1:
                job.progress = 5 + int((index + 1) / count * 80)
                db.commit()
            if interval_ms:
                time.sleep(interval_ms / 1000.0)
        job.stage = "evaluating_alerts"
        job.progress = 88
        _append_log(
            job,
            f"Generated {len(prediction_ids):,} predictions and {labelled:,} simulated ground-truth labels "
            f"in {time.perf_counter() - simulation_start:.1f}s.",
        )
        db.commit()

        alert_ids: list[str] = []
        try:
            observed, counts, simulated_count = observed_monitoring_metrics(
                db, deployment=deployment, window_minutes=180
            )
            from app.services.alerts import evaluate_rules

            alerts = evaluate_rules(
                db,
                project=project,
                deployment=deployment,
                observed=observed,
                context={"source": "demo_simulation", "window_minutes": 180},
                sample_counts=counts,
                simulated=True,
            )
            alert_ids.extend(alert.id for alert in alerts)
        except Exception:
            logger.exception("simulation_alert_evaluation_failed")
            _append_log(job, "Alert evaluation failed; predictions were still recorded.")

        drift_report_id = None
        if shift and len(prediction_ids) >= 20 and version.dataset_version_id:
            try:
                from app.models import DatasetVersion

                reference_version = db.get(DatasetVersion, version.dataset_version_id)
                if reference_version:
                    report = analyze_drift(
                        db,
                        project=project,
                        reference_version=reference_version,
                        deployment=deployment,
                        current_version=None,
                        window_start=end - timedelta(minutes=180),
                        window_end=utcnow(),
                        actor_id=job.triggered_by,
                    )
                    drift_report_id = report.id
                    _append_log(
                        job,
                        f"Drift analysis completed with severity '{report.severity}' and drift share "
                        f"{report.drift_share:.2%}.",
                    )
            except Exception:
                logger.exception("simulation_drift_analysis_failed")
                _append_log(job, "Drift analysis failed; predictions and labels remain available.")

        job.result_json = {
            "deployment_id": deployment.id,
            "predictions_created": len(prediction_ids),
            "labels_created": labelled,
            "label_fraction": label_fraction,
            "shifted": shift,
            "drift_report_id": drift_report_id,
            "alert_ids": sorted(set(alert_ids)),
            "duration_seconds": round(time.perf_counter() - simulation_start, 2),
            "simulated": True,
            "note": (
                "Synthetic traffic generated at your request. Predictions, labels and resulting alerts are "
                "marked simulated and must not be interpreted as production behavior."
            ),
        }
        job.status = "succeeded"
        job.stage = "complete"
        job.progress = 100
        job.finished_at = utcnow()
        _append_log(job, "Simulation completed. Simulated data is labelled throughout the UI and API.")
        db.commit()
        record_audit(
            db,
            workspace_id=project.workspace_id,
            actor=user,
            action="demo.simulation_completed",
            entity_type="pipeline_job",
            entity_id=job.id,
            details=job.result_json,
        )
        db.commit()
        PIPELINE_JOBS.labels("simulation", "succeeded").inc()
    except Exception as exc:
        logger.exception("simulation_job_failed")
        db.rollback()
        job = db.get(PipelineJob, job_id)
        if job:
            job.status = "failed"
            job.stage = "failed"
            job.error = str(exc)[:4000]
            _append_log(job, f"Simulation failed: {str(exc)[:2000]}")
            job.finished_at = utcnow()
            db.commit()
        PIPELINE_JOBS.labels("simulation", "failed").inc()
    finally:
        db.close()


def queue_simulation(
    db: Session,
    *,
    deployment: Deployment,
    user: User,
    count: int,
    shift: bool,
    provide_labels: bool,
    label_fraction: float,
    interval_ms: int,
    request: Request | None = None,
) -> PipelineJob:
    project = db.get(Project, deployment.project_id)
    if not project:
        raise NotFoundError("Project not found")
    active = db.scalar(
        select(PipelineJob).where(
            PipelineJob.deployment_id == deployment.id,
            PipelineJob.job_type == "simulation",
            PipelineJob.status.in_(["queued", "running"]),
        )
    )
    if active:
        raise ConflictError("A simulation is already running for this deployment.", {"job_id": active.id})
    job = PipelineJob(
        workspace_id=project.workspace_id,
        project_id=project.id,
        deployment_id=deployment.id,
        job_type="simulation",
        status="queued",
        stage="queued",
        params_json={
            "deployment_id": deployment.id,
            "count": count,
            "shift": shift,
            "provide_labels": provide_labels,
            "label_fraction": label_fraction,
            "interval_ms": interval_ms,
        },
        triggered_by=user.id,
        dedupe_key=f"simulation:{deployment.id}",
        simulated=True,
    )
    db.add(job)
    db.commit()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="demo.simulation_started",
        entity_type="pipeline_job",
        entity_id=job.id,
        details={"deployment_id": deployment.id, "count": count, "shift": shift, "simulated": True},
        request=request,
    )
    db.commit()
    dispatch_job(job.id)
    return job
