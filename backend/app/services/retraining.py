from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any

import pandas as pd
from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.errors import AppError, ConflictError, NotFoundError, ValidationAppError
from app.models import (
    DatasetVersion,
    Deployment,
    FeatureSample,
    GroundTruthLabel,
    ModelVersion,
    PipelineJob,
    PredictionEvent,
    Project,
    User,
)
from app.observability import PIPELINE_JOBS
from app.services.audit import record_audit
from app.services.datasets import (
    create_dataset_version,
    load_dataset_frame,
)
from app.services.jobs import dispatch_job
from app.services.training import (
    _append_log,
    _metric_value,
    run_training_job,
    update_job,
)
from app.utils import ensure_utc, jsonable, utcnow

logger = logging.getLogger(__name__)

MIN_RETRAINING_ROWS = 50


def _active_job_exists(db: Session, deployment_id: str) -> PipelineJob | None:
    return db.scalar(
        select(PipelineJob)
        .where(
            PipelineJob.deployment_id == deployment_id,
            PipelineJob.job_type == "retraining",
            PipelineJob.status.in_(["queued", "running"]),
        )
        .order_by(PipelineJob.created_at.desc())
        .limit(1)
    )


def last_successful_retraining(db: Session, deployment_id: str) -> PipelineJob | None:
    return db.scalar(
        select(PipelineJob)
        .where(
            PipelineJob.deployment_id == deployment_id,
            PipelineJob.job_type == "retraining",
            PipelineJob.status == "succeeded",
        )
        .order_by(PipelineJob.finished_at.desc())
        .limit(1)
    )


def label_stats(db: Session, deployment: Deployment, since: datetime | None = None) -> dict[str, Any]:
    """Count labels available for retraining, including feature-sample coverage."""
    stmt = (
        select(func.count(GroundTruthLabel.id))
        .join(PredictionEvent, PredictionEvent.id == GroundTruthLabel.prediction_event_id)
        .where(GroundTruthLabel.deployment_id == deployment.id)
    )
    if since is not None:
        stmt = stmt.where(GroundTruthLabel.received_at > since)
    labelled = int(db.scalar(stmt) or 0)

    covered_stmt = (
        select(func.count(func.distinct(GroundTruthLabel.id)))
        .join(PredictionEvent, PredictionEvent.id == GroundTruthLabel.prediction_event_id)
        .join(FeatureSample, FeatureSample.prediction_event_id == PredictionEvent.id)
        .where(GroundTruthLabel.deployment_id == deployment.id)
    )
    if since is not None:
        covered_stmt = covered_stmt.where(GroundTruthLabel.received_at > since)
    covered = int(db.scalar(covered_stmt) or 0)
    latest = db.scalar(
        select(func.max(GroundTruthLabel.received_at)).where(
            GroundTruthLabel.deployment_id == deployment.id
        )
    )
    return {
        "labelled_events": labelled,
        "labels_with_features": covered,
        "feature_coverage": round(covered / labelled, 4) if labelled else 0.0,
        "latest_label_at": ensure_utc(latest).isoformat() if latest else None,
        "counted_since": ensure_utc(since).isoformat() if since else None,
    }


