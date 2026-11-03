from __future__ import annotations

import io
import logging
import math
import tempfile
import time
import traceback
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    log_loss,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import KFold, StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import LabelEncoder, OneHotEncoder, StandardScaler
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.errors import AppError
from app.models import (
    ModelVersion,
    PipelineJob,
    Project,
    RegisteredModel,
    TrainingRun,
    User,
)
from app.observability import PIPELINE_JOBS, TRAINING_JOBS
from app.services.datasets import feature_columns_for_training, get_dataset_version, load_dataset_frame
from app.services.mlflow_tracker import tracker
from app.services.storage import storage
from app.utils import jsonable, sha256_bytes, utcnow

logger = logging.getLogger(__name__)

ALGORITHM_CATALOG: dict[str, dict[str, dict[str, str]]] = {
    "classification": {
        "logistic_regression": {"label": "Logistic Regression", "family": "linear"},
        "random_forest": {"label": "Random Forest", "family": "tree"},
        "xgboost": {"label": "XGBoost", "family": "tree"},
    },
    "regression": {
        "linear_regression": {"label": "Linear Regression", "family": "linear"},
        "random_forest_regressor": {"label": "Random Forest Regressor", "family": "tree"},
        "xgboost_regressor": {"label": "XGBoost Regressor", "family": "tree"},
    },
}

METRIC_DIRECTIONS = {
    "accuracy": "higher",
    "precision_macro": "higher",
    "recall_macro": "higher",
    "f1_macro": "higher",
    "roc_auc": "higher",
    "r2": "higher",
    "mae": "lower",
    "rmse": "lower",
    "mape": "lower",
}


def get_algorithm_catalog(task_type: str) -> list[dict[str, str]]:
    return [{"key": key, **value} for key, value in ALGORITHM_CATALOG.get(task_type, {}).items()]


def _make_estimator(algorithm: str, task_type: str, params: dict[str, Any], seed: int, scale_pos_weight: float = 1.0) -> Any:
    if task_type == "classification":
        if algorithm == "logistic_regression":
            class_weight = params.get("class_weight", "balanced")
            return LogisticRegression(
                C=params.get("C", 1.0),
                class_weight=None if class_weight == "none" else class_weight,
                max_iter=params.get("max_iter", 2000),
                random_state=seed,
            )
        if algorithm == "random_forest":
            class_weight = params.get("class_weight", "balanced")
            return RandomForestClassifier(
                n_estimators=int(params.get("n_estimators", 300)),
                max_depth=params.get("max_depth"),
                min_samples_leaf=int(params.get("min_samples_leaf", 1)),
                max_features=params.get("max_features", "sqrt"),
                class_weight=None if class_weight == "none" else class_weight,
                random_state=seed,
                n_jobs=2,
            )
        if algorithm == "xgboost":
            from xgboost import XGBClassifier

            return XGBClassifier(
                n_estimators=int(params.get("n_estimators", 300)),
                max_depth=int(params.get("max_depth", 4)),
                learning_rate=float(params.get("learning_rate", 0.07)),
                subsample=float(params.get("subsample", 0.9)),
                colsample_bytree=float(params.get("colsample_bytree", 0.9)),
                reg_lambda=float(params.get("reg_lambda", 1.0)),
                scale_pos_weight=scale_pos_weight,
                random_state=seed,
                n_jobs=2,
                verbosity=0,
            )
    else:
        if algorithm == "linear_regression":
            return LinearRegression(fit_intercept=params.get("fit_intercept", True))
        if algorithm == "random_forest_regressor":
            return RandomForestRegressor(
                n_estimators=int(params.get("n_estimators", 300)),
                max_depth=params.get("max_depth"),
                min_samples_leaf=int(params.get("min_samples_leaf", 1)),
                max_features=params.get("max_features", 1.0),
                random_state=seed,
                n_jobs=2,
            )
        if algorithm == "xgboost_regressor":
            from xgboost import XGBRegressor

            return XGBRegressor(
                n_estimators=int(params.get("n_estimators", 300)),
                max_depth=int(params.get("max_depth", 4)),
                learning_rate=float(params.get("learning_rate", 0.07)),
                subsample=float(params.get("subsample", 0.9)),
                colsample_bytree=float(params.get("colsample_bytree", 0.9)),
                reg_lambda=float(params.get("reg_lambda", 1.0)),
                random_state=seed,
                n_jobs=2,
                verbosity=0,
            )
    raise AppError(422, "unsupported_algorithm", f"Unsupported algorithm '{algorithm}'.")


def build_preprocessor(feature_columns: list[str], df: pd.DataFrame) -> tuple[ColumnTransformer, list[str], list[str]]:
    numeric = [
        column
        for column in feature_columns
        if pd.api.types.is_numeric_dtype(df[column]) and not pd.api.types.is_bool_dtype(df[column])
    ]
    categorical = [column for column in feature_columns if column not in numeric]
    numeric_pipeline = Pipeline(
        [
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
        ]
    )
    categorical_pipeline = Pipeline(
        [
            ("imputer", SimpleImputer(strategy="most_frequent")),
            (
                "onehot",
                OneHotEncoder(
                    handle_unknown="ignore",
                    sparse_output=False,
                    max_categories=50,
                    min_frequency=1,
                ),
            ),
        ]
    )
    transformers = []
    if numeric:
        transformers.append(("num", numeric_pipeline, numeric))
    if categorical:
        transformers.append(("cat", categorical_pipeline, categorical))
    preprocessor = ColumnTransformer(transformers=transformers, remainder="drop", verbose_feature_names_out=False)
    return preprocessor, numeric, categorical


