from __future__ import annotations

import logging
import re
import warnings
from datetime import datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.errors import AppError, NotFoundError
from app.models import (
    Dataset,
    DatasetVersion,
    Deployment,
    DriftReport,
    DriftResult,
    FeatureSample,
    GroundTruthLabel,
    ModelVersion,
    PipelineJob,
    PredictionEvent,
    Project,
)
from app.observability import DRIFT_REPORTS, PIPELINE_JOBS
from app.services.alerts import evaluate_rules
from app.services.audit import record_audit
from app.services.datasets import get_dataset_version, load_dataset_frame
from app.services.monitoring import compute_performance
from app.services.statistics import (
    benjamini_hochberg,
    categorical_psi,
    chi_square_test,
    classification_distribution_psi,
    dataset_severity,
    ks_test,
    missing_rate,
    numeric_psi,
    regression_distribution_psi,
    safe_float,
    severity_from_psi,
)
from app.services.training import update_job
from app.utils import ensure_utc, jsonable, utcnow

logger = logging.getLogger(__name__)

VALUE_DRIFT_RE = re.compile(r"column=(?P<column>[^,]+).*?method=(?P<method>[^,]+)")


def _feature_kinds(
    project: Project,
    reference_version: DatasetVersion,
    model_version: ModelVersion | None,
) -> tuple[list[str], dict[str, str]]:
    if model_version and model_version.feature_schema_json:
        kinds = {field["name"]: field.get("kind", "categorical") for field in model_version.feature_schema_json}
        return list(kinds.keys()), kinds
    schema = reference_version.schema_json or []
    schema_map = {column["name"]: column for column in schema}
    expected = [
        column["name"]
        for column in schema
        if column["name"] != project.target_column and not column.get("is_pii_like")
    ]
    kinds = {name: schema_map.get(name, {}).get("kind", "categorical") for name in expected}
    return expected, kinds


def _prepare_frame(df: pd.DataFrame, features: list[str], kinds: dict[str, str]) -> pd.DataFrame:
    prepared = pd.DataFrame(index=df.index)
    for name in features:
        if name not in df.columns:
            prepared[name] = np.nan
            continue
        series = df[name]
        if kinds.get(name) == "numeric":
            prepared[name] = pd.to_numeric(series, errors="coerce")
        elif kinds.get(name) == "boolean":
            prepared[name] = series
        else:
            prepared[name] = series.where(series.isna(), series.astype(str))
    return prepared


def _sample_frame(df: pd.DataFrame, max_rows: int = 20_000, seed: int = 7) -> pd.DataFrame:
    if len(df) <= max_rows:
        return df
    return df.sample(n=max_rows, random_state=seed).reset_index(drop=True)


def _evidently_analysis(reference: pd.DataFrame, current: pd.DataFrame) -> tuple[dict[str, Any], str | None]:
    try:
        from evidently import Dataset, Report
        from evidently.presets import DataDriftPreset

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            report = Report(metrics=[DataDriftPreset()])
            snapshot = report.run(
                reference_data=Dataset.from_pandas(reference), current_data=Dataset.from_pandas(current)
            )
            result = jsonable(snapshot.dict())
        return result, None
    except Exception as exc:
        logger.warning("evidently_drift_failed", exc_info=True)
        return {}, str(exc)[:300]


