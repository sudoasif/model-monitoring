from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Alert,
    AuditEvent,
    Dataset,
    DatasetVersion,
    Deployment,
    DriftReport,
    Experiment,
    Incident,
    ModelVersion,
    PipelineJob,
    Project,
    RegisteredModel,
    TrainingRun,
    User,
)


def _user_name(db: Session, user_id: str | None) -> str | None:
    if not user_id:
        return None
    user = db.get(User, user_id)
    return user.full_name if user else None


def serialize_project(db: Session, project: Project, *, include_counts: bool = True) -> dict[str, Any]:
    payload = {
        "id": project.id,
        "workspace_id": project.workspace_id,
        "name": project.name,
        "slug": project.slug,
        "description": project.description,
        "task_type": project.task_type,
        "target_column": project.target_column,
        "positive_label": project.positive_label,
        "status": project.status,
        "config": project.config_json or {},
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "dataset_count": 0,
        "model_count": 0,
        "deployment_count": 0,
        "latest_run": None,
    }
    if not include_counts:
        return payload
    payload["dataset_count"] = int(
        db.scalar(select(func.count(Dataset.id)).where(Dataset.project_id == project.id)) or 0
    )
    payload["model_count"] = int(
        db.scalar(select(func.count(RegisteredModel.id)).where(RegisteredModel.project_id == project.id))
        or 0
    )
    payload["deployment_count"] = int(
        db.scalar(select(func.count(Deployment.id)).where(Deployment.project_id == project.id)) or 0
    )
    latest = db.scalar(
        select(TrainingRun)
        .where(TrainingRun.project_id == project.id)
        .order_by(TrainingRun.created_at.desc())
        .limit(1)
    )
    if latest:
        payload["latest_run"] = {
            "id": latest.id,
            "name": latest.name,
            "status": latest.status,
            "algorithm": latest.algorithm,
            "metrics": latest.metrics_json or {},
            "created_at": latest.created_at,
        }
    return payload


def serialize_experiment(db: Session, experiment: Experiment) -> dict[str, Any]:
    project = db.get(Project, experiment.project_id)
    run_count = int(
        db.scalar(select(func.count(TrainingRun.id)).where(TrainingRun.experiment_id == experiment.id)) or 0
    )
    return {
        "id": experiment.id,
        "project_id": experiment.project_id,
        "project_name": project.name if project else "",
        "name": experiment.name,
        "mlflow_experiment_id": experiment.mlflow_experiment_id,
        "run_count": run_count,
        "created_at": experiment.created_at,
    }


def serialize_run(db: Session, run: TrainingRun) -> dict[str, Any]:
    project = db.get(Project, run.project_id)
    experiment = db.get(Experiment, run.experiment_id)
    dataset_version = db.get(DatasetVersion, run.dataset_version_id) if run.dataset_version_id else None
    dataset = db.get(Dataset, dataset_version.dataset_id) if dataset_version else None
    model_version = db.get(ModelVersion, run.model_version_id) if run.model_version_id else None
    return {
        "id": run.id,
        "project_id": run.project_id,
        "project_name": project.name if project else "",
        "experiment_id": run.experiment_id,
        "experiment_name": experiment.name if experiment else "",
        "name": run.name,
        "algorithm": run.algorithm,
        "status": run.status,
        "message": run.message,
        "mlflow_run_id": run.mlflow_run_id,
        "params": run.params_json or {},
        "metrics": run.metrics_json or {},
        "validation_metrics": run.validation_metrics_json or {},
        "train_metrics": run.train_metrics_json or {},
        "candidate_results": run.candidate_results_json or [],
        "feature_columns": run.feature_columns_json or [],
        "target_summary": run.target_summary_json or {},
        "prediction_distribution": run.prediction_distribution_json or {},
        "duration_seconds": run.duration_seconds,
        "git_commit": run.git_commit,
        "dataset_version_id": run.dataset_version_id,
        "dataset_name": dataset.name if dataset else None,
        "dataset_version": dataset_version.version if dataset_version else None,
        "registered_model_id": run.registered_model_id,
        "model_version_id": run.model_version_id,
        "model_version_number": model_version.version if model_version else None,
        "job_id": run.pipeline_job_id,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "created_at": run.created_at,
    }