def build_pipeline(
    feature_columns: list[str],
    df: pd.DataFrame,
    estimator: Any,
) -> Pipeline:
    preprocessor, _, _ = build_preprocessor(feature_columns, df)
    return Pipeline([("preprocessor", preprocessor), ("model", estimator)])


def classification_metrics(y_true: np.ndarray, y_pred: np.ndarray, proba: np.ndarray | None, class_labels: list[str]) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "precision_macro": float(precision_score(y_true, y_pred, average="macro", zero_division=0)),
        "recall_macro": float(recall_score(y_true, y_pred, average="macro", zero_division=0)),
        "f1_macro": float(f1_score(y_true, y_pred, average="macro", zero_division=0)),
        "sample_count": len(y_true),
        "class_labels": class_labels,
    }
    if proba is not None:
        try:
            if proba.shape[1] == 2:
                metrics["roc_auc"] = float(roc_auc_score(y_true, proba[:, 1]))
            elif len(np.unique(y_true)) > 1:
                metrics["roc_auc"] = float(
                    roc_auc_score(y_true, proba, multi_class="ovr", labels=list(range(proba.shape[1])))
                )
        except ValueError:
            pass
        try:
            metrics["log_loss"] = float(log_loss(y_true, proba, labels=list(range(proba.shape[1]))))
        except ValueError:
            pass
    labels = list(range(len(class_labels)))
    matrix = confusion_matrix(y_true, y_pred, labels=labels)
    metrics["confusion_matrix"] = matrix.tolist()
    metrics["per_class"] = {}
    for index, label in enumerate(class_labels):
        mask = np.asarray(y_true) == index
        if mask.sum() == 0:
            continue
        metrics["per_class"][label] = {
            "support": int(mask.sum()),
            "precision": float(precision_score(mask, (np.asarray(y_pred) == index), zero_division=0)),
            "recall": float(recall_score(mask, (np.asarray(y_pred) == index), zero_division=0)),
        }
    return metrics


def regression_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, Any]:
    mse = mean_squared_error(y_true, y_pred)
    nonzero = np.abs(y_true) > 1e-9
    mape = (
        float(np.mean(np.abs((y_true[nonzero] - y_pred[nonzero]) / y_true[nonzero])) * 100)
        if nonzero.any()
        else None
    )
    return {
        "mae": float(mean_absolute_error(y_true, y_pred)),
        "mse": float(mse),
        "rmse": float(math.sqrt(mse)),
        "r2": float(r2_score(y_true, y_pred)) if len(y_true) > 1 else 0.0,
        "mape": mape,
        "sample_count": len(y_true),
        "residual_mean": float(np.mean(np.asarray(y_pred) - np.asarray(y_true))),
    }


def evaluate_predictions(
    task_type: str,
    y_true: Any,
    preds: Any,
    proba: Any | None,
    class_labels: list[str] | None = None,
) -> dict[str, Any]:
    if task_type == "classification":
        return classification_metrics(
            np.asarray(y_true), np.asarray(preds), proba, class_labels or [str(v) for v in sorted(set(y_true))]
        )
    return regression_metrics(np.asarray(y_true, dtype=float), np.asarray(preds, dtype=float))


def prediction_distribution(
    task_type: str, preds: np.ndarray, class_labels: list[str], proba: np.ndarray | None = None
) -> dict[str, Any]:
    if task_type == "classification":
        values, counts = np.unique(preds, return_counts=True)
        total = max(1, int(counts.sum()))
        return {
            "kind": "classification",
            "distribution": [
                {"value": class_labels[int(value)] if int(value) < len(class_labels) else str(value), "share": float(count / total)}
                for value, count in zip(values, counts, strict=False)
            ],
            "sample_count": int(counts.sum()),
        }
    preds = np.asarray(preds, dtype=float)
    if preds.size == 0:
        return {"kind": "regression", "sample_count": 0}
    counts, edges = np.histogram(preds, bins=min(20, max(5, int(math.sqrt(preds.size)))))
    total = max(1, int(counts.sum()))
    return {
        "kind": "regression",
        "bins": [float(edge) for edge in edges],
        "shares": [float(count / total) for count in counts],
        "mean": float(preds.mean()),
        "std": float(preds.std()),
        "min": float(preds.min()),
        "max": float(preds.max()),
        "sample_count": int(preds.size),
    }


def _append_log(job: PipelineJob, message: str) -> None:
    timestamp = datetime.now(UTC).strftime("%H:%M:%S")
    job.logs = (job.logs + f"[{timestamp}] {message}\n")[-120_000:]


