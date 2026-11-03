from __future__ import annotations

import hmac
import logging
import random
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime
from typing import Any

import joblib
import numpy as np
import pandas as pd
from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AppError, ForbiddenError, NotFoundError, ValidationAppError
from app.models import Deployment, FeatureSample, ModelVersion, PredictionEvent, Project, RegisteredModel, User
from app.observability import PREDICTION_LATENCY, PREDICTIONS
from app.security import verify_api_key
from app.services.storage import storage
from app.utils import jsonable, mask_monitoring_features, utcnow

logger = logging.getLogger(__name__)

_ALERT_EVALUATION_INTERVAL_SECONDS = 60.0
_alert_evaluation_lock = threading.Lock()
_alert_evaluation_last: dict[str, datetime] = {}


def _maybe_evaluate_prediction_alerts(
    db: Session,
    *,
    deployment: Deployment,
    project: Project,
    simulated: bool,
) -> None:
    """Evaluate latency/error/distribution/health rules on real traffic.

    Prediction serving must stay fast, so evaluation is best-effort and
    throttled per deployment. Each enabled rule is evaluated against its own
    configured window.
    """
    now = utcnow()
    with _alert_evaluation_lock:
        last = _alert_evaluation_last.get(deployment.id)
        if last is not None and (now - last).total_seconds() < _ALERT_EVALUATION_INTERVAL_SECONDS:
            return
        _alert_evaluation_last[deployment.id] = now
    try:
        from app.models import AlertRule
        from app.services.alerts import evaluate_rules
        from app.services.monitoring import observed_monitoring_metrics

        rules = db.scalars(
            select(AlertRule).where(
                AlertRule.workspace_id == project.workspace_id,
                AlertRule.enabled.is_(True),
                (AlertRule.project_id == project.id) | (AlertRule.project_id.is_(None)),
            )
        ).all()
        windows = sorted({rule.window_minutes for rule in rules})
        if not windows:
            return
        observed_by_window: dict[int, dict[str, float | None]] = {}
        counts_by_window: dict[int, dict[str, int]] = {}
        for window in windows:
            observed, counts, _simulated_count = observed_monitoring_metrics(
                db, deployment=deployment, window_minutes=window
            )
            observed_by_window[window] = observed
            counts_by_window[window] = counts
        evaluate_rules(
            db,
            project=project,
            deployment=deployment,
            observed=observed_by_window[windows[-1]],
            observed_by_window=observed_by_window,
            sample_counts=counts_by_window[windows[-1]],
            sample_counts_by_window=counts_by_window,
            simulated=simulated,
        )
    except Exception:
        logger.exception("prediction_alert_evaluation_failed")


class ModelCache:
    def __init__(self, max_size: int = 8) -> None:
        self._cache: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
        self._lock = threading.RLock()
        self.max_size = max_size

    def get(self, version: ModelVersion) -> dict[str, Any]:
        key = (version.id, version.artifact_hash)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        path = storage.materialize(version.artifact_key)
        actual_hash = _sha256_path(str(path))
        if not hmac.compare_digest(actual_hash, version.artifact_hash):
            raise AppError(
                500,
                "artifact_integrity_failed",
                "The model artifact failed its SHA-256 integrity check and was not loaded.",
            )
        try:
            bundle = joblib.load(path)
        except Exception as exc:
            logger.exception("model_artifact_load_failed")
            raise AppError(
                503,
                "model_unavailable",
                "The model artifact could not be loaded.",
                {"error": str(exc)[:200]},
            ) from exc
        if not isinstance(bundle, dict) or "pipeline" not in bundle or "feature_columns" not in bundle:
            raise AppError(500, "invalid_model_bundle", "The model artifact is not a supported bundle.")
        with self._lock:
            self._cache[key] = bundle
            self._cache.move_to_end(key)
            while len(self._cache) > self.max_size:
                self._cache.popitem(last=False)
        return bundle

    def invalidate(self, version_id: str) -> None:
        with self._lock:
            for key in list(self._cache.keys()):
                if key[0] == version_id:
                    del self._cache[key]


def _sha256_path(path: str) -> str:
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


model_cache = ModelCache()


def get_deployment(db: Session, identifier: str) -> Deployment:
    deployment = db.get(Deployment, identifier)
    if not deployment:
        deployment = db.scalar(select(Deployment).where(Deployment.slug == identifier))
    if not deployment:
        raise NotFoundError("Deployment not found")
    return deployment


