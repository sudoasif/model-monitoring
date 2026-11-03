from __future__ import annotations

import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    Deployment,
    DriftReport,
    FeatureSample,
    GroundTruthLabel,
    ModelVersion,
    PerformanceReport,
    PredictionEvent,
    Project,
    RegisteredModel,
)
from app.services.alerts import evaluate_rules
from app.services.statistics import (
    classification_distribution_psi,
    regression_distribution_psi,
)
from app.services.training import (
    METRIC_DIRECTIONS,
    classification_metrics,
    regression_metrics,
)
from app.utils import ensure_utc, jsonable, percentile, utcnow


def _base_event_filters(
    db: Session,
    *,
    deployment_id: str | None,
    project_id: str | None,
    start: datetime,
    end: datetime,
    simulated: bool | None = None,
) -> list[Any]:
    filters: list[Any] = [PredictionEvent.created_at >= start, PredictionEvent.created_at <= end]
    if deployment_id:
        filters.append(PredictionEvent.deployment_id == deployment_id)
    if project_id:
        filters.append(
            PredictionEvent.deployment_id.in_(
                select(Deployment.id).where(Deployment.project_id == project_id)
            )
        )
    if simulated is not None:
        filters.append(PredictionEvent.simulated.is_(simulated))
    return filters


def _version_lookup(db: Session, version_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not version_ids:
        return {}
    rows = db.execute(
        select(ModelVersion, RegisteredModel)
        .join(RegisteredModel, RegisteredModel.id == ModelVersion.registered_model_id)
        .where(ModelVersion.id.in_(version_ids))
    ).all()
    return {
        version.id: {
            "model_name": model.name,
            "version": version.version,
            "model_version_id": version.id,
        }
        for version, model in rows
    }


def deployment_metrics(
    db: Session,
    *,
    deployment: Deployment,
    start: datetime,
    end: datetime,
    simulated: bool | None = None,
    max_rows: int = 200_000,
) -> dict[str, Any]:
    filters = _base_event_filters(
        db,
        deployment_id=deployment.id,
        project_id=None,
        start=start,
        end=end,
        simulated=simulated,
    )
    total = int(db.scalar(select(func.count()).select_from(PredictionEvent).where(*filters)) or 0)
    rows = db.execute(
        select(
            PredictionEvent.model_version_id,
            PredictionEvent.status,
            PredictionEvent.error_type,
            PredictionEvent.latency_ms,
            PredictionEvent.confidence,
            PredictionEvent.prediction_label,
            PredictionEvent.prediction_value,
            PredictionEvent.simulated,
            PredictionEvent.created_at,
        )
        .where(*filters)
        .order_by(PredictionEvent.created_at.desc())
        .limit(max_rows)
    ).all()
    latencies = [float(row.latency_ms) for row in rows if row.latency_ms is not None]
    confidences = [float(row.confidence) for row in rows if row.confidence is not None]
    errors = [row for row in rows if row.status != "success"]
    invalid = [row for row in rows if row.error_type == "invalid_input"]
    simulated_count = sum(1 for row in rows if row.simulated)
    version_counts = Counter(row.model_version_id for row in rows)
    version_info = _version_lookup(db, list(version_counts.keys()))
    prediction_labels = [row.prediction_label for row in rows if row.status == "success"]
    prediction_values = [row.prediction_value for row in rows if row.prediction_value is not None]
    task_type = None
    version = db.get(ModelVersion, deployment.model_version_id)
    if version:
        task_type = "regression" if (version.metrics_json or {}).get("rmse") is not None else "classification"
    distribution: dict[str, Any] = {}
    if prediction_labels:
        counts = Counter(str(value) for value in prediction_labels if value is not None)
        total_labels = max(1, sum(counts.values()))
        distribution = {
            "kind": "classification",
            "buckets": [{"value": value, "count": count, "share": count / total_labels} for value, count in counts.most_common(30)],
        }
    elif prediction_values:
        values = np.asarray(prediction_values, dtype=float)
        counts, edges = np.histogram(values, bins=min(20, max(5, int(math.sqrt(values.size)))))
        distribution = {
            "kind": "regression",
            "bins": [float(edge) for edge in edges],
            "counts": counts.tolist(),
            "mean": float(values.mean()),
            "min": float(values.min()),
            "max": float(values.max()),
        }
    labels_count = int(
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
    error_types = Counter(row.error_type or "unknown" for row in errors)
    return {
        "deployment_id": deployment.id,
        "window": {"start": start, "end": end},
        "total_requests": total,
        "loaded_rows": len(rows),
        "sampled": total > len(rows),
        "volume": len(rows),
        "error_count": len(errors),
        "error_rate": (len(errors) / max(1, len(rows))),
        "invalid_input_count": len(invalid),
        "invalid_input_rate": (len(invalid) / max(1, len(rows))),
        "latency_ms": {
            "p50": percentile(latencies, 50),
            "p95": percentile(latencies, 95),
            "p99": percentile(latencies, 99),
            "avg": float(np.mean(latencies)) if latencies else None,
        },
        "confidence": {
            "avg": float(np.mean(confidences)) if confidences else None,
            "min": float(np.min(confidences)) if confidences else None,
            "max": float(np.max(confidences)) if confidences else None,
        },
        "simulated_count": simulated_count,
        "production_count": len(rows) - simulated_count,
        "source": (
            "simulated"
            if rows and simulated_count == len(rows)
            else "mixed"
            if simulated_count
            else "production"
            if rows
            else "none"
        ),
        "version_usage": [
            {
                **(version_info.get(version_id, {"model_version_id": version_id, "version": None, "model_name": None})),
                "count": count,
            }
            for version_id, count in version_counts.most_common()
        ],
        "errors_by_type": [{"error_type": key, "count": value} for key, value in error_types.most_common()],
        "prediction_distribution": {**distribution, "buckets": distribution.get("buckets", [])},
        "labels_count": labels_count,
        "task_type": task_type,
    }


def project_metrics(
    db: Session, *, project_id: str, start: datetime, end: datetime, simulated: bool | None = None
) -> dict[str, Any]:
    filters = _base_event_filters(
        db, deployment_id=None, project_id=project_id, start=start, end=end, simulated=simulated
    )
    total = int(db.scalar(select(func.count()).select_from(PredictionEvent).where(*filters)) or 0)
    total_errors = int(
        db.scalar(
            select(func.count())
            .select_from(PredictionEvent)
            .where(*filters, PredictionEvent.status != "success")
        )
        or 0
    )
    simulated_count = int(
        db.scalar(
            select(func.count())
            .select_from(PredictionEvent)
            .where(*filters, PredictionEvent.simulated.is_(True))
        )
        or 0
    )
    deployments = db.scalars(
        select(Deployment).where(Deployment.project_id == project_id, Deployment.status == "active")
    ).all()
    return {
        "project_id": project_id,
        "window": {"start": start, "end": end},
        "total_requests": total,
        "error_count": total_errors,
        "error_rate": total_errors / max(1, total),
        "simulated_count": simulated_count,
        "production_count": total - simulated_count,
        "active_deployments": len(deployments),
    }


def timeseries(
    db: Session,
    *,
    deployment_id: str | None,
    project_id: str | None,
    start: datetime,
    end: datetime,
    granularity: str = "day",
    simulated: bool | None = None,
    max_rows: int = 200_000,
) -> dict[str, Any]:
    filters = _base_event_filters(
        db,
        deployment_id=deployment_id,
        project_id=project_id,
        start=start,
        end=end,
        simulated=simulated,
    )
    rows = db.execute(
        select(
            PredictionEvent.created_at,
            PredictionEvent.latency_ms,
            PredictionEvent.status,
            PredictionEvent.confidence,
            PredictionEvent.simulated,
        )
        .where(*filters)
        .order_by(PredictionEvent.created_at)
        .limit(max_rows)
    ).all()
    buckets: dict[str, dict[str, Any]] = {}
    if granularity == "hour":
        step = timedelta(hours=1)
    elif granularity == "week":
        step = timedelta(days=7)
    else:
        step = timedelta(days=1)
    current = start.replace(minute=0, second=0, microsecond=0)
    if granularity == "day":
        current = current.replace(hour=0)
    elif granularity == "week":
        current = current.replace(hour=0) - timedelta(days=current.weekday())
    while current < end:
        key = current.isoformat()
        buckets[key] = {
            "timestamp": current.isoformat(),
            "volume": 0,
            "errors": 0,
            "simulated": 0,
            "latencies": [],
            "confidences": [],
        }
        current += step
    bucket_keys = list(buckets.keys())
    for row in rows:
        created = ensure_utc(row.created_at) or utcnow()
        if granularity == "hour":
            bucket_start = created.replace(minute=0, second=0, microsecond=0)
        elif granularity == "week":
            bucket_start = (created - timedelta(days=created.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        else:
            bucket_start = created.replace(hour=0, minute=0, second=0, microsecond=0)
        bucket = buckets.get(bucket_start.isoformat())
        if bucket is None:
            if not bucket_keys:
                continue
            # Range filtering should keep this aligned; skip if outside the visible buckets.
            continue
        bucket["volume"] += 1
        if row.status != "success":
            bucket["errors"] += 1
        if row.simulated:
            bucket["simulated"] += 1
        bucket["latencies"].append(float(row.latency_ms))
        if row.confidence is not None:
            bucket["confidences"].append(float(row.confidence))
    points = []
    for bucket in buckets.values():
        latencies = bucket.pop("latencies")
        confidences = bucket.pop("confidences")
        bucket["error_rate"] = bucket["errors"] / max(1, bucket["volume"])
        bucket["latency_p50"] = percentile(latencies, 50)
        bucket["latency_p95"] = percentile(latencies, 95)
        bucket["avg_confidence"] = float(np.mean(confidences)) if confidences else None
        points.append(bucket)
    return {
        "granularity": granularity,
        "window": {"start": start, "end": end},
        "points": points,
        "loaded_rows": len(rows),
        "truncated": len(rows) >= max_rows,
    }


def _labels_for_performance(
    db: Session, deployment_id: str, start: datetime, end: datetime
) -> tuple[list[Any], int]:
    prediction_count = int(
        db.scalar(
            select(func.count())
            .select_from(PredictionEvent)
            .where(
                PredictionEvent.deployment_id == deployment_id,
                PredictionEvent.created_at >= start,
                PredictionEvent.created_at <= end,
            )
        )
        or 0
    )
    rows = db.execute(
        select(GroundTruthLabel, PredictionEvent)
        .join(PredictionEvent, PredictionEvent.id == GroundTruthLabel.prediction_event_id)
        .where(
            GroundTruthLabel.deployment_id == deployment_id,
            PredictionEvent.created_at >= start,
            PredictionEvent.created_at <= end,
            PredictionEvent.status == "success",
        )
        .order_by(PredictionEvent.created_at)
    ).all()
    return rows, prediction_count


def _label_numeric(label: GroundTruthLabel) -> float | None:
    value = (label.label_json or {}).get("value", label.label_value)
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def compute_performance(
    db: Session,
    *,
    deployment: Deployment,
    start: datetime,
    end: datetime,
    min_labels: int | None = None,
    persist: bool = False,
    actor_id: str | None = None,
    evaluate_alerts: bool = True,
) -> dict[str, Any]:
    project = db.get(Project, deployment.project_id)
    version = db.get(ModelVersion, deployment.model_version_id)
    if not project or not version:
        raise ValueError("Deployment lineage is incomplete")
    threshold = int(
        min_labels
        or (deployment.config_json or {}).get("min_label_samples")
        or settings.default_min_label_samples
    )
    rows, prediction_count = _labels_for_performance(db, deployment.id, start, end)
    base = {
        "deployment_id": deployment.id,
        "deployment_name": deployment.name,
        "model_version": version.version,
        "window": {"start": start, "end": end},
        "min_labels": threshold,
        "prediction_count": prediction_count,
        "label_count": len(rows),
        "simulated_labels": sum(1 for label, _event in rows if label.simulated),
        "baseline_metrics": version.metrics_json,
        "primary_metric": (project.config_json or {}).get(
            "performance_metric", "f1_macro" if project.task_type == "classification" else "rmse"
        ),
    }
    if len(rows) < threshold:
        base.update(
            {
                "status": "insufficient_labels",
                "metrics": {},
                "delta": {},
                "degraded": False,
                "message": (
                    f"{len(rows)} labelled predictions are available; at least {threshold} are required "
                    "before performance metrics can be computed. Unlabelled predictions do not have accuracy."
                ),
                "concept_drift": {
                    "status": "not_assessed",
                    "explanation": "Concept drift cannot be evaluated without sufficient ground-truth labels.",
                },
                "delayed_labels": _delay_stats(rows),
            }
        )
        return base
    if project.task_type == "classification":
        class_labels = list((version.metrics_json or {}).get("class_labels") or [])
        if not class_labels:
            bundle_distribution = version.prediction_distribution_json or {}
            class_labels = [str(row.get("value")) for row in bundle_distribution.get("distribution", [])]
        label_index = {label: index for index, label in enumerate(class_labels)}
        y_true: list[int] = []
        y_pred: list[int] = []
        proba_rows: list[list[float]] = []
        valid_rows = 0
        for label, event in rows:
            true_label = str(label.label_value)
            predicted_label = str(event.prediction_label) if event.prediction_label is not None else None
            if true_label not in label_index or predicted_label not in label_index:
                continue
            probabilities = (event.prediction_json or {}).get("probabilities") if event.prediction_json else None
            if isinstance(probabilities, dict) and len(probabilities) == len(class_labels):
                proba_rows.append([float(probabilities.get(name, 0.0)) for name in class_labels])
            y_true.append(label_index[true_label])
            y_pred.append(label_index[predicted_label])
            valid_rows += 1
        if valid_rows < threshold:
            base.update(
                {
                    "status": "insufficient_labels",
                    "metrics": {},
                    "delta": {},
                    "degraded": False,
                    "message": (
                        f"{valid_rows} labels match the deployed model's class schema; "
                        f"{threshold} valid labels are required."
                    ),
                    "concept_drift": {
                        "status": "not_assessed",
                        "explanation": "Too few valid labels to evaluate concept drift.",
                    },
                    "delayed_labels": _delay_stats(rows),
                }
            )
            return base
        proba = np.asarray(proba_rows) if len(proba_rows) == valid_rows else None
        metrics = classification_metrics(np.asarray(y_true), np.asarray(y_pred), proba, class_labels)
    else:
        y_true: list[float] = []
        y_pred: list[float] = []
        for label, event in rows:
            true_value = _label_numeric(label)
            predicted = event.prediction_value
            if true_value is None or predicted is None:
                continue
            y_true.append(true_value)
            y_pred.append(float(predicted))
        if len(y_true) < threshold:
            base.update(
                {
                    "status": "insufficient_labels",
                    "metrics": {},
                    "delta": {},
                    "degraded": False,
                    "message": "Too few valid numeric labels to compute regression metrics.",
                    "concept_drift": {
                        "status": "not_assessed",
                        "explanation": "Too few valid labels to evaluate concept drift.",
                    },
                    "delayed_labels": _delay_stats(rows),
                }
            )
            return base
        metrics = regression_metrics(np.asarray(y_true), np.asarray(y_pred))
    metric = base["primary_metric"]
    direction = METRIC_DIRECTIONS.get(metric, "higher")
    current_value = metrics.get(metric)
    baseline_value = (version.metrics_json or {}).get(metric)
    delta: dict[str, Any] = {}
    if current_value is not None and baseline_value is not None:
        absolute = float(current_value) - float(baseline_value)
        if abs(float(baseline_value)) > 1e-12:
            relative = (
                (float(baseline_value) - float(current_value)) / abs(float(baseline_value))
                if direction == "higher"
                else (float(current_value) - float(baseline_value)) / abs(float(baseline_value))
            )
        else:
            relative = None
        delta = {
            "absolute": absolute,
            "relative_degradation": relative,
            "direction": direction,
            "threshold": settings.performance_degradation_threshold,
        }
    degradation_threshold = float(
        (project.config_json or {}).get(
            "performance_degradation_threshold", settings.performance_degradation_threshold
        )
    )
    relative = delta.get("relative_degradation")
    degraded = relative is not None and relative > degradation_threshold
    base.update(
        {
            "status": "ok",
            "metrics": metrics,
            "delta": delta,
            "degraded": degraded,
            "message": (
                f"Performance is degraded beyond the {degradation_threshold:.0%} threshold."
                if degraded
                else "Performance is within the configured degradation threshold."
            ),
            "concept_drift": {
                "status": "suspected_not_confirmed" if degraded else "no_degradation_detected",
                "explanation": (
                    "Labeled performance has degraded. This is consistent with concept drift but is not confirmation; "
                    "confirm with segment-level analysis, drift reports, and an investigation of label quality."
                    if degraded
                    else "Labeled performance has not degraded beyond the configured guardrail. Concept drift is not indicated by this check, which is not proof of stability."
                ),
            },
            "delayed_labels": _delay_stats(rows),
        }
    )
    if persist:
        report = PerformanceReport(
            project_id=project.id,
            deployment_id=deployment.id,
            model_version_id=version.id,
            window_start=start,
            window_end=end,
            prediction_count=prediction_count,
            label_count=len(rows),
            status="ok",
            primary_metric=metric,
            metrics_json=jsonable(metrics),
            baseline_metrics_json=jsonable(version.metrics_json or {}),
            delta_json=jsonable(delta),
            degraded=degraded,
            suspected_concept_drift=degraded,
            notes=base["concept_drift"]["explanation"],
            created_by=actor_id or project.created_by,
        )
        db.add(report)
        base["report_id"] = report.id if report.id else None
        db.commit()
        base["report_id"] = report.id
        if evaluate_alerts:
            simulated = len(rows) > 0 and all(label.simulated for label, _event in rows)
            evaluate_rules(
                db,
                project=project,
                deployment=deployment,
                observed={
                    "performance_degradation": max(0.0, float(relative or 0.0)),
                },
                context={
                    "metric": metric,
                    "current": current_value,
                    "baseline": baseline_value,
                    "label_count": len(rows),
                    "suspected_concept_drift": degraded,
                },
                sample_counts={"performance_degradation": len(rows)},
                simulated=simulated,
            )
    return base


def _delay_stats(rows: list[Any]) -> dict[str, Any]:
    delays = []
    for label, event in rows:
        try:
            delays.append(
                max(0.0, (ensure_utc(label.received_at) - ensure_utc(event.created_at)).total_seconds())
            )
        except (TypeError, AttributeError):
            continue
    return {
        "p50_seconds": percentile(delays, 50),
        "p95_seconds": percentile(delays, 95),
        "sample_count": len(delays),
    }


def performance_trend(
    db: Session, *, deployment: Deployment, start: datetime, end: datetime
) -> dict[str, Any]:
    project = db.get(Project, deployment.project_id)
    version = db.get(ModelVersion, deployment.model_version_id)
    if not project or not version:
        return {"points": [], "status": "insufficient_labels"}
    rows, _prediction_count = _labels_for_performance(db, deployment.id, start, end)
    min_labels = int(
        (deployment.config_json or {}).get("min_label_samples") or settings.default_min_label_samples
    )
    grouped: dict[str, list[Any]] = defaultdict(list)
    for label, event in rows:
        created = ensure_utc(event.created_at) or utcnow()
        grouped[created.date().isoformat()].append((label, event))
    points = []
    class_labels = list((version.metrics_json or {}).get("class_labels") or [])
    label_index = {label: index for index, label in enumerate(class_labels)}
    for day, items in sorted(grouped.items()):
        point = {"date": day, "label_count": len(items), "status": "insufficient_labels", "metrics": {}}
        if len(items) >= min_labels:
            if project.task_type == "classification":
                y_true, y_pred = [], []
                for label, event in items:
                    if str(label.label_value) in label_index and str(event.prediction_label) in label_index:
                        y_true.append(label_index[str(label.label_value)])
                        y_pred.append(label_index[str(event.prediction_label)])
                if len(y_true) >= min_labels:
                    point["metrics"] = classification_metrics(
                        np.asarray(y_true), np.asarray(y_pred), None, class_labels
                    )
                    point["status"] = "ok"
            else:
                y_true, y_pred = [], []
                for label, event in items:
                    true_value = _label_numeric(label)
                    if true_value is not None and event.prediction_value is not None:
                        y_true.append(true_value)
                        y_pred.append(float(event.prediction_value))
                if len(y_true) >= min_labels:
                    point["metrics"] = regression_metrics(np.asarray(y_true), np.asarray(y_pred))
                    point["status"] = "ok"
        points.append(point)
    return {
        "points": points,
        "baseline_metrics": version.metrics_json,
        "primary_metric": (project.config_json or {}).get(
            "performance_metric", "f1_macro" if project.task_type == "classification" else "rmse"
        ),
        "min_labels": min_labels,
    }


def current_prediction_distribution_psi(
    db: Session, *, deployment: Deployment, start: datetime, end: datetime
) -> float | None:
    version = db.get(ModelVersion, deployment.model_version_id)
    if not version:
        return None
    rows = db.execute(
        select(PredictionEvent.prediction_label, PredictionEvent.prediction_value)
        .where(
            PredictionEvent.deployment_id == deployment.id,
            PredictionEvent.created_at >= start,
            PredictionEvent.created_at <= end,
            PredictionEvent.status == "success",
        )
        .limit(50_000)
    ).all()
    baseline = version.prediction_distribution_json or {}
    if (baseline.get("kind") or "") == "regression":
        return regression_distribution_psi(baseline, [row.prediction_value for row in rows])
    return classification_distribution_psi(baseline, [row.prediction_label for row in rows])


def observed_monitoring_metrics(
    db: Session, *, deployment: Deployment, window_minutes: int = 60
) -> tuple[dict[str, float | None], dict[str, int], int]:
    end = utcnow()
    start = end - timedelta(minutes=window_minutes)
    metrics = deployment_metrics(db, deployment=deployment, start=start, end=end)
    observed = {
        "latency_p95": metrics["latency_ms"]["p95"],
        "error_rate": metrics["error_rate"],
        "invalid_input_rate": metrics["invalid_input_rate"],
        "prediction_distribution_psi": current_prediction_distribution_psi(
            db, deployment=deployment, start=start, end=end
        ),
        "endpoint_unavailable": 1.0 if deployment.last_health_status == "unhealthy" else 0.0,
    }
    counts = {
        "latency_p95": metrics["volume"],
        "error_rate": metrics["volume"],
        "invalid_input_rate": metrics["volume"],
        "prediction_distribution_psi": metrics["volume"],
        "endpoint_unavailable": 1,
    }
    return observed, counts, metrics["simulated_count"]


def _empty_data_quality(
    start: datetime, end: datetime, *, message: str | None = None
) -> dict[str, Any]:
    return {
        "status": "no_data",
        "message": message,
        "sample_count": 0,
        "window": {"start": start, "end": end},
        "features": [],
        "schema_changes": {"missing_features": [], "added_features": [], "type_changes": []},
        "latest_drift_report_id": None,
        "latest_drift_severity": None,
    }


def _normalise_schema_changes(raw: Any) -> dict[str, list[str]]:
    changes = {"missing_features": [], "added_features": [], "type_changes": []}
    if not isinstance(raw, dict):
        return changes
    for key in changes:
        value = raw.get(key)
        if isinstance(value, list):
            changes[key] = [str(item) for item in value]
    return changes


def data_quality(
    db: Session, *, deployment: Deployment, start: datetime, end: datetime
) -> dict[str, Any]:
    version = db.get(ModelVersion, deployment.model_version_id)
    if not version:
        return _empty_data_quality(start, end, message="The deployed model version is unavailable.")
    samples = db.scalars(
        select(FeatureSample)
        .where(
            FeatureSample.deployment_id == deployment.id,
            FeatureSample.created_at >= start,
            FeatureSample.created_at <= end,
        )
        .order_by(FeatureSample.created_at.desc())
        .limit(50_000)
    ).all()
    if not samples:
        return _empty_data_quality(
            start,
            end,
            message="No feature samples were captured in this window. Enable monitoring capture or widen the range.",
        )
    reference_version = None
    if version.dataset_version_id:
        from app.models import DatasetVersion

        reference_version = db.get(DatasetVersion, version.dataset_version_id)
    reference_columns = {
        column["name"]: column for column in (reference_version.schema_json if reference_version else [])
    }
    feature_entries = []
    for feature in version.feature_schema_json or []:
        name = feature["name"]
        values = [sample.features_json.get(name) for sample in samples]
        present = [value for value in values if value is not None and not (isinstance(value, float) and math.isnan(value))]
        missing_rate = 1 - len(present) / max(1, len(values))
        reference_missing = (
            reference_columns.get(name, {}).get("missing_count", 0) / max(1, reference_version.row_count)
            if reference_version and name in reference_columns
            else 0.0
        )
        feature_entries.append(
            {
                "name": name,
                "kind": feature.get("kind"),
                "missing_rate": missing_rate,
                "reference_missing_rate": reference_missing,
                "missing_delta": missing_rate - reference_missing,
                "sample_count": len(values),
                "status": "warning" if missing_rate > 0.1 or missing_rate - reference_missing > 0.05 else "ok",
            }
        )
    latest_drift = db.scalar(
        select(DriftReport)
        .where(DriftReport.deployment_id == deployment.id)
        .order_by(DriftReport.created_at.desc())
        .limit(1)
    )
    return {
        "status": "ok",
        "sample_count": len(samples),
        "window": {"start": start, "end": end},
        "features": sorted(feature_entries, key=lambda item: item["missing_rate"], reverse=True),
        "schema_changes": _normalise_schema_changes(
            (latest_drift.summary_json or {}).get("schema_changes") if latest_drift else None
        ),
        "latest_drift_report_id": latest_drift.id if latest_drift else None,
        "latest_drift_severity": latest_drift.severity if latest_drift else None,
    }


def recent_predictions(
    db: Session, *, deployment: Deployment, limit: int = 25
) -> list[dict[str, Any]]:
    events = db.scalars(
        select(PredictionEvent)
        .where(PredictionEvent.deployment_id == deployment.id)
        .order_by(PredictionEvent.created_at.desc())
        .limit(limit)
    ).all()
    labels = {
        label.prediction_event_id: label
        for label in db.scalars(
            select(GroundTruthLabel).where(
                GroundTruthLabel.prediction_event_id.in_([event.id for event in events])
            )
        ).all()
    } if events else {}
    return [
        {
            "id": event.id,
            "request_id": event.request_id,
            "timestamp": event.created_at,
            "status": event.status,
            "latency_ms": event.latency_ms,
            "error_type": event.error_type,
            "prediction": (event.prediction_json or {}).get("prediction") if event.prediction_json else None,
            "confidence": event.confidence,
            "simulated": event.simulated,
            "ground_truth": labels[event.id].label_value if event.id in labels else None,
            "label_received_at": labels[event.id].received_at if event.id in labels else None,
        }
        for event in events
    ]