def update_job(
    db: Session,
    job: PipelineJob,
    *,
    message: str | None = None,
    progress: int | None = None,
    stage: str | None = None,
    status: str | None = None,
    commit: bool = True,
) -> None:
    if message:
        _append_log(job, message)
    if progress is not None:
        job.progress = max(0, min(100, int(progress)))
    if stage:
        job.stage = stage
    if status:
        job.status = status
        if status == "running" and job.started_at is None:
            job.started_at = utcnow()
        if status in {"succeeded", "failed", "cancelled"}:
            job.finished_at = utcnow()
    if commit:
        db.commit()


def _metric_value(metrics: dict[str, Any], name: str) -> float | None:
    value = metrics.get(name)
    try:
        return float(value) if value is not None and math.isfinite(float(value)) else None
    except (TypeError, ValueError):
        return None


def selection_metric(task_type: str, metrics: dict[str, Any]) -> tuple[str, float | None]:
    if task_type == "classification":
        value = _metric_value(metrics, "roc_auc")
        if value is not None:
            return "roc_auc", value
        return "f1_macro", _metric_value(metrics, "f1_macro")
    return "rmse", _metric_value(metrics, "rmse")


def primary_validation_metric(task_type: str, metrics: dict[str, Any]) -> tuple[str, float | None]:
    if task_type == "classification":
        value = _metric_value(metrics, "roc_auc")
        if value is not None:
            return "roc_auc", value
        return "f1_macro", _metric_value(metrics, "f1_macro")
    return "r2", _metric_value(metrics, "r2")


def _validation_checks(
    project: Project,
    task_type: str,
    test_metrics: dict[str, Any],
    train_metrics: dict[str, Any],
    test_sample_size: int,
    artifact_ok: bool,
) -> dict[str, Any]:
    policy = (project.config_json or {}).get("promotion_policy", {}) or {}
    metric_name, metric_value = primary_validation_metric(task_type, test_metrics)
    train_metric_name, train_metric_value = primary_validation_metric(task_type, train_metrics)
    default_min = 0.60 if task_type == "classification" else 0.30
    min_metric = float(policy.get("min_primary_metric", default_min))
    max_gap = float(policy.get("max_generalization_gap", 0.30))
    min_test_samples = int(policy.get("min_test_samples", 20))
    checks = [
        {
            "name": "held_out_test_size",
            "passed": test_sample_size >= min_test_samples,
            "observed": test_sample_size,
            "threshold": min_test_samples,
            "message": f"At least {min_test_samples} held-out test rows are required.",
        },
        {
            "name": f"min_{metric_name}",
            "passed": metric_value is None or metric_value >= min_metric,
            "observed": metric_value,
            "threshold": min_metric,
            "message": f"Held-out {metric_name} must meet the configured promotion threshold.",
        },
        {
            "name": "artifact_integrity",
            "passed": artifact_ok,
            "observed": artifact_ok,
            "threshold": True,
            "message": "Saved model artifact must match its recorded SHA-256 hash.",
        },
    ]
    gap = None
    if metric_value is not None and train_metric_value is not None and train_metric_name == metric_name:
        gap = max(0.0, train_metric_value - metric_value) if METRIC_DIRECTIONS.get(metric_name) == "higher" else abs(train_metric_value - metric_value)
        checks.append(
            {
                "name": "generalization_gap",
                "passed": gap <= max_gap,
                "observed": float(gap),
                "threshold": max_gap,
                "message": "Train-to-held-out performance gap must stay within the configured tolerance.",
            }
        )
    passed = all(bool(check["passed"]) for check in checks)
    return {
        "status": "passed" if passed else "failed",
        "evaluated_on": "held_out_test_set",
        "evaluated_at": utcnow().isoformat(),
        "primary_metric": metric_name,
        "primary_value": metric_value,
        "train_metric": train_metric_value,
        "checks": checks,
        "policy": {
            "min_primary_metric": min_metric,
            "max_generalization_gap": max_gap,
            "min_test_samples": min_test_samples,
            "note": "Approval is always a manual action. A passing score never auto-promotes a model.",
        },
    }


def _suggest_params(trial: Any, algorithm: str, task_type: str) -> dict[str, Any]:
    if algorithm == "logistic_regression":
        return {
            "C": trial.suggest_float("C", 1e-3, 30.0, log=True),
            "class_weight": trial.suggest_categorical("class_weight", ["balanced", "none"]),
        }
    if algorithm == "random_forest":
        return {
            "n_estimators": trial.suggest_int("n_estimators", 120, 400, step=40),
            "max_depth": trial.suggest_int("max_depth", 3, 20),
            "min_samples_leaf": trial.suggest_int("min_samples_leaf", 1, 10),
            "max_features": trial.suggest_categorical("max_features", ["sqrt", "log2"]),
            "class_weight": trial.suggest_categorical("class_weight", ["balanced", "none"]),
        }
    if algorithm == "xgboost":
        return {
            "n_estimators": trial.suggest_int("n_estimators", 120, 400, step=40),
            "max_depth": trial.suggest_int("max_depth", 2, 8),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
            "subsample": trial.suggest_float("subsample", 0.6, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.6, 1.0),
            "reg_lambda": trial.suggest_float("reg_lambda", 0.1, 10.0, log=True),
        }
    if algorithm == "random_forest_regressor":
        return {
            "n_estimators": trial.suggest_int("n_estimators", 120, 400, step=40),
            "max_depth": trial.suggest_int("max_depth", 3, 20),
            "min_samples_leaf": trial.suggest_int("min_samples_leaf", 1, 10),
            "max_features": trial.suggest_categorical("max_features", [0.6, 0.8, 1.0]),
        }
    if algorithm == "xgboost_regressor":
        return {
            "n_estimators": trial.suggest_int("n_estimators", 120, 400, step=40),
            "max_depth": trial.suggest_int("max_depth", 2, 8),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
            "subsample": trial.suggest_float("subsample", 0.6, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.6, 1.0),
            "reg_lambda": trial.suggest_float("reg_lambda", 0.1, 10.0, log=True),
        }
    return {}