def get_model_version(db: Session, version_id: str) -> tuple[ModelVersion, RegisteredModel, Project]:
    version = db.get(ModelVersion, version_id)
    if not version:
        raise NotFoundError("Model version not found")
    model = db.get(RegisteredModel, version.registered_model_id)
    project = db.get(Project, version.project_id)
    if not model or not project:
        raise NotFoundError("Model version lineage is incomplete")
    return version, model, project


def validate_features(
    bundle: dict[str, Any], features: dict[str, Any], *, allow_extra: bool = False
) -> dict[str, Any]:
    if not isinstance(features, dict):
        raise ValidationAppError("Features must be a JSON object.")
    schema = bundle.get("feature_schema") or []
    feature_names = [item["name"] for item in schema]
    errors: list[dict[str, Any]] = []
    unknown = [key for key in features if key not in feature_names]
    if unknown and not allow_extra:
        errors.append({"field": ", ".join(unknown[:10]), "error": "Unknown feature(s)."})
    validated: dict[str, Any] = {}
    for item in schema:
        name = item["name"]
        if name not in features:
            errors.append({"field": name, "error": "Missing required feature."})
            continue
        value = features[name]
        if value is None:
            if item.get("nullable", True):
                validated[name] = np.nan
            else:
                errors.append({"field": name, "error": "Null is not allowed for this feature."})
            continue
        kind = item.get("kind", "categorical")
        if kind == "numeric":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                errors.append({"field": name, "error": "Expected a finite number."})
                continue
            number = float(value)
            if not np.isfinite(number):
                errors.append({"field": name, "error": "Expected a finite number."})
                continue
            validated[name] = number
        elif kind == "boolean":
            if isinstance(value, bool) or value in (0, 1):
                validated[name] = int(value)
            else:
                errors.append({"field": name, "error": "Expected a boolean or 0/1."})
        else:
            if isinstance(value, (dict, list)):
                errors.append({"field": name, "error": "Expected a scalar category value."})
                continue
            text = str(value)
            if len(text) > 500:
                errors.append({"field": name, "error": "Category value is too long."})
                continue
            validated[name] = text
    if errors:
        raise ValidationAppError("Prediction input failed schema validation.", details={"fields": errors})
    # Preserve deterministic column order expected by the fitted pipeline.
    return {name: validated[name] for name in feature_names}


def _map_prediction(bundle: dict[str, Any], proba: np.ndarray | None, pred: Any, index: int) -> tuple[Any, str | None, float | None, dict[str, float] | None]:
    task_type = bundle.get("task_type")
    if task_type == "classification":
        class_labels = bundle.get("class_labels") or []
        raw_label = int(pred)
        label = class_labels[raw_label] if raw_label < len(class_labels) else str(pred)
        probabilities = None
        confidence = None
        if proba is not None:
            row = proba[index]
            probabilities = {
                class_labels[i] if i < len(class_labels) else str(i): float(value)
                for i, value in enumerate(row)
            }
            confidence = float(np.max(row))
        return raw_label, label, confidence, probabilities
    value = float(pred)
    return value, None, None, None


def load_bundle_for_deployment(db: Session, deployment: Deployment) -> tuple[dict[str, Any], ModelVersion, RegisteredModel, Project]:
    version, model, project = get_model_version(db, deployment.model_version_id)
    if version.approval_status != "approved":
        raise AppError(
            409,
            "model_not_approved",
            "This deployment's model version is no longer approved. Roll back or deploy an approved version.",
        )
    bundle = model_cache.get(version)
    return bundle, version, model, project


def _record_prediction_event(
    db: Session,
    *,
    deployment: Deployment,
    version: ModelVersion,
    request_id: str,
    latency_ms: float,
    status: str,
    batch_size: int,
    is_batch: bool,
    prediction_json: Any | None = None,
    prediction_label: str | None = None,
    prediction_value: float | None = None,
    confidence: float | None = None,
    error_type: str | None = None,
    error_message: str | None = None,
    simulated: bool = False,
    timestamp: datetime | None = None,
    features: dict[str, Any] | None = None,
) -> PredictionEvent:
    event = PredictionEvent(
        deployment_id=deployment.id,
        model_version_id=version.id,
        request_id=request_id,
        created_at=timestamp or utcnow(),
        latency_ms=max(0.0, latency_ms),
        status=status,
        error_type=error_type,
        error_message=(error_message or "")[:300] or None,
        batch_size=batch_size,
        is_batch=is_batch,
        prediction_json=jsonable(prediction_json),
        prediction_label=prediction_label,
        prediction_value=prediction_value,
        confidence=confidence,
        simulated=simulated,
    )
    db.add(event)
    db.flush()
    if status == "success" and features is not None and settings.capture_monitoring_samples:
        capture = bool((deployment.config_json or {}).get("capture_samples", True))
        sampled = random.random() <= settings.monitoring_sample_rate
        if capture and sampled:
            allowed_features = {field["name"] for field in (version.feature_schema_json or [])}
            cleaned = mask_monitoring_features(features, allowed_features)
            if cleaned:
                db.add(
                    FeatureSample(
                        deployment_id=deployment.id,
                        model_version_id=version.id,
                        prediction_event_id=event.id,
                        features_json=jsonable(cleaned),
                        simulated=simulated,
                        created_at=timestamp or utcnow(),
                    )
                )
    PREDICTIONS.labels(deployment.id, status, "true" if is_batch else "false").inc()
    return event