def _parse_evidently(raw: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    by_feature: dict[str, dict[str, Any]] = {}
    dataset_summary: dict[str, Any] = {}
    for metric in raw.get("metrics", []) if isinstance(raw, dict) else []:
        name = str(metric.get("metric_name", ""))
        value = metric.get("value")
        config = metric.get("config") or {}
        if name.startswith("DriftedColumnsCount"):
            if isinstance(value, dict):
                dataset_summary = {
                    "drifted_columns": safe_float(value.get("count")),
                    "drift_share": safe_float(value.get("share")),
                }
            continue
        match = VALUE_DRIFT_RE.search(name)
        if match:
            column = config.get("column") or match.group("column")
            method = config.get("method") or match.group("method")
            threshold = safe_float(config.get("threshold")) or 0.05
            p_value = safe_float(value)
            by_feature[str(column)] = {
                "method": method,
                "p_value": p_value,
                "threshold": threshold,
                "drifted": bool(p_value is not None and p_value < threshold),
            }
    return by_feature, dataset_summary


def _recommend(feature: str, kind: str, psi: float | None, missing_shift: bool, drifted: bool, schema_change: bool) -> str:
    if schema_change:
        return f"Align the feature schema for '{feature}' between reference and production before retraining."
    if not drifted:
        return f"No material change detected for '{feature}'. Continue routine monitoring."
    if missing_shift:
        return (
            f"Investigate missing-value handling for '{feature}'. A change in null rate can indicate an upstream "
            "collection or join failure. Fix the pipeline before evaluating model quality."
        )
    if kind == "numeric":
        return (
            f"Compare upstream units, ranges, and population mix for '{feature}' (PSI={psi:.3f}). Slice by "
            "segment to locate the source; retrain only after confirming labels and intended behavior."
        )
    return (
        f"Review category inventory and upstream mappings for '{feature}' (PSI={psi:.3f}). New or heavily shifted "
        "categories may reflect population change or an encoding bug."
    )


def _load_current_from_samples(
    db: Session, deployment: Deployment, start: datetime, end: datetime
) -> tuple[pd.DataFrame, int, int]:
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
    frame = pd.DataFrame([sample.features_json for sample in samples])
    simulated = sum(1 for sample in samples if sample.simulated)
    return frame, len(samples), simulated


def _labels_available(db: Session, deployment: Deployment, start: datetime, end: datetime) -> int:
    return int(
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


def analyze_drift(
    db: Session,
    *,
    project: Project,
    reference_version: DatasetVersion,
    deployment: Deployment | None,
    current_version: DatasetVersion | None,
    window_start: datetime | None,
    window_end: datetime | None,
    actor_id: str | None = None,
) -> DriftReport:
    model_version: ModelVersion | None = None
    if deployment:
        model_version = db.get(ModelVersion, deployment.model_version_id)
    end = ensure_utc(window_end) or utcnow()
    start = ensure_utc(window_start) or (end - timedelta(days=7))
    reference_frame = load_dataset_frame(reference_version)
    if current_version:
        if current_version.dataset_id:
            dataset = db.get(Dataset, current_version.dataset_id)
            if not dataset or dataset.project_id != project.id:
                raise NotFoundError("Current dataset version does not belong to this project")
        current_frame = load_dataset_frame(current_version)
        current_size = len(current_frame)
        simulated_count = 0
        simulated = "synthetic demo" in (current_version.notes or "").lower()
        window = {"start": current_version.created_at, "end": current_version.created_at}
        current_source = f"dataset version {current_version.version}"
    else:
        if not deployment:
            raise AppError(422, "current_data_missing", "Provide a deployment or a current dataset version.")
        current_frame, current_size, simulated_count = _load_current_from_samples(db, deployment, start, end)
        simulated = current_size > 0 and simulated_count == current_size
        window = {"start": start, "end": end}
        current_source = "captured production feature samples"

    features, kinds = _feature_kinds(project, reference_version, model_version)
    if not features:
        raise AppError(422, "no_features", "No feature columns are available for drift analysis.")
    reference_prepared = _prepare_frame(reference_frame, features, kinds)
    current_prepared = _prepare_frame(current_frame, features, kinds)
    reference_prepared = _sample_frame(reference_prepared)
    current_prepared = _sample_frame(current_prepared)

    reference_size = len(reference_frame)
    current_sample_size = len(current_frame)
    schema_changes: dict[str, list[str]] = {"missing_features": [], "added_features": [], "type_changes": []}
    for feature in features:
        if feature not in current_frame.columns:
            schema_changes["missing_features"].append(feature)
    if current_version is not None:
        extra = [
            column
            for column in current_frame.columns
            if column not in features and column != project.target_column
        ]
        schema_changes["added_features"] = extra[:50]
        current_schema = {item["name"]: item for item in current_version.schema_json or []}
        reference_schema = {item["name"]: item for item in reference_version.schema_json or []}
        for feature in features:
            if (
                feature in current_schema
                and feature in reference_schema
                and current_schema[feature].get("kind") != reference_schema[feature].get("kind")
            ):
                schema_changes["type_changes"].append(
                    f"{feature}: {reference_schema[feature].get('kind')} → {current_schema[feature].get('kind')}"
                )

    config = (project.config_json or {}).get("drift", {}) or {}
    alpha = float(config.get("alpha", settings.drift_alpha))
    psi_threshold = float(config.get("psi_threshold", settings.drift_psi_threshold))
    share_threshold = float(config.get("share_threshold", settings.drift_share_threshold))
    min_samples = int(config.get("min_samples", settings.min_drift_samples))
    warnings: list[str] = []
    if simulated:
        warnings.append("This report uses simulated/demo data. It is not evidence of production model behavior.")
    if current_size < min_samples or reference_size < min_samples:
        summary = {
            "status": "insufficient_data",
            "message": (
                f"Sample sizes are below the {min_samples} minimum. No drift conclusion is drawn. "
                f"Reference rows: {reference_size}; current rows: {current_size}."
            ),
            "reference_size": reference_size,
            "current_size": current_size,
            "min_samples": min_samples,
            "simulated": simulated,
            "schema_changes": schema_changes,
        }
        report = DriftReport(
            project_id=project.id,
            deployment_id=deployment.id if deployment else None,
            model_version_id=model_version.id if model_version else None,
            reference_dataset_version_id=reference_version.id,
            current_dataset_version_id=current_version.id if current_version else None,
            status="insufficient_data",
            engine="custom",
            severity="unknown",
            reference_sample_size=reference_size,
            current_sample_size=current_size,
            feature_count=len(features),
            drifted_feature_count=0,
            drift_share=0.0,
            summary_json=jsonable(summary),
            report_json=jsonable(
                {
                    "summary": summary,
                    "reference": {"filename": reference_version.original_filename, "version": reference_version.version},
                    "current": {"source": current_source, "rows": current_size, "simulated_count": simulated_count},
                    "features": [],
                    "warnings": warnings,
                    "recommendations": [
                        f"Collect at least {min_samples} current samples before interpreting drift statistics.",
                        "Confirm capture is enabled for the deployment and that the date window contains traffic.",
                    ],
                }
            ),
            config_json={"alpha": alpha, "psi_threshold": psi_threshold, "min_samples": min_samples},
            window_start=ensure_utc(window["start"]),
            window_end=ensure_utc(window["end"]),
            created_by=actor_id or project.created_by,
        )
        db.add(report)
        db.commit()
        DRIFT_REPORTS.labels("unknown").inc()
        return report

    raw_results: list[dict[str, Any]] = []
    p_values: list[float | None] = []
    for feature in features:
        if feature in schema_changes["missing_features"]:
            continue
        ref_series = reference_prepared[feature]
        cur_series = current_prepared[feature]
        ref_missing = missing_rate(ref_series)
        cur_missing = missing_rate(cur_series)
        missing_shift = abs(cur_missing - ref_missing) >= 0.05
        kind = kinds.get(feature, "categorical")
        ref_non_null = ref_series.dropna()
        cur_non_null = cur_series.dropna()
        entry: dict[str, Any] = {
            "feature": feature,
            "feature_type": kind,
            "method": "",
            "statistic": None,
            "p_value": None,
            "psi": None,
            "missing_shift": missing_shift,
            "reference_missing_rate": ref_missing,
            "current_missing_rate": cur_missing,
            "reference_sample_size": int(ref_non_null.size),
            "current_sample_size": int(cur_non_null.size),
            "details": {},
        }
        if len(cur_non_null) < 10 or len(ref_non_null) < 10:
            entry.update(
                {
                    "method": "insufficient_data",
                    "drifted": False,
                    "severity": "unknown",
                    "recommendation": (
                        f"Collect at least 10 non-null current values for '{feature}' before interpreting drift."
                    ),
                }
            )
            p_values.append(None)
            raw_results.append(entry)
            continue
        if kind == "numeric":
            psi, psi_details = numeric_psi(ref_non_null, cur_non_null)
            ks_stat, p_value = ks_test(ref_non_null, cur_non_null)
            entry.update(
                {
                    "method": "Kolmogorov–Smirnov + PSI",
                    "statistic": ks_stat,
                    "p_value": p_value,
                    "psi": psi,
                    "details": {"psi": psi_details, "test": "two-sample KS"},
                }
            )
        else:
            psi, psi_details = categorical_psi(ref_non_null, cur_non_null)
            chi_stat, p_value, chi_details = chi_square_test(ref_non_null, cur_non_null)
            entry.update(
                {
                    "method": "Chi-square + PSI",
                    "statistic": chi_stat,
                    "p_value": p_value,
                    "psi": psi,
                    "details": {"psi": psi_details, "chi_square": chi_details},
                }
            )
        p_values.append(entry["p_value"])
        raw_results.append(entry)

    adjusted = benjamini_hochberg(p_values)
    for entry, adjusted_p in zip(raw_results, adjusted, strict=False):
        entry["adjusted_p_value"] = adjusted_p
        significant = adjusted_p is not None and adjusted_p < alpha
        psi = entry.get("psi")
        psi_drift = psi is not None and psi >= psi_threshold
        drifted = bool(
            psi_drift
            or (significant and (psi is None or psi >= 0.1))
            or entry["missing_shift"]
        )
        if entry["method"] == "insufficient_data":
            drifted = False
        entry["drifted"] = bool(drifted)
        entry["severity"] = (
            "unknown"
            if entry["method"] == "insufficient_data"
            else severity_from_psi(psi)
            if drifted
            else ("low" if psi is not None and psi >= 0.1 else "none")
        )
        if entry["missing_shift"] and entry["severity"] in {"none", "low"}:
            entry["severity"] = "medium"
        entry["threshold"] = psi_threshold
        entry["recommendation"] = _recommend(
            entry["feature"],
            entry["feature_type"],
            psi,
            entry["missing_shift"],
            drifted,
            entry["feature"] in schema_changes["missing_features"],
        )

    # Add schema-driven findings as first-class results.
    result_payloads: list[dict[str, Any]] = list(raw_results)
    for feature in schema_changes["missing_features"]:
        result_payloads.append(
            {
                "feature": feature,
                "feature_type": kinds.get(feature, "unknown"),
                "method": "schema_change",
                "statistic": None,
                "p_value": None,
                "adjusted_p_value": None,
                "psi": None,
                "missing_shift": True,
                "reference_missing_rate": 0.0,
                "current_missing_rate": 1.0,
                "reference_sample_size": reference_size,
                "current_sample_size": 0,
                "details": {"reason": "Feature absent from current data"},
                "drifted": True,
                "severity": "critical",
                "threshold": psi_threshold,
                "recommendation": _recommend(feature, kinds.get(feature, "unknown"), None, True, True, True),
            }
        )

    # Prediction drift (separate from feature/data drift).
    prediction_result: dict[str, Any] | None = None
    if deployment and model_version:
        baseline = model_version.prediction_distribution_json or {}
        events = db.execute(
            select(PredictionEvent.prediction_label, PredictionEvent.prediction_value)
            .where(
                PredictionEvent.deployment_id == deployment.id,
                PredictionEvent.created_at >= start,
                PredictionEvent.created_at <= end,
                PredictionEvent.status == "success",
            )
            .limit(50_000)
        ).all()
        if events and baseline:
            if (baseline.get("kind") or "") == "regression":
                psi = regression_distribution_psi(baseline, [row.prediction_value for row in events])
                current_distribution = {
                    "kind": "regression",
                    "sample_count": len(events),
                    "mean": float(np.mean([row.prediction_value for row in events if row.prediction_value is not None]))
                    if any(row.prediction_value is not None for row in events)
                    else None,
                }
            else:
                psi = classification_distribution_psi(baseline, [row.prediction_label for row in events])
                counts: dict[str, int] = {}
                for row in events:
                    label = str(row.prediction_label)
                    counts[label] = counts.get(label, 0) + 1
                current_distribution = {
                    "kind": "classification",
                    "sample_count": len(events),
                    "distribution": [
                        {"value": label, "count": count, "share": count / max(1, len(events))}
                        for label, count in sorted(counts.items(), key=lambda item: -item[1])
                    ],
                }
            prediction_result = {
                "feature": "__prediction_output__",
                "feature_type": "prediction",
                "method": "PSI (baseline held-out predictions vs current)",
                "statistic": psi,
                "p_value": None,
                "adjusted_p_value": None,
                "psi": psi,
                "missing_shift": False,
                "reference_missing_rate": 0.0,
                "current_missing_rate": 0.0,
                "reference_sample_size": int(baseline.get("sample_count") or 0),
                "current_sample_size": len(events),
                "details": {"baseline": baseline, "current": current_distribution},
                "drifted": bool(psi is not None and psi >= psi_threshold),
                "severity": severity_from_psi(psi) if (psi is not None and psi >= psi_threshold) else "none",
                "threshold": psi_threshold,
                "recommendation": (
                    "Prediction distribution changed. Review input drift, class balance, and calibration. "
                    "Prediction drift alone does not prove concept drift."
                )
                if psi is not None and psi >= psi_threshold
                else "Prediction distribution is stable relative to the baseline.",
            }
            result_payloads.append(prediction_result)

    feature_results = [result for result in result_payloads if result.get("feature_type") != "prediction"]
    drifted_features = [result for result in feature_results if result.get("drifted")]
    psi_values = [float(result["psi"]) for result in feature_results if result.get("psi") is not None]
    drift_share = len(drifted_features) / max(1, len(feature_results))
    severity = dataset_severity(drift_share, len(drifted_features), psi_values)

    # Evidently is the maintained statistical engine; custom tests provide stable
    # feature-level evidence and PSI effect sizes. If Evidently is unavailable we
    # explicitly report that the local engine was used.
    evidently_raw, evidently_error = _evidently_analysis(reference_prepared, current_prepared)
    evidently_by_feature, evidently_summary = _parse_evidently(evidently_raw)
    for result in result_payloads:
        cross_check = evidently_by_feature.get(result["feature"])
        if cross_check:
            result["details"] = {
                **(result.get("details") or {}),
                "evidently": cross_check,
            }
    engine = "Evidently + custom PSI/KS/chi-square" if not evidently_error else "custom PSI/KS/chi-square"
    if evidently_error:
        warnings.append(f"Evidently analysis unavailable; local statistical engine used ({evidently_error}).")
    if evidently_summary:
        warnings.append(
            "Evidently cross-check: "
            f"{int(evidently_summary.get('drifted_columns') or 0)} feature(s) flagged "
            f"({float(evidently_summary.get('drift_share') or 0):.0%})."
        )
    if len(feature_results) > 1:
        warnings.append(
            f"Multiple comparisons controlled with Benjamini–Hochberg FDR at alpha={alpha}. "
            "Feature-level p-values should be interpreted alongside effect size (PSI)."
        )

    labels_count = _labels_available(db, deployment, start, end) if deployment else 0
    concept_drift: dict[str, Any]
    if deployment and labels_count >= settings.default_min_label_samples:
        try:
            performance = compute_performance(
                db, deployment=deployment, start=start, end=end, persist=False, evaluate_alerts=False
            )
            concept_drift = {
                "status": performance.get("concept_drift", {}).get("status", "not_assessed"),
                "labels_evaluated": labels_count,
                "explanation": (
                    "Label-based performance was evaluated separately. Any degradation is evidence to investigate, "
                    "not proof of concept drift."
                ),
                "performance_degraded": performance.get("degraded"),
                "message": performance.get("message"),
            }
        except Exception:
            logger.warning("concept_drift_check_failed", exc_info=True)
            concept_drift = {
                "status": "not_assessed",
                "labels_evaluated": labels_count,
                "explanation": "Labels exist but the labelled performance check could not be completed.",
            }
    else:
        concept_drift = {
            "status": "not_assessed",
            "labels_evaluated": labels_count,
            "explanation": (
                "Concept drift requires ground-truth labels. This report analyzes feature and prediction "
                "distributions only; it does not establish concept drift."
            ),
        }

    top_features = sorted(
        [result for result in feature_results if result.get("drifted")],
        key=lambda item: float(item.get("psi") or 0),
        reverse=True,
    )[:5]
    recommendations: list[str] = []
    if drifted_features:
        recommendations.append(
            "Investigate the upstream data path for the drifted features and confirm whether the change is expected "
            "(new population, new product behavior) or a collection/encoding defect."
        )
        recommendations.append(
            "Do not retrain or promote a model solely because drift was detected. Obtain labels, verify performance, "
            "and use the retraining approval workflow."
        )
        recommendations.append(
            "Review segment-level counts and missing values to identify whether a specific subgroup or pipeline "
            "partition caused the shift."
        )
    else:
        recommendations.append("No material feature drift detected in this window; continue routine monitoring.")
    if prediction_result and prediction_result.get("drifted"):
        recommendations.append(
            "Prediction distribution shifted. Compare confidence calibration and recent labels before changing the "
            "deployed version."
        )
    if schema_changes["missing_features"]:
        recommendations.append("Resolve missing feature columns before scoring; current schema is incompatible.")
    if schema_changes["added_features"]:
        recommendations.append(
            "New columns appeared in current data. Confirm whether they are intentionally ignored by the deployed model."
        )
    if labels_count == 0 and deployment:
        recommendations.append(
            "No ground-truth labels are available for this window. Submit delayed labels to evaluate performance; "
            "do not infer accuracy from unlabelled predictions."
        )

    summary = {
        "overview": {
            "reference_source": f"dataset version {reference_version.version}",
            "current_source": current_source,
            "reference_rows": reference_size,
            "current_rows": current_size,
            "sampled_reference_rows": len(reference_prepared),
            "sampled_current_rows": len(current_prepared),
            "features_analyzed": len(feature_results),
            "drifted_features": len(drifted_features),
            "drift_share": drift_share,
            "severity": severity,
            "engine": engine,
            "simulated": simulated,
            "simulated_samples": simulated_count,
            "window": {
                "start": ensure_utc(window["start"]).isoformat() if window.get("start") else None,
                "end": ensure_utc(window["end"]).isoformat() if window.get("end") else None,
            },
            "alpha": alpha,
            "psi_threshold": psi_threshold,
            "share_threshold": share_threshold,
            "min_samples": min_samples,
        },
        "schema_changes": schema_changes,
        "missing_value_changes": [
            {
                "feature": result["feature"],
                "reference_missing_rate": result["reference_missing_rate"],
                "current_missing_rate": result["current_missing_rate"],
            }
            for result in feature_results
            if result.get("missing_shift")
        ],
        "top_drifted_features": [
            {"feature": result["feature"], "psi": result.get("psi"), "p_value": result.get("p_value"), "severity": result["severity"]}
            for result in top_features
        ],
        "prediction_drift": prediction_result,
        "concept_drift": concept_drift,
        "evidently": evidently_summary,
        "data_drift_share": drift_share,
        "warnings": warnings,
        "recommendations": recommendations,
        "reporting_notes": {
            "data_drift": "Change in feature distributions between reference and current data.",
            "prediction_drift": "Change in model output distribution; not the same as concept drift.",
            "concept_drift": "Change in the feature-to-outcome relationship; requires labels and is never confirmed by distribution tests alone.",
        },
    }
    report_payload = {
        "summary": summary,
        "reference": {
            "dataset_version_id": reference_version.id,
            "filename": reference_version.original_filename,
            "version": reference_version.version,
            "row_count": reference_size,
            "content_hash": reference_version.content_hash,
        },
        "current": {
            "dataset_version_id": current_version.id if current_version else None,
            "source": current_source,
            "rows": current_size,
            "simulated": simulated,
            "simulated_samples": simulated_count,
        },
        "feature_results": result_payloads,
        "evidently": evidently_raw,
        "warnings": warnings,
        "recommendations": recommendations,
    }
    report = DriftReport(
        project_id=project.id,
        deployment_id=deployment.id if deployment else None,
        model_version_id=model_version.id if model_version else None,
        reference_dataset_version_id=reference_version.id,
        current_dataset_version_id=current_version.id if current_version else None,
        status="completed",
        engine=engine,
        severity=severity,
        reference_sample_size=reference_size,
        current_sample_size=current_sample_size,
        feature_count=len(feature_results),
        drifted_feature_count=len(drifted_features),
        drift_share=drift_share,
        summary_json=jsonable(summary),
        report_json=jsonable(report_payload),
        config_json={
            "alpha": alpha,
            "psi_threshold": psi_threshold,
            "share_threshold": share_threshold,
            "min_samples": min_samples,
            "engine": engine,
        },
        window_start=ensure_utc(window["start"]),
        window_end=ensure_utc(window["end"]),
        created_by=actor_id or project.created_by,
    )
    db.add(report)
    db.flush()
    for result in result_payloads:
        db.add(
            DriftResult(
                report_id=report.id,
                feature=result["feature"],
                feature_type=result["feature_type"],
                method=result["method"],
                statistic=result.get("statistic"),
                p_value=result.get("p_value"),
                adjusted_p_value=result.get("adjusted_p_value"),
                psi=result.get("psi"),
                threshold=result.get("threshold"),
                drifted=bool(result.get("drifted")),
                severity=result.get("severity", "none"),
                reference_missing_rate=float(result.get("reference_missing_rate") or 0.0),
                current_missing_rate=float(result.get("current_missing_rate") or 0.0),
                reference_sample_size=int(result.get("reference_sample_size") or 0),
                current_sample_size=int(result.get("current_sample_size") or 0),
                details_json=jsonable(result.get("details") or {}),
                recommendation=result.get("recommendation") or "",
            )
        )
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=None,
        action="drift_report.created",
        entity_type="drift_report",
        entity_id=report.id,
        details={"severity": severity, "drift_share": drift_share, "simulated": simulated},
    )
    db.commit()
    DRIFT_REPORTS.labels(severity).inc()

    if deployment:
        observed = {
            "data_drift_share": drift_share,
            "feature_psi": max(psi_values) if psi_values else None,
            "prediction_distribution_psi": prediction_result.get("psi") if prediction_result else None,
        }
        evaluate_rules(
            db,
            project=project,
            deployment=deployment,
            observed=observed,
            context={
                "report_id": report.id,
                "severity": severity,
                "drifted_features": [result["feature"] for result in drifted_features],
                "concept_drift": concept_drift,
                "engine": engine,
            },
            sample_counts={
                "data_drift_share": len(feature_results),
                "feature_psi": len(feature_results),
                "prediction_distribution_psi": prediction_result["current_sample_size"] if prediction_result else 0,
            },
            simulated=simulated,
        )
    return report


def _resolve_reference_version(db: Session, project: Project, requested_id: str | None, deployment: Deployment | None) -> DatasetVersion:
    if requested_id:
        version = get_dataset_version(db, requested_id, project.id)
        return version
    if deployment:
        configured = (deployment.config_json or {}).get("reference_dataset_version_id")
        if configured:
            version = db.get(DatasetVersion, configured)
            if version:
                dataset = db.get(Dataset, version.dataset_id)
                if dataset and dataset.project_id == project.id:
                    return version
        model_version = db.get(ModelVersion, deployment.model_version_id)
        if model_version and model_version.dataset_version_id:
            version = db.get(DatasetVersion, model_version.dataset_version_id)
            if version:
                return version
    version = db.scalar(
        select(DatasetVersion)
        .join(Dataset, Dataset.id == DatasetVersion.dataset_id)
        .where(Dataset.project_id == project.id, DatasetVersion.is_reference.is_(True))
        .order_by(DatasetVersion.created_at.desc())
        .limit(1)
    )
    if not version:
        version = db.scalar(
            select(DatasetVersion)
            .join(Dataset, Dataset.id == DatasetVersion.dataset_id)
            .where(Dataset.project_id == project.id)
            .order_by(DatasetVersion.created_at.desc())
            .limit(1)
        )
    if not version:
        raise NotFoundError("No dataset version is available as a reference.")
    return version


def _resolve_deployment(db: Session, project: Project, requested_id: str | None) -> Deployment | None:
    if not requested_id:
        return None
    deployment = db.get(Deployment, requested_id)
    if not deployment:
        raise NotFoundError("Deployment not found")
    if deployment.project_id != project.id:
        raise NotFoundError("Deployment not found")
    return deployment


def analyze_drift_by_ids(
    db: Session,
    *,
    project: Project,
    reference_dataset_version_id: str | None,
    current_dataset_version_id: str | None,
    deployment_id: str | None,
    window_start: datetime | None,
    window_end: datetime | None,
    actor_id: str | None = None,
) -> DriftReport:
    deployment = _resolve_deployment(db, project, deployment_id)
    reference = _resolve_reference_version(db, project, reference_dataset_version_id, deployment)
    current = None
    if current_dataset_version_id:
        current = get_dataset_version(db, current_dataset_version_id, project.id)
    elif not deployment:
        raise AppError(422, "current_data_missing", "Select a deployment or a current dataset version.")
    return analyze_drift(
        db,
        project=project,
        reference_version=reference,
        deployment=deployment,
        current_version=current,
        window_start=window_start,
        window_end=window_end,
        actor_id=actor_id,
    )


def run_drift_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(PipelineJob, job_id)
        if not job:
            return
        job.status = "running"
        job.started_at = utcnow()
        job.attempts += 1
        job.progress = 5
        job.stage = "loading_data"
        update_job(db, job, message="Drift analysis job started.", progress=5, stage="loading_data")
        params = job.params_json or {}
        project = db.get(Project, params["project_id"])
        if not project:
            raise AppError(404, "project_not_found", "Project no longer exists.")
        user_id = job.triggered_by or project.created_by
        update_job(db, job, message="Loading reference and current data.", progress=25, stage="statistical_analysis")
        def _parse_dt(value: Any) -> datetime | None:
            if not value:
                return None
            if isinstance(value, datetime):
                return value
            try:
                return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            except ValueError:
                return None

        report = analyze_drift_by_ids(
            db,
            project=project,
            reference_dataset_version_id=params.get("reference_dataset_version_id"),
            current_dataset_version_id=params.get("current_dataset_version_id"),
            deployment_id=params.get("deployment_id"),
            window_start=_parse_dt(params.get("window_start")),
            window_end=_parse_dt(params.get("window_end")),
            actor_id=user_id,
        )
        job.status = "succeeded"
        job.progress = 100
        job.stage = "complete"
        job.finished_at = utcnow()
        job.result_json = {
            "report_id": report.id,
            "severity": report.severity,
            "drift_share": report.drift_share,
            "drifted_features": report.drifted_feature_count,
            "status": report.status,
        }
        update_job(
            db,
            job,
            message=(
                f"Drift report completed: {report.status}, severity={report.severity}, "
                f"drifted {report.drifted_feature_count}/{report.feature_count} features."
            ),
            progress=100,
            stage="complete",
        )
        PIPELINE_JOBS.labels("drift_analysis", "succeeded").inc()
    except Exception as exc:
        logger.error("drift_job_failed", exc_info=True)
        db.rollback()
        job = db.get(PipelineJob, job_id)
        if job:
            job.status = "failed"
            job.stage = "failed"
            job.error = str(exc)[:4000]
            job.finished_at = utcnow()
            update_job(db, job, message=f"Drift analysis failed: {str(exc)[:500]}", status="failed")
        PIPELINE_JOBS.labels("drift_analysis", "failed").inc()
    finally:
        db.close()