def serialize_model_version(db: Session, version: ModelVersion) -> dict[str, Any]:
    dataset_version = db.get(DatasetVersion, version.dataset_version_id) if version.dataset_version_id else None
    dataset = db.get(Dataset, dataset_version.dataset_id) if dataset_version else None
    run = db.get(TrainingRun, version.training_run_id) if version.training_run_id else None
    deployment_count = int(
        db.scalar(select(func.count(Deployment.id)).where(Deployment.model_version_id == version.id)) or 0
    )
    return {
        "id": version.id,
        "registered_model_id": version.registered_model_id,
        "version": version.version,
        "stage": version.stage,
        "approval_status": version.approval_status,
        "validation_status": version.validation_status,
        "validation": version.validation_json or {},
        "metrics": version.metrics_json or {},
        "params": version.params_json or {},
        "model_card": version.model_card_json or {},
        "feature_schema": version.feature_schema_json or [],
        "mlflow_run_id": version.mlflow_run_id,
        "mlflow_model_uri": version.mlflow_model_uri,
        "mlflow_model_version": version.mlflow_model_version,
        "artifact_hash": version.artifact_hash,
        "training_run_id": version.training_run_id,
        "dataset_version_id": version.dataset_version_id,
        "dataset_name": dataset.name if dataset else None,
        "dataset_version": dataset_version.version if dataset_version else None,
        "approved_by": version.approved_by,
        "approved_by_name": _user_name(db, version.approved_by),
        "approved_at": version.approved_at,
        "approval_note": version.approval_note,
        "rejected_reason": version.rejected_reason,
        "created_at": version.created_at,
        "training_run_name": run.name if run else None,
        "algorithm": (version.params_json or {}).get("algorithm"),
        "deployment_count": deployment_count,
    }


def serialize_model(db: Session, model: RegisteredModel) -> dict[str, Any]:
    project = db.get(Project, model.project_id)
    versions = db.scalars(
        select(ModelVersion)
        .where(ModelVersion.registered_model_id == model.id)
        .order_by(ModelVersion.version.desc())
    ).all()
    latest = versions[0] if versions else None
    production = next(
        (
            version
            for version in versions
            if version.stage == "production" and version.approval_status == "approved"
        ),
        None,
    )
    pending = sum(1 for version in versions if version.approval_status == "pending")
    return {
        "id": model.id,
        "project_id": model.project_id,
        "project_name": project.name if project else "",
        "name": model.name,
        "description": model.description,
        "task_type": model.task_type,
        "created_at": model.created_at,
        "version_count": len(versions),
        "production_version": serialize_model_version(db, production) if production else None,
        "latest_version": serialize_model_version(db, latest) if latest else None,
        "pending_approvals": pending,
    }


def serialize_deployment(db: Session, deployment: Deployment) -> dict[str, Any]:
    from app.models import PredictionEvent

    project = db.get(Project, deployment.project_id)
    version = db.get(ModelVersion, deployment.model_version_id)
    model = db.get(RegisteredModel, version.registered_model_id) if version else None
    total = int(
        db.scalar(
            select(func.count())
            .select_from(PredictionEvent)
            .where(PredictionEvent.deployment_id == deployment.id)
        )
        or 0
    )
    error_count = int(
        db.scalar(
            select(func.count())
            .select_from(PredictionEvent)
            .where(PredictionEvent.deployment_id == deployment.id, PredictionEvent.status == "error")
        )
        or 0
    )
    latest_drift = db.scalar(
        select(DriftReport)
        .where(DriftReport.deployment_id == deployment.id)
        .order_by(DriftReport.created_at.desc())
        .limit(1)
    )
    return {
        "id": deployment.id,
        "project_id": deployment.project_id,
        "project_name": project.name if project else "",
        "model_version_id": deployment.model_version_id,
        "model_id": model.id if model else "",
        "model_name": model.name if model else "",
        "model_version": version.version if version else 0,
        "name": deployment.name,
        "slug": deployment.slug,
        "description": deployment.description,
        "status": deployment.status,
        "config": deployment.config_json or {},
        "api_key_prefix": deployment.api_key_prefix,
        "last_health_status": deployment.last_health_status,
        "last_health_at": deployment.last_health_at,
        "created_at": deployment.created_at,
        "prediction_count": total,
        "error_rate": round(error_count / total, 4) if total else 0.0,
        "p95_latency_ms": None,
        "latest_drift_severity": latest_drift.severity if latest_drift else None,
    }