def predict_records(
    db: Session,
    *,
    deployment: Deployment,
    records: list[dict[str, Any]],
    return_probabilities: bool = False,
    simulated: bool = False,
    timestamp: datetime | None = None,
    persist: bool = True,
    is_batch: bool = False,
    request_id: str | None = None,
) -> list[dict[str, Any]]:
    if len(records) > settings.max_batch_size:
        raise ValidationAppError(f"Batch size exceeds the {settings.max_batch_size} record limit.")
    bundle, version, _model, project = load_bundle_for_deployment(db, deployment)
    if deployment.status != "active":
        raise AppError(409, "deployment_inactive", "This deployment is not active.")
    started = time.perf_counter()
    validated_rows: list[dict[str, Any]] = []
    validation_errors: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        try:
            validated_rows.append(validate_features(bundle, record))
        except ValidationAppError as exc:
            validation_errors.append({"row": index, "details": exc.details})
    if validation_errors:
        latency = (time.perf_counter() - started) * 1000
        if persist:
            _record_prediction_event(
                db,
                deployment=deployment,
                version=version,
                request_id=str(uuid.uuid4()),
                latency_ms=latency,
                status="error",
                batch_size=len(records),
                is_batch=is_batch,
                error_type="invalid_input",
                error_message="Input schema validation failed.",
                simulated=simulated,
                timestamp=timestamp,
            )
            db.commit()
            _maybe_evaluate_prediction_alerts(
                db, deployment=deployment, project=project, simulated=simulated
            )
        raise ValidationAppError(
            "One or more prediction records failed schema validation.",
            details={"rows": validation_errors[:50]},
        )
    frame = pd.DataFrame(validated_rows, columns=bundle["feature_columns"])
    try:
        predictions = bundle["pipeline"].predict(frame)
        proba = (
            bundle["pipeline"].predict_proba(frame)
            if bundle.get("task_type") == "classification" and hasattr(bundle["pipeline"], "predict_proba")
            else None
        )
    except Exception as exc:
        logger.exception("model_inference_failed")
        if persist:
            _record_prediction_event(
                db,
                deployment=deployment,
                version=version,
                request_id=str(uuid.uuid4()),
                latency_ms=(time.perf_counter() - started) * 1000,
                status="error",
                batch_size=len(records),
                is_batch=is_batch,
                error_type="inference_error",
                error_message="Model inference failed.",
                simulated=simulated,
                timestamp=timestamp,
            )
            db.commit()
            _maybe_evaluate_prediction_alerts(
                db, deployment=deployment, project=project, simulated=simulated
            )
        raise AppError(500, "inference_failed", "Model inference failed.", {"error": str(exc)[:200]}) from exc
    total_latency = (time.perf_counter() - started) * 1000
    per_record_latency = total_latency / max(1, len(records))
    base_request_id = request_id or str(uuid.uuid4())
    results: list[dict[str, Any]] = []
    for index, record in enumerate(validated_rows):
        raw_prediction, label, confidence, probabilities = _map_prediction(
            bundle, proba, predictions[index], index
        )
        row_request_id = base_request_id if len(records) == 1 else f"{base_request_id}-{index + 1}"
        prediction_payload = {
            "prediction": label if bundle.get("task_type") == "classification" else float(predictions[index]),
            "raw": jsonable(raw_prediction),
            "probabilities": probabilities,
        }
        if persist:
            _record_prediction_event(
                db,
                deployment=deployment,
                version=version,
                request_id=row_request_id,
                latency_ms=per_record_latency,
                status="success",
                batch_size=len(records),
                is_batch=is_batch,
                prediction_json=prediction_payload,
                prediction_label=label,
                prediction_value=float(predictions[index]) if bundle.get("task_type") == "regression" else None,
                confidence=confidence,
                simulated=simulated,
                timestamp=timestamp,
                features=record,
            )
        results.append(
            {
                "request_id": row_request_id,
                "deployment_id": deployment.id,
                "model_version": version.version,
                "timestamp": timestamp or utcnow(),
                "prediction": label if bundle.get("task_type") == "classification" else float(predictions[index]),
                "label": label,
                "confidence": confidence,
                "probabilities": probabilities if return_probabilities or len(records) == 1 else None,
                "latency_ms": round(per_record_latency, 3),
                "simulated": simulated,
            }
        )
    PREDICTION_LATENCY.labels(deployment.id).observe(total_latency / 1000)
    if persist:
        db.commit()
        _maybe_evaluate_prediction_alerts(
            db, deployment=deployment, project=project, simulated=simulated
        )
    return results


