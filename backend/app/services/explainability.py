from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime
from typing import Any

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

from app.errors import AppError, ValidationAppError
from app.models import Deployment, ModelVersion
from app.services.datasets import load_dataset_frame
from app.services.prediction import load_bundle_for_deployment, validate_features
from app.utils import jsonable

logger = logging.getLogger(__name__)

_GLOBAL_CACHE: dict[str, dict[str, Any]] = {}
_CACHE_LOCK = threading.Lock()
MAX_GLOBAL_ROWS = 200
SHAP_WARNING = (
    "SHAP values explain this fitted model's output, not causal effects. "
    "Encoded categorical features are grouped back to their source column."
)


def _encoded_feature_names(preprocessor: Any, fallback: list[str]) -> list[str]:
    try:
        names = [str(name) for name in preprocessor.get_feature_names_out()]
    except Exception:
        names = fallback
    return names


def _original_feature(encoded: str, feature_columns: list[str]) -> str:
    if encoded in feature_columns:
        return encoded
    for name in sorted(feature_columns, key=len, reverse=True):
        if encoded.startswith(name + "_"):
            return name
    return encoded


def _normalise_shap(raw: Any, n_features: int, n_classes: int | None) -> np.ndarray:
    """Normalise SHAP output to (samples, features) or (samples, features, classes).

    Binary classification and regression collapse to two dimensions. Multi-class
    values retain the class axis so callers can aggregate or select a class.
    """
    if isinstance(raw, list):
        if not raw:
            raise ValueError("SHAP returned no values")
        if n_classes and n_classes > 2:
            values = np.stack([np.asarray(item, dtype=float) for item in raw], axis=-1)
        else:
            values = np.asarray(raw[1] if len(raw) > 1 else raw[0], dtype=float)
    else:
        values = np.asarray(raw, dtype=float)
        if values.ndim == 3:
            if values.shape[1] == n_features and values.shape[2] != n_features:
                # Already (samples, features, classes).
                pass
            elif values.shape[2] == n_features:
                values = np.moveaxis(values, 2, 0)
            else:
                values = values.reshape(values.shape[0], n_features, -1)
    if values.ndim == 1:
        values = values.reshape(1, -1)
    if values.ndim == 3 and values.shape[2] <= 1:
        values = values[:, :, 0]
    if values.ndim not in {2, 3} or values.shape[1] != n_features:
        raise ValueError(f"Unexpected SHAP shape {values.shape} for {n_features} encoded features")
    return values


def _shap_for_frame(
    bundle: dict[str, Any], frame: pd.DataFrame
) -> tuple[np.ndarray, str, list[str]]:
    pipeline = bundle.get("pipeline")
    if pipeline is None or not hasattr(pipeline, "named_steps"):
        raise AppError(500, "invalid_model_bundle", "The model artifact does not contain a fitted pipeline.")
    preprocessor = pipeline.named_steps.get("preprocessor")
    estimator = pipeline.named_steps.get("model")
    if preprocessor is None or estimator is None:
        raise AppError(500, "invalid_model_bundle", "The model artifact is missing preprocessor or estimator.")
    feature_columns = bundle.get("feature_columns") or []
    missing = [name for name in feature_columns if name not in frame.columns]
    if missing:
        raise ValidationAppError("Explanation input is missing model features.", details={"missing": missing})
    frame = frame[feature_columns]
    try:
        transformed_values = preprocessor.transform(frame)
    except Exception as exc:
        raise AppError(
            500, "preprocessing_failed", "The fitted preprocessing pipeline could not transform the explanation input.",
            {"error": str(exc)[:200]},
        ) from exc
    encoded_names = _encoded_feature_names(preprocessor, feature_columns)
    if hasattr(transformed_values, "toarray"):
        transformed_values = transformed_values.toarray()
    transformed = pd.DataFrame(np.asarray(transformed_values), columns=encoded_names[: np.asarray(transformed_values).shape[1]])
    if transformed.shape[1] != len(encoded_names):
        encoded_names = [f"feature_{i}" for i in range(transformed.shape[1])]

    class_labels = bundle.get("class_labels") or []
    n_classes = len(class_labels) if bundle.get("task_type") == "classification" else None
    method = ""
    try:
        import shap

        if hasattr(estimator, "tree_") or estimator.__class__.__name__.lower().startswith("xgb"):
            explainer = shap.TreeExplainer(estimator)
            raw = explainer.shap_values(transformed)
            values = _normalise_shap(raw, transformed.shape[1], n_classes)
            method = "TreeExplainer"
        elif hasattr(estimator, "coef_"):
            background = transformed.iloc[: min(100, len(transformed))]
            explainer = shap.LinearExplainer(estimator, background)
            raw = explainer.shap_values(transformed)
            values = _normalise_shap(raw, transformed.shape[1], n_classes)
            method = "LinearExplainer"
        else:
            raise ValueError("unsupported_estimator")
    except Exception as exc:
        logger.warning("shap_unavailable", exc_info=True)
        raise AppError(
            422,
            "explainability_unsupported",
            "SHAP explanations are not available for this model type. Global permutation importance may be used instead.",
            {"error": str(exc)[:200]},
        ) from exc
    return values, method, encoded_names