def _hpo(
    algorithm: str,
    task_type: str,
    X_train: pd.DataFrame,
    y_train: Any,
    feature_columns: list[str],
    seed: int,
    n_trials: int,
    scale_pos_weight: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if algorithm in {"linear_regression"}:
        return {}, []
    import optuna

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    trials_log: list[dict[str, Any]] = []

    def objective(trial: Any) -> float:
        params = _suggest_params(trial, algorithm, task_type)
        estimator = _make_estimator(algorithm, task_type, params, seed, scale_pos_weight)
        pipeline = build_pipeline(feature_columns, X_train, estimator)
        if task_type == "classification":
            min_count = int(pd.Series(y_train).value_counts().min())
            n_splits = max(2, min(3, min_count))
            cv = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=seed)
            scores = cross_val_score(pipeline, X_train, y_train, cv=cv, scoring="f1_macro", n_jobs=1)
        else:
            cv = KFold(n_splits=3, shuffle=True, random_state=seed)
            scores = cross_val_score(
                pipeline, X_train, y_train, cv=cv, scoring="neg_root_mean_squared_error", n_jobs=1
            )
        score = float(np.mean(scores))
        trials_log.append({"trial": trial.number, "score": score, "params": params})
        return score

    study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=seed))
    study.optimize(objective, n_trials=n_trials, timeout=300, catch=(Exception,))
    if not trials_log:
        return {}, trials_log
    return study.best_params, trials_log


def _feature_schema(profile: dict[str, Any], feature_columns: list[str]) -> list[dict[str, Any]]:
    by_name = {item["name"]: item for item in profile.get("columns", [])}
    schema = []
    for column in feature_columns:
        item = by_name.get(column, {"name": column, "kind": "categorical", "nullable": True, "examples": []})
        entry = {
            "name": column,
            "kind": item.get("kind", "categorical"),
            "dtype": item.get("dtype", "object"),
            "nullable": bool(item.get("nullable", True)),
            "examples": item.get("examples", [])[:3],
        }
        numeric_stats = (profile.get("numeric_summary") or {}).get(column)
        if numeric_stats:
            entry["range"] = {
                "min": numeric_stats.get("min"),
                "max": numeric_stats.get("max"),
                "p50": numeric_stats.get("p50"),
            }
        schema.append(entry)
    return schema


def _flatten_metrics(prefix: str, metrics: dict[str, Any]) -> dict[str, float]:
    flat: dict[str, float] = {}
    for key, value in metrics.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value == value:
            flat[f"{prefix}{key}"] = float(value)
    return flat