def serialize_alert(db: Session, alert: Alert) -> dict[str, Any]:
    project = db.get(Project, alert.project_id)
    deployment = db.get(Deployment, alert.deployment_id) if alert.deployment_id else None
    return {
        "id": alert.id,
        "workspace_id": alert.workspace_id,
        "project_id": alert.project_id,
        "project_name": project.name if project else None,
        "deployment_id": alert.deployment_id,
        "deployment_name": deployment.name if deployment else None,
        "rule_id": alert.rule_id,
        "type": alert.type,
        "severity": alert.severity,
        "title": alert.title,
        "message": alert.message,
        "status": alert.status,
        "details": alert.details_json or {},
        "notification": alert.notification_json or {},
        "simulated": alert.simulated,
        "created_at": alert.created_at,
        "acknowledged_at": alert.acknowledged_at,
        "acknowledged_by": alert.acknowledged_by,
        "resolved_at": alert.resolved_at,
        "resolved_by": alert.resolved_by,
        "resolution_note": alert.resolution_note,
    }


def serialize_incident(db: Session, incident: Incident) -> dict[str, Any]:
    project = db.get(Project, incident.project_id)
    deployment = db.get(Deployment, incident.deployment_id) if incident.deployment_id else None
    return {
        "id": incident.id,
        "workspace_id": incident.workspace_id,
        "project_id": incident.project_id,
        "project_name": project.name if project else None,
        "alert_id": incident.alert_id,
        "deployment_id": incident.deployment_id,
        "deployment_name": deployment.name if deployment else None,
        "title": incident.title,
        "description": incident.description,
        "severity": incident.severity,
        "status": incident.status,
        "owner_id": incident.owner_id,
        "owner_name": _user_name(db, incident.owner_id),
        "notes": incident.notes or [],
        "created_at": incident.created_at,
        "updated_at": incident.updated_at,
        "resolved_at": incident.resolved_at,
        "resolution_note": incident.resolution_note,
    }


def serialize_job(db: Session, job: PipelineJob, *, include_logs: bool = False) -> dict[str, Any]:
    project = db.get(Project, job.project_id) if job.project_id else None
    deployment = db.get(Deployment, job.deployment_id) if job.deployment_id else None
    payload = {
        "id": job.id,
        "workspace_id": job.workspace_id,
        "project_id": job.project_id,
        "project_name": project.name if project else None,
        "deployment_id": job.deployment_id,
        "deployment_name": deployment.name if deployment else None,
        "job_type": job.job_type,
        "status": job.status,
        "progress": job.progress,
        "stage": job.stage,
        "params": job.params_json or {},
        "result": job.result_json or {},
        "error": job.error,
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "dedupe_key": job.dedupe_key,
        "simulated": job.simulated,
        "triggered_by_name": _user_name(db, job.triggered_by),
        "created_at": job.created_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
    }
    if include_logs:
        payload["logs"] = job.logs or ""
    return payload


def serialize_audit(db: Session, event: AuditEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "actor_id": event.actor_id,
        "actor_name": _user_name(db, event.actor_id),
        "action": event.action,
        "entity_type": event.entity_type,
        "entity_id": event.entity_id,
        "details": event.details_json or {},
        "ip_address": event.ip_address,
        "request_id": event.request_id,
        "created_at": event.created_at,
    }