def _reference_frame(db: Session, version: ModelVersion, limit: int = MAX_GLOBAL_ROWS) -> tuple[pd.DataFrame, dict[str, Any]]:
    if not version.dataset_version_id:
        raise ValidationAppError("This model version has no linked dataset version for global explanations.")
    from app.models import DatasetVersion

    dataset_version = db.get(DatasetVersion, version.dataset_version_id)
    if not dataset_version:
        raise ValidationAppError("The model's training dataset version no longer exists.")
    frame = load_dataset_frame(dataset_version)
    feature_columns = [field.get("name") for field in (version.feature_schema_json or []) if field.get("name")]
    missing = [name for name in feature_columns if name not in frame.columns]
    if missing:
        raise ValidationAppError(
            "The training dataset is missing features required by the model.",
            details={"missing_features": missing[:20]},
        )
    total = len(frame)
    if total > limit:
        frame = frame.sample(n=limit, random_state=42)
    info = {
        "dataset_version_id": dataset_version.id,
        "dataset_version": dataset_version.version,
        "dataset_name": dataset_version.original_filename,
        "rows_available": total,
        "rows_used": len(frame),
    }
    return frame[feature_columns].reset_index(drop=True), info


def _aggregate_global(
    values: np.ndarray, frame: pd.DataFrame, encoded_names: list[str], feature_columns: list[str]
) -> list[dict[str, Any]]:
    abs_values = np.abs(values)
    while abs_values.ndim > 2:
        abs_values = abs_values.mean(axis=2)
    mean_abs = abs_values.mean(axis=0)
    signed = values
    while signed.ndim > 2:
        signed = signed.mean(axis=2)
    mean_signed = signed.mean(axis=0)
    grouped: dict[str, dict[str, float]] = {}
    for index, encoded in enumerate(encoded_names):
        original = _original_feature(encoded, feature_columns)
        entry = grouped.setdefault(original, {"mean_abs": 0.0, "mean_signed": 0.0})
        entry["mean_abs"] += float(mean_abs[index])
        entry["mean_signed"] += float(mean_signed[index])
    total = sum(item["mean_abs"] for item in grouped.values()) or 1.0
    importance = []
    for name, item in grouped.items():
        direction = "neutral"
        if name in frame.columns and pd.api.types.is_numeric_dtype(frame[name]):
            try:
                numeric = pd.to_numeric(frame[name], errors="coerce")
                if numeric.notna().sum() > 2 and float(numeric.std() or 0) > 0:
                    indices = [
                        i for i, encoded in enumerate(encoded_names)
                        if _original_feature(encoded, feature_columns) == name
                    ]
                    feature_shap = signed[:, indices].sum(axis=1)
                    corr = float(np.corrcoef(numeric.fillna(numeric.median()), feature_shap)[0, 1])
                    direction = "increases" if corr > 0.05 else "decreases" if corr < -0.05 else "neutral"
            except Exception:
                direction = "neutral"
        importance.append(
            {
                "feature": name,
                "mean_abs_shap": round(item["mean_abs"], 6),
                "mean_shap": round(item["mean_signed"], 6),
                "share": round(item["mean_abs"] / total, 4),
                "direction": direction,
                "kind": "categorical" if name in frame.columns and not pd.api.types.is_numeric_dtype(frame[name]) else "numeric",
            }
        )
    importance.sort(key=lambda item: item["mean_abs_shap"], reverse=True)
    return importance