def deployment_authenticated(
    db: Session,
    deployment: Deployment,
    user: User | None,
    api_key: str | None,
) -> User | None:
    if user is not None:
        project = db.get(Project, deployment.project_id)
        if not project:
            raise NotFoundError("Deployment not found")
        from app.deps import project_context_for_user

        project_context_for_user(db, user, project.id)
        return user
    if api_key and verify_api_key(api_key, deployment.api_key_hash):
        return None
    raise ForbiddenError("Provide a valid API key or sign in to use this deployment.")


def prediction_schema(bundle: dict[str, Any]) -> dict[str, Any]:
    fields = []
    for item in bundle.get("feature_schema") or []:
        example = None
        examples = item.get("examples") or []
        if item.get("kind") == "numeric":
            if item.get("range") and item["range"].get("p50") is not None:
                example = item["range"]["p50"]
            elif examples:
                example = examples[0]
        elif examples:
            example = examples[0]
        fields.append({**item, "example": example})
    return {
        "fields": fields,
        "task_type": bundle.get("task_type"),
        "target_column": bundle.get("target_column"),
        "class_labels": bundle.get("class_labels") or [],
        "positive_class": bundle.get("positive_class"),
    }


def health_check(db: Session, deployment: Deployment) -> dict[str, Any]:
    try:
        version, _model, project = get_model_version(db, deployment.model_version_id)
        if deployment.status != "active":
            return {"status": "stopped", "deployment": deployment.slug, "model_version": version.version}
        if version.approval_status != "approved":
            return {
                "status": "unhealthy",
                "reason": "model_not_approved",
                "deployment": deployment.slug,
                "model_version": version.version,
            }
        path = storage.materialize(version.artifact_key)
        actual_hash = _sha256_path(str(path))
        if not hmac.compare_digest(actual_hash, version.artifact_hash):
            return {
                "status": "unhealthy",
                "reason": "artifact_integrity_failed",
                "deployment": deployment.slug,
                "model_version": version.version,
            }
        bundle = model_cache.get(version)
        return {
            "status": "healthy",
            "deployment": deployment.slug,
            "model_version": version.version,
            "model_name": _model.name,
            "project": project.name,
            "task_type": bundle.get("task_type"),
            "features": len(bundle.get("feature_columns") or []),
            "artifact_hash": version.artifact_hash,
            "checked_at": utcnow().isoformat(),
        }
    except Exception as exc:
        logger.warning("deployment_health_check_failed", exc_info=True)
        return {"status": "unhealthy", "reason": "health_check_failed", "error": str(exc)[:200]}


def deployment_sample_record(db: Session, deployment: Deployment) -> dict[str, Any]:
    bundle, version, _model, _project = load_bundle_for_deployment(db, deployment)
    schema = prediction_schema(bundle)
    record: dict[str, Any] = {}
    for field in schema["fields"]:
        record[field["name"]] = field.get("example")
    return {"features": record, "schema": schema}


def evaluate_deployment_health_and_alert(db: Session, deployment: Deployment, request: Request | None = None) -> dict[str, Any]:
    health = health_check(db, deployment)
    deployment.last_health_status = "healthy" if health["status"] == "healthy" else "unhealthy"
    deployment.last_health_at = utcnow()
    db.commit()
    if health["status"] != "healthy":
        from app.services.alerts import create_system_alert

        project = db.get(Project, deployment.project_id)
        if project:
            create_system_alert(
                db,
                project=project,
                deployment=deployment,
                alert_type="endpoint_unavailable",
                severity="critical",
                title=f"Deployment {deployment.name} is unhealthy",
                message=f"Health check returned: {health.get('status')} ({health.get('reason', 'unknown')}).",
                details=health,
                request=request,
            )
    return health