def queue_retraining(
    db: Session,
    *,
    project: Project,
    deployment: Deployment,
    user: User,
    dataset_version_id: str | None = None,
    tune: bool = False,
    n_trials: int = 10,
    min_new_labels: int = 30,
    notes: str = "",
    request: Request | None = None,
) -> PipelineJob:
    """Create a deduplicated retraining job. Label sufficiency is checked again
    when the job executes, so a stale request cannot train on missing labels."""
    if deployment.project_id != project.id:
        raise ValidationAppError("The deployment does not belong to this project.")
    active = _active_job_exists(db, deployment.id)
    if active:
        raise ConflictError(
            "A retraining job is already queued or running for this deployment.",
            {"job_id": active.id, "status": active.status},
        )
    last = last_successful_retraining(db, deployment.id)
    if last and last.finished_at and utcnow() - ensure_utc(last.finished_at) < timedelta(seconds=30):
        raise ConflictError(
            "A retraining job for this deployment completed moments ago. "
            "Add new labelled data or wait before retraining again.",
            {"job_id": last.id},
        )
    if dataset_version_id:
        version = db.get(DatasetVersion, dataset_version_id)
        if not version:
            raise NotFoundError("Dataset version not found")
        from app.models import Dataset

        dataset = db.get(Dataset, version.dataset_id)
        if not dataset or dataset.project_id != project.id:
            raise NotFoundError("Dataset version not found in this project")

    baseline = db.get(ModelVersion, deployment.model_version_id)
    if not baseline:
        raise NotFoundError("The deployment's model version no longer exists.")

    params = {
        "project_id": project.id,
        "deployment_id": deployment.id,
        "baseline_model_version_id": baseline.id,
        "dataset_version_id": dataset_version_id,
        "tune": tune,
        "n_trials": n_trials,
        "min_new_labels": max(1, int(min_new_labels)),
        "notes": notes[:2000],
        "task_type": project.task_type,
        "requested_at": utcnow().isoformat(),
    }
    job = PipelineJob(
        workspace_id=project.workspace_id,
        project_id=project.id,
        deployment_id=deployment.id,
        job_type="retraining",
        status="queued",
        stage="queued",
        progress=0,
        params_json=params,
        triggered_by=user.id,
        dedupe_key=f"retrain:{deployment.id}",
        max_attempts=2,
        logs="",
    )
    db.add(job)
    db.flush()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="retraining.queued",
        entity_type="pipeline_job",
        entity_id=job.id,
        details={
            "deployment_id": deployment.id,
            "baseline_model_version_id": baseline.id,
            "dataset_version_id": dataset_version_id,
            "tune": tune,
            "n_trials": n_trials,
            "min_new_labels": min_new_labels,
            "notes": notes[:500],
        },
        request=request,
    )
    db.commit()
    db.refresh(job)
    dispatch_job(job.id)
    return job