def global_explanation(db: Session, deployment: Deployment, *, top_n: int = 15) -> dict[str, Any]:
    bundle, version, model, project = load_bundle_for_deployment(db, deployment)
    cache_key = f"{version.id}:{version.artifact_hash}:{MAX_GLOBAL_ROWS}"
    with _CACHE_LOCK:
        cached = _GLOBAL_CACHE.get(cache_key)
    if cached:
        return {**cached, "cached": True}
    frame, reference_info = _reference_frame(db, version)
    values, method, encoded_names = _shap_for_frame(bundle, frame)
    feature_columns = bundle.get("feature_columns") or []
    importance = _aggregate_global(values, frame, encoded_names, feature_columns)
    warnings = [
        SHAP_WARNING,
        "Global importance is computed on a random sample of the linked training data, not live traffic.",
    ]
    if reference_info["rows_used"] < 50:
        warnings.append("The reference sample is small; global importance may be unstable.")
    payload = {
        "deployment_id": deployment.id,
        "deployment_name": deployment.name,
        "model_id": model.id,
        "model_name": model.name,
        "model_version_id": version.id,
        "model_version": version.version,
        "task_type": bundle.get("task_type"),
        "target_column": bundle.get("target_column"),
        "method": method,
        "sample_size": reference_info["rows_used"],
        "reference": reference_info,
        "global_importance": importance[: max(1, top_n)],
        "all_feature_count": len(importance),
        "class_labels": bundle.get("class_labels") or [],
        "warnings": warnings,
        "generated_at": datetime.now(UTC).isoformat(),
        "cached": False,
    }
    with _CACHE_LOCK:
        if len(_GLOBAL_CACHE) > 32:
            _GLOBAL_CACHE.clear()
        _GLOBAL_CACHE[cache_key] = payload
    return payload


def local_explanation(
    db: Session, deployment: Deployment, features: dict[str, Any], *, top_n: int = 10
) -> dict[str, Any]:
    bundle, version, model, project = load_bundle_for_deployment(db, deployment)
    validated = validate_features(bundle, features)
    frame = pd.DataFrame([validated], columns=bundle["feature_columns"])
    values, method, encoded_names = _shap_for_frame(bundle, frame)
    feature_columns = bundle.get("feature_columns") or []
    prediction = bundle["pipeline"].predict(frame)
    class_index = 0
    if bundle.get("task_type") == "classification":
        class_index = int(prediction[0])
    row = values[0, :, class_index] if values.ndim == 3 else values[0]
    base_value = None
    try:
        import shap

        preprocessor = bundle["pipeline"].named_steps["preprocessor"]
        estimator = bundle["pipeline"].named_steps["model"]
        if method == "TreeExplainer":
            expected = shap.TreeExplainer(estimator).expected_value
        else:
            expected = shap.LinearExplainer(estimator, preprocessor.transform(frame)).expected_value
        expected = np.asarray(expected, dtype=float).ravel()
        if len(expected) > 1:
            base_value = float(expected[min(class_index, len(expected) - 1)])
        else:
            base_value = float(expected[0])
    except Exception:
        base_value = None

    grouped: dict[str, float] = {}
    for index, encoded in enumerate(encoded_names):
        original = _original_feature(encoded, feature_columns)
        grouped[original] = grouped.get(original, 0.0) + float(row[index])
    contributions = [
        {
            "feature": name,
            "value": jsonable(validated.get(name)),
            "contribution": round(value, 6),
            "direction": "increases" if value > 0 else "decreases" if value < 0 else "neutral",
        }
        for name, value in grouped.items()
    ]
    contributions.sort(key=lambda item: abs(item["contribution"]), reverse=True)
    probabilities = None
    if bundle.get("task_type") == "classification" and hasattr(bundle["pipeline"], "predict_proba"):
        proba = bundle["pipeline"].predict_proba(frame)[0]
        labels = bundle.get("class_labels") or []
        probabilities = {
            labels[i] if i < len(labels) else str(i): float(v) for i, v in enumerate(proba)
        }
    label = (
        (bundle.get("class_labels") or [])[class_index]
        if bundle.get("task_type") == "classification" and class_index < len(bundle.get("class_labels") or [])
        else float(prediction[0])
    )
    warnings = [SHAP_WARNING]
    if bundle.get("task_type") == "classification" and len(bundle.get("class_labels") or []) > 2:
        warnings.append("Contributions are shown for the predicted class in a multi-class model.")
    if bundle.get("task_type") == "classification" and len(bundle.get("class_labels") or []) == 2:
        warnings.append("For binary models, SHAP values describe contribution toward the positive class.")
    if len(feature_columns) > 0 and abs(sum(grouped.values()) - float(row.sum())) > 1e-6:
        warnings.append("Some encoded contributions could not be mapped to a source column.")
    return {
        "deployment_id": deployment.id,
        "model_version_id": version.id,
        "model_version": version.version,
        "model_name": model.name,
        "task_type": bundle.get("task_type"),
        "method": method,
        "prediction": label,
        "probabilities": probabilities,
        "base_value": base_value,
        "contributions": contributions[: max(1, top_n)],
        "all_feature_count": len(contributions),
        "input": validated,
        "warnings": warnings,
    }


def clear_explanation_cache(version_id: str | None = None) -> None:
    with _CACHE_LOCK:
        if version_id is None:
            _GLOBAL_CACHE.clear()
        else:
            for key in list(_GLOBAL_CACHE):
                if key.startswith(version_id + ":"):
                    del _GLOBAL_CACHE[key]