def run_training_job(job_id: str) -> None:
    db = SessionLocal()
    job: PipelineJob | None = None
    training_run: TrainingRun | None = None
    mlflow_run_id: str | None = None
    try:
        job = db.get(PipelineJob, job_id)
        if not job:
            logger.error("training_job_missing", extra={"extra_fields": {"job_id": job_id}})
            return
        if job.status == "cancelled":
            return
        job.status = "running"
        job.started_at = utcnow()
        job.attempts += 1
        job.stage = "validating"
        job.progress = 5
        _append_log(job, "Training job started.")
        db.commit()

        params = job.params_json or {}
        project = db.get(Project, params["project_id"])
        if not project:
            raise AppError(404, "project_not_found", "Project no longer exists.")
        version = get_dataset_version(db, params["dataset_version_id"], project.id)
        user = db.get(User, job.triggered_by) or db.get(User, project.created_by)
        if not user:
            raise AppError(500, "actor_missing", "Cannot resolve job actor.")
        algorithms = params.get("algorithms") or list(ALGORITHM_CATALOG.get(project.task_type, {}).keys())
        for algorithm in algorithms:
            if algorithm not in ALGORITHM_CATALOG.get(project.task_type, {}):
                raise AppError(422, "unsupported_algorithm", f"Algorithm '{algorithm}' is not valid for this task.")
        algorithms = list(dict.fromkeys(algorithms))
        tune = bool(params.get("tune", False))
        n_trials = int(params.get("n_trials", 10))
        test_size = float(params.get("test_size", 0.2))
        random_state = int(params.get("random_state", 42))
        run_name = (params.get("model_name") or f"{project.name} · {', '.join(algorithms)}")[:200]

        experiment = tracker.ensure_experiment(db, project)
        training_run = TrainingRun(
            project_id=project.id,
            experiment_id=experiment.id,
            dataset_version_id=version.id,
            pipeline_job_id=job.id,
            name=run_name,
            algorithm=algorithms[0],
            status="running",
            created_by=user.id,
            started_at=utcnow(),
            git_commit=settings.git_commit or "unversioned",
        )
        db.add(training_run)
        db.flush()
        job.result_json = {"training_run_id": training_run.id}
        db.commit()
        update_job(db, job, message=f"Loaded dataset '{version.original_filename}' (v{version.version}).", progress=12, stage="profiling")

        started = time.perf_counter()
        mlflow_run_id = tracker.create_run(
            experiment.mlflow_experiment_id,
            run_name,
            tags={
                "mlops.project_id": project.id,
                "mlops.dataset_version_id": version.id,
                "mlops.source": "automated_training",
                "git.commit": settings.git_commit or "unversioned",
                "mlops.task_type": project.task_type,
            },
        )
        training_run.mlflow_run_id = mlflow_run_id
        db.commit()
        tracker.log_params(
            mlflow_run_id,
            {
                "algorithms": ",".join(algorithms),
                "tune": tune,
                "n_trials": n_trials if tune else 0,
                "test_size": test_size,
                "random_state": random_state,
                "task_type": project.task_type,
                "target_column": project.target_column,
                "dataset": version.original_filename,
                "dataset_version": version.version,
                "dataset_hash": version.content_hash,
            },
        )

        frame = load_dataset_frame(version)
        if project.target_column not in frame.columns:
            raise AppError(422, "target_missing", f"Target column '{project.target_column}' is missing from the dataset.")
        frame = frame[frame[project.target_column].notna()].copy()
        if len(frame) < 50:
            raise AppError(422, "insufficient_rows", "At least 50 labelled rows are required for training.")
        feature_columns, excluded_columns = feature_columns_for_training(
            frame, project.target_column, version.profile_json
        )
        if not feature_columns:
            raise AppError(422, "no_features", "No usable feature columns remain after excluding the target and identifiers.")
        update_job(
            db,
            job,
            message=(
                f"Profiled {len(frame):,} rows and {len(feature_columns)} features. "
                f"Excluded {len(excluded_columns)} identifier/PII/constant columns."
            ),
            progress=20,
            stage="splitting",
        )
        y_raw = frame[project.target_column]
        label_classes: list[str] = []
        positive_class: str | None = None
        scale_pos_weight = 1.0
        if project.task_type == "classification":
            encoder = LabelEncoder()
            y = encoder.fit_transform(y_raw.astype(str).str.strip())
            label_classes = [str(v) for v in encoder.classes_]
            if project.positive_label and project.positive_label in label_classes:
                positive_class = project.positive_label
            else:
                positive_class = label_classes[-1]
            if len(label_classes) == 2:
                positives = int((y == 1).sum())
                negatives = int((y == 0).sum())
                scale_pos_weight = negatives / max(1, positives)
        else:
            y = pd.to_numeric(y_raw, errors="coerce")
            if y.isna().any():
                valid = y.notna()
                frame = frame.loc[valid].copy()
                y = y.loc[valid]
            y = y.astype(float)
        X = frame[feature_columns].copy()
        if project.task_type == "classification":
            class_counts = pd.Series(y).value_counts()
            can_stratify = int(class_counts.min()) >= 2
            stratify = y if can_stratify else None
            X_train_full, X_test, y_train_full, y_test = train_test_split(
                X, y, test_size=test_size, random_state=random_state, stratify=stratify
            )
            try:
                X_train, X_val, y_train, y_val = train_test_split(
                    X_train_full,
                    y_train_full,
                    test_size=0.2,
                    random_state=random_state,
                    stratify=y_train_full if pd.Series(y_train_full).value_counts().min() >= 2 else None,
                )
            except ValueError:
                X_train, X_val, y_train, y_val = train_test_split(
                    X_train_full, y_train_full, test_size=0.2, random_state=random_state
                )
        else:
            X_train_full, X_test, y_train_full, y_test = train_test_split(
                X, y, test_size=test_size, random_state=random_state
            )
            X_train, X_val, y_train, y_val = train_test_split(
                X_train_full, y_train_full, test_size=0.2, random_state=random_state
            )
        if len(X_test) < 5:
            raise AppError(422, "test_set_too_small", "The held-out test set is too small. Add more labelled rows.")
        update_job(
            db,
            job,
            message=(
                f"Split complete: {len(X_train):,} train, {len(X_val):,} validation, {len(X_test):,} held-out test rows. "
                "Test rows are never used for model selection or tuning."
            ),
            progress=28,
            stage="baseline_models",
        )

        candidate_results: list[dict[str, Any]] = []
        best: dict[str, Any] | None = None
        for index, algorithm in enumerate(algorithms):
            candidate_started = time.perf_counter()
            estimator = _make_estimator(algorithm, project.task_type, {}, random_state, scale_pos_weight)
            pipeline = build_pipeline(feature_columns, X_train, estimator)
            candidate_run_id = tracker.create_run(
                experiment.mlflow_experiment_id,
                f"{run_name} · {algorithm} (baseline)",
                tags={
                    "mlops.parent_run_id": mlflow_run_id or "",
                    "mlops.candidate": algorithm,
                    "mlops.stage": "baseline",
                },
            )
            tracker.log_params(candidate_run_id, {"algorithm": algorithm, "stage": "baseline"})
            pipeline.fit(X_train, y_train)
            if project.task_type == "classification":
                val_pred = pipeline.predict(X_val)
                val_proba = pipeline.predict_proba(X_val) if hasattr(pipeline, "predict_proba") else None
                val_metrics = classification_metrics(y_val, val_pred, val_proba, label_classes)
            else:
                val_pred = pipeline.predict(X_val)
                val_metrics = regression_metrics(y_val, val_pred)
            metric_name, metric_value = selection_metric(project.task_type, val_metrics)
            score = metric_value if metric_name in {"roc_auc", "f1_macro"} else -float(metric_value or 0)
            duration = time.perf_counter() - candidate_started
            candidate = {
                "algorithm": algorithm,
                "label": ALGORITHM_CATALOG[project.task_type][algorithm]["label"],
                "params": {},
                "validation_metrics": jsonable(val_metrics),
                "selection_metric": metric_name,
                "selection_score": jsonable(score),
                "duration_seconds": round(duration, 3),
                "tuned": False,
            }
            candidate_results.append(candidate)
            tracker.log_metrics(candidate_run_id, _flatten_metrics("validation_", val_metrics))
            tracker.log_metrics(candidate_run_id, {f"selection_{metric_name}": score})
            tracker.end_run(candidate_run_id)
            if best is None or score > best["_score"]:
                best = {
                    **candidate,
                    "_score": score,
                    "_params": {},
                }
            update_job(
                db,
                job,
                message=f"Baseline {candidate['label']}: validation {metric_name}={metric_value:.4f} ({duration:.1f}s)."
                if metric_value is not None
                else f"Baseline {candidate['label']} trained.",
                progress=30 + int((index + 1) / len(algorithms) * 25),
                stage="baseline_models",
            )

        if not best:
            raise AppError(500, "training_failed", "No candidate model could be trained.")

        if tune:
            update_job(
                db,
                job,
                message=f"Running Optuna tuning for {best['label']} ({n_trials} trials, training folds only).",
                progress=58,
                stage="hyperparameter_tuning",
            )
            tuned_params, trials = _hpo(
                best["algorithm"],
                project.task_type,
                X_train,
                y_train,
                feature_columns,
                random_state,
                n_trials,
                scale_pos_weight,
            )
            tracker.log_json(mlflow_run_id, "optuna_trials.json", trials, artifact_path="tuning")
            if tuned_params:
                tuned_estimator = _make_estimator(best["algorithm"], project.task_type, tuned_params, random_state, scale_pos_weight)
                tuned_pipeline = build_pipeline(feature_columns, X_train, tuned_estimator)
                tuned_pipeline.fit(X_train, y_train)
                if project.task_type == "classification":
                    tuned_val_metrics = classification_metrics(
                        y_val,
                        tuned_pipeline.predict(X_val),
                        tuned_pipeline.predict_proba(X_val),
                        label_classes,
                    )
                else:
                    tuned_val_metrics = regression_metrics(y_val, tuned_pipeline.predict(X_val))
                tuned_metric_name, tuned_metric_value = selection_metric(project.task_type, tuned_val_metrics)
                tuned_score = (
                    float(tuned_metric_value or 0)
                    if tuned_metric_name in {"roc_auc", "f1_macro"}
                    else -float(tuned_metric_value or 0)
                )
                tuned_candidate = {
                    "algorithm": best["algorithm"],
                    "label": ALGORITHM_CATALOG[project.task_type][best["algorithm"]]["label"],
                    "params": tuned_params,
                    "validation_metrics": jsonable(tuned_val_metrics),
                    "selection_metric": tuned_metric_name,
                    "selection_score": jsonable(tuned_score),
                    "duration_seconds": None,
                    "tuned": True,
                    "trials": len(trials),
                }
                candidate_results.append(tuned_candidate)
                tracker.log_params(
                    mlflow_run_id,
                    {f"tuned_{key}": value for key, value in tuned_params.items()},
                )
                tracker.log_metrics(mlflow_run_id, _flatten_metrics("tuned_validation_", tuned_val_metrics))
                if tuned_score > float(best.get("_score", float("-inf"))):
                    best = {**tuned_candidate, "_score": tuned_score, "_params": tuned_params}
                previous_score = float(best.get("_score", float("-inf")))
                update_job(
                    db,
                    job,
                    message=f"Tuned validation {tuned_metric_name}={tuned_metric_value:.4f}. "
                    + ("Tuned model selected." if tuned_score > previous_score else "Baseline retained."),
                    progress=68,
                    stage="hyperparameter_tuning",
                )
            else:
                update_job(db, job, message="No tunable hyperparameters for this algorithm; baseline retained.", progress=68)

        selected_params = best.get("_params", {})
        update_job(
            db,
            job,
            message=f"Refitting selected {best['label']} on all non-test rows and evaluating the held-out test set.",
            progress=74,
            stage="final_evaluation",
        )
        final_estimator = _make_estimator(
            best["algorithm"], project.task_type, selected_params, random_state, scale_pos_weight
        )
        final_pipeline = build_pipeline(feature_columns, X_train_full, final_estimator)
        final_pipeline.fit(X_train_full, y_train_full)
        final_pred = final_pipeline.predict(X_test)
        final_proba = final_pipeline.predict_proba(X_test) if hasattr(final_pipeline, "predict_proba") else None
        if project.task_type == "classification":
            test_metrics = classification_metrics(y_test, final_pred, final_proba, label_classes)
        else:
            test_metrics = regression_metrics(y_test, final_pred)

        train_pred = final_pipeline.predict(X_train_full)
        train_proba = (
            final_pipeline.predict_proba(X_train_full) if hasattr(final_pipeline, "predict_proba") else None
        )
        if project.task_type == "classification":
            train_metrics = classification_metrics(y_train_full, train_pred, train_proba, label_classes)
        else:
            train_metrics = regression_metrics(y_train_full, train_pred)

        distribution = prediction_distribution(project.task_type, np.asarray(final_pred), label_classes, final_proba)
        params_out = {
            "algorithm": best["algorithm"],
            "algorithm_label": best["label"],
            "hyperparameters": selected_params,
            "tuned": bool(best.get("tuned")),
            "test_size": test_size,
            "random_state": random_state,
            "feature_count": len(feature_columns),
            "excluded_columns": excluded_columns,
            "dataset_version": version.version,
            "target_column": project.target_column,
        }
        feature_schema = _feature_schema(version.profile_json, feature_columns)

        update_job(db, job, message="Serializing model and preprocessing pipeline.", progress=84, stage="saving_artifact")
        bundle = {
            "schema_version": 1,
            "pipeline": final_pipeline,
            "task_type": project.task_type,
            "target_column": project.target_column,
            "feature_columns": feature_columns,
            "feature_schema": feature_schema,
            "class_labels": label_classes,
            "positive_class": positive_class,
            "metrics": jsonable(test_metrics),
            "params": jsonable(params_out),
            "project_id": project.id,
            "project_name": project.name,
            "dataset_version_id": version.id,
            "dataset_version": version.version,
            "mlflow_run_id": mlflow_run_id,
            "trained_at": utcnow().isoformat(),
        }
        buffer = io.BytesIO()
        joblib.dump(bundle, buffer, compress=3)
        artifact_bytes = buffer.getvalue()
        artifact_hash = sha256_bytes(artifact_bytes)
        artifact_key = f"artifacts/projects/{project.id}/runs/{training_run.id}/model_bundle.joblib"
        storage.save_bytes(artifact_key, artifact_bytes, content_type="application/octet-stream")
        artifact_ok = sha256_bytes(storage.read_bytes(artifact_key)) == artifact_hash

        with tempfile.TemporaryDirectory() as directory:
            local_bundle = Path(directory) / "model_bundle.joblib"
            local_bundle.write_bytes(artifact_bytes)
            tracker.log_artifact(mlflow_run_id, str(local_bundle), artifact_path="bundle")

        model_uri = tracker.log_model(mlflow_run_id, final_pipeline, X_test.head(10))

        validation = _validation_checks(
            project,
            project.task_type,
            test_metrics,
            train_metrics,
            len(X_test),
            artifact_ok,
        )
        validation["label_classes"] = label_classes
        validation["positive_class"] = positive_class

        registered_model = db.scalar(
            select(RegisteredModel).where(
                RegisteredModel.project_id == project.id,
                func.lower(RegisteredModel.name) == project.name.lower(),
            )
        )
        if not registered_model:
            registered_model = RegisteredModel(
                project_id=project.id,
                name=project.name,
                description=f"Registered models for {project.name}",
                task_type=project.task_type,
                created_by=user.id,
            )
            db.add(registered_model)
            db.flush()
        next_version = int(
            db.scalar(
                select(func.max(ModelVersion.version)).where(
                    ModelVersion.registered_model_id == registered_model.id
                )
            )
            or 0
        ) + 1

        model_card = {
            "intended_use": f"Predict '{project.target_column}' for {project.task_type} use cases in {project.name}.",
            "limitations": (
                "Trained on the linked dataset version only. Performance on populations outside the training "
                "distribution is not guaranteed; monitor drift and labels before relying on predictions."
            ),
            "training_data": f"{version.original_filename} (version {version.version}), {len(frame):,} labelled rows.",
            "evaluation": (
                f"Held-out test set of {len(X_test):,} rows. Primary validation metric: "
                f"{validation['primary_metric']}={validation['primary_value']}."
            ),
            "ethical_considerations": (
                "Review excluded/protected attributes and intended use. This automated card is a starting point, "
                "not a completed governance review."
            ),
            "owner": user.full_name,
        }

        mlflow_model_uri, mlflow_model_version = tracker.register_model(
            project=project,
            local_version=next_version,
            run_id=mlflow_run_id,
            description=f"{project.name} local version {next_version}",
            metadata={"validation_status": validation["status"], "approval_status": "pending"},
        )

        model_version = ModelVersion(
            registered_model_id=registered_model.id,
            project_id=project.id,
            version=next_version,
            training_run_id=training_run.id,
            dataset_version_id=version.id,
            mlflow_run_id=mlflow_run_id,
            mlflow_model_uri=mlflow_model_uri or model_uri,
            mlflow_model_version=mlflow_model_version,
            artifact_key=artifact_key,
            artifact_hash=artifact_hash,
            stage="none",
            approval_status="pending",
            validation_status=validation["status"],
            validation_json=jsonable(validation),
            metrics_json=jsonable(test_metrics),
            params_json=jsonable(params_out),
            model_card_json=model_card,
            feature_schema_json=feature_schema,
            prediction_distribution_json=jsonable(distribution),
            created_by=user.id,
        )
        db.add(model_version)
        db.flush()

        duration = time.perf_counter() - started
        training_run.algorithm = best["algorithm"]
        training_run.status = "succeeded"
        training_run.message = (
            f"Completed. {validation['status'].capitalize()} validation. Model version {next_version} awaits approval."
        )
        training_run.params_json = jsonable(params_out)
        training_run.metrics_json = jsonable(test_metrics)
        training_run.validation_metrics_json = jsonable(test_metrics)
        training_run.train_metrics_json = jsonable(train_metrics)
        training_run.candidate_results_json = jsonable(candidate_results)
        training_run.feature_columns_json = feature_columns
        training_run.target_summary_json = version.profile_json.get("target", {})
        training_run.prediction_distribution_json = jsonable(distribution)
        training_run.duration_seconds = round(duration, 2)
        training_run.artifact_key = artifact_key
        training_run.registered_model_id = registered_model.id
        training_run.model_version_id = model_version.id
        training_run.finished_at = utcnow()
        job.status = "succeeded"
        job.progress = 100
        job.stage = "complete"
        job.finished_at = utcnow()
        job.result_json = {
            "training_run_id": training_run.id,
            "model_version_id": model_version.id,
            "registered_model_id": registered_model.id,
            "model_version": next_version,
            "validation_status": validation["status"],
            "approval_status": "pending",
            "metrics": jsonable(test_metrics),
            "mlflow_run_id": mlflow_run_id,
            "mlflow_model_uri": mlflow_model_uri or model_uri,
            "artifact_hash": artifact_hash,
        }
        _append_log(
            job,
            f"Training succeeded in {duration:.1f}s. Registered local version {next_version}; approval required before deployment.",
        )
        db.commit()

        tracker.log_params(
            mlflow_run_id,
            {
                **{f"selected_{k}": v for k, v in selected_params.items()},
                "selected_algorithm": best["algorithm"],
                "feature_columns": ",".join(feature_columns)[:5000],
                "excluded_columns": ",".join(excluded_columns)[:2000],
            },
        )
        tracker.log_metrics(mlflow_run_id, _flatten_metrics("test_", test_metrics))
        tracker.log_metrics(mlflow_run_id, _flatten_metrics("train_", train_metrics))
        tracker.log_metrics(
            mlflow_run_id,
            {
                "duration_seconds": duration,
                "validation_passed": 1.0 if validation["status"] == "passed" else 0.0,
            },
        )
        tracker.log_tags(
            mlflow_run_id,
            {
                "mlops.validation_status": validation["status"],
                "mlops.approval_status": "pending",
                "mlops.model_version": next_version,
                "mlops.artifact_hash": artifact_hash,
            },
        )
        tracker.log_json(mlflow_run_id, "candidate_results.json", candidate_results, artifact_path="training")
        tracker.log_json(mlflow_run_id, "validation.json", validation, artifact_path="training")
        tracker.log_json(mlflow_run_id, "model_card.json", model_card, artifact_path="governance")
        tracker.log_json(mlflow_run_id, "feature_schema.json", feature_schema, artifact_path="training")
        tracker.end_run(mlflow_run_id)
        TRAINING_JOBS.labels("succeeded", project.task_type).inc()
        PIPELINE_JOBS.labels("training", "succeeded").inc()
    except Exception as exc:
        logger.error("training_job_failed", exc_info=True)
        db.rollback()
        try:
            job = db.get(PipelineJob, job_id)
            if job:
                job.status = "failed"
                job.stage = "failed"
                job.error = str(exc)[:4000]
                _append_log(job, f"Job failed: {str(exc)[:2000]}")
                job.finished_at = utcnow()
                job.attempts = job.attempts
                job.logs = (job.logs + traceback.format_exc(limit=4))[-120_000:]
                db.commit()
            training_run = db.get(TrainingRun, job.result_json.get("training_run_id")) if job and job.result_json else None
            if training_run:
                training_run.status = "failed"
                training_run.message = str(exc)[:2000]
                training_run.finished_at = utcnow()
                db.commit()
            if mlflow_run_id:
                tracker.end_run(mlflow_run_id, "FAILED")
            task_type = "unknown"
            if job and job.params_json and job.params_json.get("task_type"):
                task_type = str(job.params_json["task_type"])
            TRAINING_JOBS.labels("failed", task_type).inc()
            PIPELINE_JOBS.labels("training", "failed").inc()
        except Exception:
            logger.exception("training_job_failure_handler_failed")
    finally:
        db.close()