def _build_monitored_training_frame(
    db: Session,
    *,
    deployment: Deployment,
    version: ModelVersion,
    baseline_frame: pd.DataFrame,
    since: datetime | None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    target = version.params_json.get("target_column") or baseline_frame.attrs.get("target")
    if not target:
        project = db.get(Project, deployment.project_id)
        target = project.target_column if project else None
    if not target or target not in baseline_frame.columns:
        raise ValidationAppError(
            "The reference dataset does not contain the project's target column, so monitored labels cannot be joined."
        )
    required_features = [
        field.get("name")
        for field in (version.feature_schema_json or [])
        if field.get("name")
    ]
    if not required_features:
        raise ValidationAppError("The deployed model has no recorded feature schema; retraining cannot validate new data.")

    rows = db.execute(
        select(GroundTruthLabel, FeatureSample)
        .join(PredictionEvent, PredictionEvent.id == GroundTruthLabel.prediction_event_id)
        .join(FeatureSample, FeatureSample.prediction_event_id == PredictionEvent.id)
        .where(
            GroundTruthLabel.deployment_id == deployment.id,
            GroundTruthLabel.received_at > since if since else True,
        )
        .order_by(GroundTruthLabel.received_at.asc())
        .limit(100_000)
    ).all()

    new_rows: list[dict[str, Any]] = []
    skipped_missing = 0
    skipped_duplicate = 0
    seen: set[str] = set()
    for label, sample in rows:
        features = sample.features_json or {}
        if any(name not in features for name in required_features):
            skipped_missing += 1
            continue
        payload = label.label_json or {}
        label_value = payload.get("value", payload.get("label", label.label_value))
        if label_value is None:
            skipped_missing += 1
            continue
        key = json.dumps(
            {name: jsonable(features.get(name)) for name in required_features + [target]},
            sort_keys=True,
            default=str,
        )
        if key in seen:
            skipped_duplicate += 1
            continue
        seen.add(key)
        row = {name: features.get(name) for name in required_features}
        row[target] = label_value
        new_rows.append(row)

    if not new_rows:
        raise ValidationAppError(
            "No labelled predictions with captured feature values are available for retraining. "
            "Labels are only usable when monitoring captured the corresponding non-PII features.",
            details={"labelled_with_features": 0, "skipped_missing_features": skipped_missing},
        )

    new_frame = pd.DataFrame(new_rows)
    if deployment.project_id:
        project = db.get(Project, deployment.project_id)
        if project and project.task_type == "regression":
            new_frame[target] = pd.to_numeric(new_frame[target], errors="coerce")
            new_frame = new_frame[new_frame[target].notna()]
    else:
        project = None
    baseline = baseline_frame.copy()
    # Ensure the columns used by the deployed model are present before training.
    missing_features = [name for name in required_features if name not in new_frame.columns]
    if missing_features:
        raise ValidationAppError(
            "Captured monitoring features are missing columns required by the deployed model.",
            details={"missing_features": missing_features[:20]},
        )
    if project and project.task_type == "classification":
        known_labels = set(str(v) for v in baseline[target].dropna().astype(str).unique())
        new_frame[target] = new_frame[target].astype(str).str.strip()
        unknown = sorted(set(new_frame[target].unique()) - known_labels)
        if unknown:
            raise ValidationAppError(
                "New labels contain classes that were not present in the reference dataset.",
                details={"unknown_labels": unknown[:20], "known_labels": sorted(known_labels)[:20]},
            )
    if len(new_frame) < 10:
        raise ValidationAppError(
            "Fewer than 10 usable new labelled rows remain after validation.", details={"usable_rows": len(new_frame)}
        )
    combined = pd.concat([baseline, new_frame], ignore_index=True, sort=False)
    # Keep the reference schema stable; unseen columns from monitored payloads are not model inputs.
    combined = combined[[column for column in baseline.columns if column in combined.columns]]
    stats = {
        "new_rows": len(new_frame),
        "skipped_missing_features": skipped_missing,
        "skipped_duplicates": skipped_duplicate,
        "reference_rows": len(baseline),
        "combined_rows": len(combined),
        "counted_since": ensure_utc(since).isoformat() if since else None,
    }
    return combined, stats


def _baseline_reference_version(
    db: Session, deployment: Deployment, baseline: ModelVersion, requested_id: str | None
) -> DatasetVersion:
    version_id = requested_id or deployment.config_json.get("reference_dataset_version_id") or baseline.dataset_version_id
    if not version_id:
        raise ValidationAppError(
            "No reference dataset is linked to this model or deployment. Select a dataset version for retraining."
        )
    version = db.get(DatasetVersion, version_id)
    if not version:
        raise NotFoundError("Reference dataset version not found")
    from app.models import Dataset

    dataset = db.get(Dataset, version.dataset_id)
    if not dataset or dataset.project_id != deployment.project_id:
        raise NotFoundError("Reference dataset version does not belong to this project")
    return version


def _comparison_metric(
    project: Project,
    baseline_metrics: dict[str, Any],
    candidate_metrics: dict[str, Any],
) -> tuple[str, str]:
    """Pick the metric used to compare a retrained candidate with the baseline.

    Regression comparisons use RMSE/MAE when available because relative error
    reduction is the operationally meaningful comparison. R² remains the
    validation-gate metric, but comparing candidates on R² alone is misleading
    when its baseline is near zero. The direction is returned explicitly so the
    recommendation logic never has to assume "higher is better".
    """
    if project.task_type == "classification":
        for name in ("roc_auc", "f1_macro"):
            if _metric_value(baseline_metrics, name) is not None and _metric_value(
                candidate_metrics, name
            ) is not None:
                return name, "higher"
        return "f1_macro", "higher"
    for name in ("rmse", "mae"):
        if _metric_value(baseline_metrics, name) is not None and _metric_value(
            candidate_metrics, name
        ) is not None:
            return name, "lower"
    if _metric_value(baseline_metrics, "r2") is not None and _metric_value(
        candidate_metrics, "r2"
    ) is not None:
        return "r2", "higher"
    return "rmse", "lower"


def _compare_candidate(
    project: Project,
    baseline_metrics: dict[str, Any],
    candidate_metrics: dict[str, Any],
    validation: dict[str, Any],
) -> dict[str, Any]:
    policy = (project.config_json or {}).get("promotion_policy", {}) or {}
    metric_name, direction = _comparison_metric(project, baseline_metrics, candidate_metrics)
    baseline_value = _metric_value(baseline_metrics, metric_name)
    candidate_value = _metric_value(candidate_metrics, metric_name)
    deltas: dict[str, Any] = {}
    for key in {
        "accuracy",
        "precision",
        "recall",
        "f1_macro",
        "roc_auc",
        "mae",
        "rmse",
        "r2",
    }:
        b = _metric_value(baseline_metrics, key)
        c = _metric_value(candidate_metrics, key)
        if b is not None and c is not None:
            deltas[key] = round(c - b, 6)

    if baseline_value is None or candidate_value is None:
        recommendation = "needs_review"
        reason = "A comparable primary metric was unavailable for one of the models."
    else:
        if project.task_type == "classification":
            min_delta = float(policy.get("retrain_min_improvement", 0.005))
            improvement = candidate_value - baseline_value
            materially_better = improvement >= min_delta
            reason = (
                f"{metric_name} moved from {baseline_value:.4f} to {candidate_value:.4f} "
                f"({improvement:+.4f}); the required improvement is {min_delta:.4f}."
            )
        else:
            min_relative = float(policy.get("retrain_min_relative_improvement", 0.02))
            if direction == "lower":
                improvement = (
                    (baseline_value - candidate_value) / abs(baseline_value)
                    if abs(baseline_value) > 1e-12
                    else 0.0
                )
            else:
                improvement = (
                    (candidate_value - baseline_value) / abs(baseline_value)
                    if abs(baseline_value) > 1e-12
                    else candidate_value - baseline_value
                )
            materially_better = improvement >= min_relative
            reason = (
                f"{metric_name} moved from {baseline_value:.4f} to {candidate_value:.4f} "
                f"({improvement:+.2%} relative improvement); the required relative improvement "
                f"is {min_relative:.2%}."
            )
        if validation.get("status") == "failed":
            recommendation = "reject_candidate"
            reason = "The candidate failed validation gates. " + reason
        elif validation.get("status") == "warning":
            recommendation = "needs_review"
            reason = "The candidate passed with warnings; manual review is required. " + reason
        elif materially_better:
            recommendation = "promote_candidate"
            reason = "The candidate materially outperforms the deployed baseline. " + reason
        else:
            recommendation = "keep_baseline"
            reason = "The candidate does not materially outperform the deployed baseline. " + reason

    return {
        "baseline_model_version_id": None,
        "candidate_model_version_id": None,
        "primary_metric": metric_name,
        "baseline_value": baseline_value,
        "candidate_value": candidate_value,
        "metric_deltas": deltas,
        "recommendation": recommendation,
        "reason": reason,
        "approval_required": True,
        "auto_promoted": False,
        "evaluated_at": utcnow().isoformat(),
    }


def _fail_job(db: Session, job: PipelineJob, message: str, *, count_attempt: bool) -> None:
    job = db.get(PipelineJob, job.id) or job
    if count_attempt:
        job.attempts = int(job.attempts or 0) + 1
    job.status = "failed"
    job.stage = "failed"
    job.error = message[:4000]
    _append_log(job, f"Retraining failed: {message[:2000]}")
    job.finished_at = utcnow()
    db.commit()


def run_retraining_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(PipelineJob, job_id)
        if not job:
            logger.error("retraining_job_missing", extra={"extra_fields": {"job_id": job_id}})
            return
        if job.status == "cancelled":
            return
        params = job.params_json or {}
        project = db.get(Project, params.get("project_id"))
        deployment = db.get(Deployment, params.get("deployment_id"))
        baseline = db.get(ModelVersion, params.get("baseline_model_version_id") or "")
        if not project or not deployment or not baseline:
            _fail_job(db, job, "Project, deployment or baseline model version no longer exists.", count_attempt=True)
            return
        if deployment.model_version_id != baseline.id:
            # Deployment changed while this job was queued; do not compare against a stale baseline.
            db.rollback()
            params = {**params, "baseline_model_version_id": deployment.model_version_id}
            job.params_json = params
            baseline = db.get(ModelVersion, deployment.model_version_id)
            if not baseline:
                _fail_job(db, job, "The deployment's current model version no longer exists.", count_attempt=True)
                return
            db.commit()

        job.status = "running"
        job.started_at = job.started_at or utcnow()
        job.stage = "checking_labels"
        job.progress = 4
        _append_log(job, "Retraining job started. Checking label sufficiency and data quality.")
        db.commit()

        last_success = last_successful_retraining(db, deployment.id)
        since = ensure_utc(last_success.finished_at) if last_success and last_success.id != job.id else None
        stats = label_stats(db, deployment, since)
        job.result_json = {"label_stats": stats}
        db.commit()
        min_new_labels = int(params.get("min_new_labels", 30))
        explicit_dataset_id = params.get("dataset_version_id")
        if not explicit_dataset_id and stats["labels_with_features"] < min_new_labels:
            _fail_job(
                db,
                job,
                f"Insufficient labels: {stats['labels_with_features']} usable labelled predictions with captured "
                f"features are available since {stats['counted_since'] or 'deployment start'}, but at least "
                f"{min_new_labels} are required. Submit ground-truth labels and retry.",
                count_attempt=True,
            )
            record_audit(
                db,
                workspace_id=project.workspace_id,
                actor=db.get(User, job.triggered_by),
                action="retraining.insufficient_labels",
                entity_type="pipeline_job",
                entity_id=job.id,
                details={"deployment_id": deployment.id, **stats, "min_new_labels": min_new_labels},
            )
            db.commit()
            PIPELINE_JOBS.labels("retraining", "failed").inc()
            return

        job.stage = "building_dataset"
        job.progress = 10
        reference = _baseline_reference_version(db, deployment, baseline, explicit_dataset_id)
        reference_frame = load_dataset_frame(reference)
        target_column = project.target_column
        if target_column and target_column not in reference_frame.columns:
            raise ValidationAppError(
                f"Reference dataset does not contain the target column '{target_column}'."
            )
        dataset_info: dict[str, Any]
        if explicit_dataset_id:
            combined = reference_frame.copy()
            dataset_info = {
                "source": "explicit_dataset_version",
                "reference_dataset_version_id": reference.id,
                "new_rows": 0,
                "combined_rows": len(combined),
            }
            job.result_json = {**(job.result_json or {}), "label_stats": stats, "dataset": dataset_info}
            db.commit()
        else:
            combined, merge_stats = _build_monitored_training_frame(
                db,
                deployment=deployment,
                version=baseline,
                baseline_frame=reference_frame,
                since=since,
            )
            dataset_info = {
                "source": "monitored_labels",
                "reference_dataset_version_id": reference.id,
                **merge_stats,
            }
            update_job(
                db,
                job,
                message=(
                    f"Merged {merge_stats['new_rows']:,} newly labelled monitored rows with "
                    f"{merge_stats['reference_rows']:,} reference rows."
                ),
                progress=14,
            )
            data = combined.to_csv(index=False).encode("utf-8")
            user = db.get(User, job.triggered_by) or db.get(User, project.created_by)
            if not user:
                raise AppError(500, "actor_missing", "Cannot resolve job actor.")
            version = create_dataset_version(
                db,
                project=project,
                user=user,
                data=data,
                original_filename=f"retraining-{utcnow().strftime('%Y%m%d-%H%M%S')}.csv",
                dataset_name=f"{project.name} retraining data",
                description="Automatically assembled from labelled monitored predictions plus the reference dataset.",
                notes=(
                    "Retraining snapshot. Contains the reference dataset and new ground-truth labels "
                    f"received after {stats.get('counted_since') or 'the previous retrain'}. "
                    "Simulated demo labels may be included; check label sources before production use."
                ),
                is_reference=False,
            )
            explicit_dataset_id = version.id
            dataset_info.update(
                {
                    "training_dataset_version_id": version.id,
                    "training_dataset_version": version.version,
                    "training_dataset_content_hash": version.content_hash,
                }
            )

        # Validate class balance / schema before handing off to the standard training pipeline.
        if target_column not in combined.columns:
            raise ValidationAppError(f"The target column '{target_column}' is missing from the retraining data.")
        labelled = combined[target_column].dropna()
        if len(labelled) < MIN_RETRAINING_ROWS:
            raise ValidationAppError(
                f"At least {MIN_RETRAINING_ROWS} labelled rows are required for retraining; found {len(labelled)}."
            )
        if project.task_type == "classification" and labelled.astype(str).nunique() < 2:
            raise ValidationAppError("The retraining data must contain at least two target classes.")
        if not explicit_dataset_id:
            raise ValidationAppError("A training dataset version could not be resolved.")
        schema_names = set(str(c) for c in combined.columns)
        missing_schema = [
            field.get("name")
            for field in (baseline.feature_schema_json or [])
            if field.get("name") and field.get("name") not in schema_names
        ]
        if missing_schema:
            raise ValidationAppError(
                "The retraining data is missing features required by the deployed model.",
                details={"missing_features": missing_schema[:20]},
            )

        job.result_json = {**(job.result_json or {}), "label_stats": stats, "dataset": dataset_info}
        params = {
            **params,
            "dataset_version_id": explicit_dataset_id,
            "model_name": f"{project.name} retrain {utcnow().strftime('%Y-%m-%d %H:%M')}",
            "algorithms": [baseline.params_json.get("algorithm")] if baseline.params_json.get("algorithm") else None,
            "test_size": float(params.get("test_size", 0.2)),
            "random_state": int(params.get("random_state", 42)),
            "retraining": True,
            "baseline_model_version_id": baseline.id,
        }
        job.params_json = params
        job.stage = "candidate_training"
        job.progress = 18
        _append_log(
            job,
            f"Using dataset version {explicit_dataset_id} ({len(combined):,} rows). "
            "Running the standard training pipeline with held-out evaluation.",
        )
        db.commit()
    except Exception as exc:
        logger.error("retraining_setup_failed", exc_info=True)
        db.rollback()
        job = db.get(PipelineJob, job_id)
        if job and job.status not in {"succeeded", "failed", "cancelled"}:
            _fail_job(db, job, str(exc), count_attempt=True)
            audit_project = db.get(Project, (job.params_json or {}).get("project_id"))
            if audit_project:
                record_audit(
                    db,
                    workspace_id=audit_project.workspace_id,
                    actor=db.get(User, job.triggered_by),
                    action="retraining.failed",
                    entity_type="pipeline_job",
                    entity_id=job.id,
                    details={"error": str(exc)[:500], "stage": "setup"},
                )
                db.commit()
        PIPELINE_JOBS.labels("retraining", "failed").inc()
        return
    finally:
        db.close()

    # Reuse the audited training pipeline for candidate fitting, MLflow logging and registration.
    run_training_job(job_id)

    db = SessionLocal()
    try:
        job = db.get(PipelineJob, job_id)
        if not job:
            return
        if job.status != "succeeded":
            PIPELINE_JOBS.labels("retraining", "failed").inc()
            return
        params = job.params_json or {}
        result = job.result_json or {}
        project = db.get(Project, params.get("project_id"))
        deployment = db.get(Deployment, params.get("deployment_id"))
        baseline = db.get(ModelVersion, params.get("baseline_model_version_id") or "")
        candidate = db.get(ModelVersion, result.get("model_version_id") or "")
        if not project or not deployment or not baseline or not candidate:
            job.status = "failed"
            job.error = "Retraining completed but the comparison lineage is incomplete."
            job.finished_at = utcnow()
            db.commit()
            PIPELINE_JOBS.labels("retraining", "failed").inc()
            return
        comparison = _compare_candidate(
            project,
            baseline.metrics_json or {},
            candidate.metrics_json or {},
            candidate.validation_json or {},
        )
        comparison.update(
            {
                "baseline_model_version_id": baseline.id,
                "baseline_version": baseline.version,
                "baseline_algorithm": (baseline.params_json or {}).get("algorithm"),
                "candidate_model_version_id": candidate.id,
                "candidate_version": candidate.version,
                "candidate_algorithm": (candidate.params_json or {}).get("algorithm"),
                "baseline_metrics": baseline.metrics_json or {},
                "candidate_metrics": candidate.metrics_json or {},
                "notes": params.get("notes", ""),
            }
        )
        job.stage = "awaiting_review"
        job.progress = 100
        job.finished_at = utcnow()
        job.result_json = {**result, "comparison": jsonable(comparison)}
        _append_log(
            job,
            f"Recommendation: {comparison['recommendation']}. {comparison['reason']} "
            "The candidate remains pending approval; no deployment or promotion was performed automatically.",
        )
        db.commit()
        record_audit(
            db,
            workspace_id=project.workspace_id,
            actor=db.get(User, job.triggered_by),
            action="retraining.completed",
            entity_type="pipeline_job",
            entity_id=job.id,
            details={
                "deployment_id": deployment.id,
                "candidate_model_version_id": candidate.id,
                "baseline_model_version_id": baseline.id,
                "recommendation": comparison["recommendation"],
                "approval_required": True,
                "auto_promoted": False,
            },
        )
        record_audit(
            db,
            workspace_id=project.workspace_id,
            actor=db.get(User, job.triggered_by),
            action="retraining.recommendation",
            entity_type="model_version",
            entity_id=candidate.id,
            details={
                "recommendation": comparison["recommendation"],
                "reason": comparison["reason"],
                "primary_metric": comparison["primary_metric"],
                "baseline_value": comparison["baseline_value"],
                "candidate_value": comparison["candidate_value"],
            },
        )
        db.commit()
        PIPELINE_JOBS.labels("retraining", "succeeded").inc()
    except Exception as exc:
        logger.exception("retraining_comparison_failed")
        db.rollback()
        job = db.get(PipelineJob, job_id)
        if job:
            job.status = "failed"
            job.stage = "failed"
            job.error = f"Candidate training succeeded but comparison failed: {str(exc)[:1000]}"
            job.finished_at = utcnow()
            _append_log(job, job.error)
            db.commit()
        PIPELINE_JOBS.labels("retraining", "failed").inc()
    finally:
        db.close()
