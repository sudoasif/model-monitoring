from __future__ import annotations

import io
import logging
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AppError, ConflictError, NotFoundError, ValidationAppError
from app.models import Dataset, DatasetVersion, Project, User
from app.services.storage import storage
from app.utils import is_pii_column, jsonable, sha256_bytes, slugify

logger = logging.getLogger(__name__)

SAMPLE_DATASETS: dict[str, dict[str, str]] = {
    "churn-classification": {
        "name": "Customer Churn",
        "description": "Synthetic subscription churn dataset with numerical and categorical features.",
        "task_type": "classification",
        "target_column": "is_churned",
        "filename": "customer_churn.csv",
    },
    "house-regression": {
        "name": "House Prices",
        "description": "Synthetic property valuation dataset for regression.",
        "task_type": "regression",
        "target_column": "price",
        "filename": "house_prices.csv",
    },
}


def sample_dataframe(key: str, shifted: bool = False, n: int = 1500, seed: int = 42) -> pd.DataFrame:
    if key not in SAMPLE_DATASETS:
        raise NotFoundError("Sample dataset not found")
    rng = np.random.default_rng(seed + (100 if shifted else 0))
    if key == "churn-classification":
        tenure = np.clip(rng.gamma(2.2, 13, n), 1, 72).round().astype(int)
        if shifted:
            tenure = np.clip((tenure * 0.62), 1, 72).round().astype(int)
        monthly = np.clip(rng.normal(78 if not shifted else 104, 22, n), 18, 165).round(2)
        contract = rng.choice(
            ["month-to-month", "one_year", "two_year"],
            n,
            p=[0.55, 0.27, 0.18] if not shifted else [0.78, 0.15, 0.07],
        )
        internet = rng.choice(["fiber", "dsl", "none"], n, p=[0.48, 0.38, 0.14])
        support_tickets = rng.poisson(1.1 if not shifted else 2.6, n)
        autopay = rng.choice([0, 1], n, p=[0.42, 0.58])
        logit = (
            -1.15
            - 0.032 * tenure
            + 0.014 * monthly
            + 0.34 * support_tickets
            + np.where(contract == "month-to-month", 1.05, np.where(contract == "one_year", 0.1, -0.55))
            + np.where(internet == "fiber", 0.32, np.where(internet == "dsl", 0.05, -0.18))
            - 0.38 * autopay
            + (0.25 if shifted else 0.0)
        )
        probability = 1 / (1 + np.exp(-logit))
        churn = (rng.random(n) < probability).astype(int)
        df = pd.DataFrame(
            {
                "customer_id": [f"CAT-{100000 + i}" for i in range(n)],
                "customer_email": [f"customer{i}@example.com" for i in range(n)],
                "tenure_months": tenure,
                "monthly_charges": monthly,
                "contract_type": contract,
                "internet_service": internet,
                "support_tickets": support_tickets,
                "autopay": autopay,
                "is_churned": churn,
            }
        )
        if shifted:
            missing_idx = rng.choice(n, size=max(1, int(n * 0.06)), replace=False)
            df.loc[missing_idx, "monthly_charges"] = np.nan
            df.loc[rng.choice(n, size=max(1, int(n * 0.02)), replace=False), "contract_type"] = None
        return df
    if key == "house-regression":
        area = np.clip(rng.normal(2100 if not shifted else 2650, 620, n), 550, 5200).round(0)
        bedrooms = np.clip(rng.normal(3.1, 0.9, n), 1, 6).round().astype(int)
        age = np.clip(rng.normal(32 if not shifted else 18, 18, n), 0, 110).round().astype(int)
        location = rng.choice(
            ["A", "B", "C", "D"], n, p=[0.18, 0.33, 0.33, 0.16] if not shifted else [0.38, 0.36, 0.2, 0.06]
        )
        garage = rng.choice([0, 1], n, p=[0.34, 0.66])
        distance = np.clip(rng.normal(12 if not shifted else 17, 7, n), 0.5, 55).round(1)
        grade_bonus = pd.Series(location).map({"A": 105000, "B": 52000, "C": 12000, "D": -25000}).to_numpy()
        price = (
            62000
            + 142 * area
            + 18500 * bedrooms
            - 980 * age
            + grade_bonus
            + 24000 * garage
            - 1900 * distance
            + rng.normal(0, 24000, n)
        ).clip(min=45000)
        df = pd.DataFrame(
            {
                "property_id": [f"H-{200000 + i}" for i in range(n)],
                "area_sqft": area.astype(int),
                "bedrooms": bedrooms,
                "property_age": age,
                "location_grade": location,
                "garage": garage,
                "distance_km": distance,
                "price": price.round(2),
            }
        )
        if shifted:
            df.loc[rng.choice(n, size=max(1, int(n * 0.04)), replace=False), "area_sqft"] = np.nan
        return df
    raise NotFoundError("Sample dataset not found")


def _column_kind(series: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(series):
        return "boolean"
    if pd.api.types.is_numeric_dtype(series):
        return "numeric"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "datetime"
    return "categorical"


def infer_schema(df: pd.DataFrame, target_column: str = "") -> list[dict[str, Any]]:
    schema: list[dict[str, Any]] = []
    for column in df.columns:
        series = df[column]
        kind = _column_kind(series)
        non_null = series.dropna()
        schema.append(
            {
                "name": str(column),
                "dtype": str(series.dtype),
                "kind": kind,
                "role": "target" if column == target_column else "feature",
                "nullable": bool(series.isna().any()),
                "unique_count": int(non_null.nunique(dropna=True)),
                "missing_count": int(series.isna().sum()),
                "examples": [jsonable(v) for v in non_null.head(3).tolist()],
                "is_pii_like": is_pii_column(str(column)),
            }
        )
    return schema


def build_profile(
    df: pd.DataFrame,
    target_column: str = "",
    task_type: str = "classification",
    sample_rows: int = 10,
) -> dict[str, Any]:
    schema = infer_schema(df, target_column)
    total_cells = max(1, int(df.shape[0] * df.shape[1]))
    numeric_columns = [str(c) for c in df.select_dtypes(include=[np.number]).columns]
    categorical_columns = [
        str(c) for c in df.columns if c not in numeric_columns and not pd.api.types.is_datetime64_any_dtype(df[c])
    ]

    numeric_summary: dict[str, Any] = {}
    for column in numeric_columns:
        series = pd.to_numeric(df[column], errors="coerce").dropna()
        if series.empty:
            numeric_summary[column] = {"count": 0}
            continue
        numeric_summary[column] = {
            "count": int(series.count()),
            "mean": float(series.mean()),
            "std": float(series.std()) if len(series) > 1 else 0.0,
            "min": float(series.min()),
            "p25": float(series.quantile(0.25)),
            "p50": float(series.quantile(0.5)),
            "p75": float(series.quantile(0.75)),
            "max": float(series.max()),
            "missing_rate": round(float(df[column].isna().mean()), 4),
        }

    categorical_summary: dict[str, Any] = {}
    for column in categorical_columns[:30]:
        series = df[column].dropna()
        counts = series.astype(str).value_counts().head(12)
        categorical_summary[column] = {
            "cardinality": int(series.nunique()),
            "missing_rate": round(float(df[column].isna().mean()), 4),
            "top_values": [{"value": str(k)[:120], "count": int(v)} for k, v in counts.items()],
        }

    target_summary: dict[str, Any] = {}
    if target_column and target_column in df.columns:
        target = df[target_column]
        target_summary = {
            "column": target_column,
            "task_type": task_type,
            "missing_count": int(target.isna().sum()),
            "missing_rate": round(float(target.isna().mean()), 4),
            "unique_count": int(target.nunique(dropna=True)),
        }
        if task_type == "classification":
            counts = target.dropna().astype(str).value_counts().head(30)
            target_summary["distribution"] = [
                {"value": str(k), "count": int(v), "share": round(float(v) / max(1, len(target.dropna())), 4)}
                for k, v in counts.items()
            ]
        elif pd.api.types.is_numeric_dtype(target):
            target_summary.update(
                {
                    "mean": float(target.mean()),
                    "std": float(target.std()) if target.count() > 1 else 0.0,
                    "min": float(target.min()),
                    "p50": float(target.median()),
                    "max": float(target.max()),
                }
            )

    high_cardinality_threshold = max(10, int(df.shape[0] * 0.35))
    high_cardinality = [
        item["name"]
        for item in schema
        if item["kind"] == "categorical" and item["unique_count"] >= high_cardinality_threshold
    ]
    pii_columns = [item["name"] for item in schema if item["is_pii_like"]]
    constant_columns = [str(c) for c in df.columns if df[c].nunique(dropna=True) <= 1]
    preview = df.head(sample_rows).astype(object)
    sample = []
    for _, row in preview.iterrows():
        converted = {}
        for key, value in row.items():
            if isinstance(value, str) and len(value) > 200:
                value = value[:200] + "…"
            converted[str(key)] = jsonable(value)
        sample.append(converted)

    warnings: list[str] = []
    if pii_columns:
        warnings.append(
            "PII-like columns detected. They are excluded from model features and monitoring capture."
        )
    if high_cardinality:
        warnings.append("High-cardinality columns detected; review them for identifiers or leakage.")
    if df.isna().mean().max() > 0.2 if len(df.columns) else False:
        warnings.append("One or more columns are more than 20% missing.")
    if df.duplicated().any():
        warnings.append("Duplicate rows detected. Training keeps duplicates unless removed in preprocessing.")

    return {
        "row_count": int(df.shape[0]),
        "column_count": int(df.shape[1]),
        "missing_cells": int(df.isna().sum().sum()),
        "missing_rate": round(float(df.isna().sum().sum() / total_cells), 4),
        "duplicate_rows": int(df.duplicated().sum()),
        "columns": schema,
        "numeric_summary": numeric_summary,
        "categorical_summary": categorical_summary,
        "target": target_summary,
        "quality": {
            "pii_columns": pii_columns,
            "high_cardinality_columns": high_cardinality,
            "constant_columns": constant_columns,
            "warnings": warnings,
        },
        "sample_rows": sample,
    }


def _validate_raw_header(data: bytes) -> None:
    import csv

    if b"\x00" in data[:100000]:
        raise ValidationAppError("The CSV contains binary content and cannot be processed.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = data.decode("latin-1")
        except UnicodeDecodeError as exc:
            raise ValidationAppError("The file must be UTF-8 or Latin-1 encoded CSV.") from exc
    try:
        reader = csv.reader(io.StringIO(text.splitlines()[0] if text else ""))
        header = next(reader)
    except (StopIteration, csv.Error) as exc:
        raise ValidationAppError("The CSV is empty or has an invalid header.") from exc
    if not header or all(not column.strip() for column in header):
        raise ValidationAppError("The CSV must include a non-empty header row.")
    if len(header) > settings.max_dataset_columns:
        raise ValidationAppError(f"CSV exceeds the {settings.max_dataset_columns} column limit.")
    trimmed = [column.strip() for column in header]
    if len(set(trimmed)) != len(trimmed):
        raise ValidationAppError("Duplicate column names are not allowed. Rename duplicate columns first.")
    if any(len(column) > 200 for column in trimmed):
        raise ValidationAppError("Column names must be 200 characters or fewer.")


def parse_and_validate_csv(
    data: bytes,
    *,
    task_type: str,
    target_column: str,
    row_limit: int | None = None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    if not data:
        raise ValidationAppError("The uploaded CSV is empty.")
    _validate_raw_header(data)
    try:
        df = pd.read_csv(
            io.BytesIO(data),
            keep_default_na=True,
            na_values=["", "NA", "N/A", "null", "NULL", "None", "?"],
            low_memory=False,
        )
    except Exception as exc:
        raise ValidationAppError(
            "The CSV could not be parsed. Check the delimiter, quoting and header.",
            details={"parser_error": str(exc)[:300]},
        ) from exc
    if df.empty:
        raise ValidationAppError("The dataset has no rows.")
    if df.shape[1] > settings.max_dataset_columns:
        raise ValidationAppError(f"Dataset exceeds the {settings.max_dataset_columns} column limit.")
    if df.shape[0] > (row_limit or settings.max_dataset_rows):
        raise ValidationAppError(
            f"Dataset exceeds the {row_limit or settings.max_dataset_rows:,} row limit. "
            "Split or sample the dataset before uploading."
        )
    df.columns = [str(column).strip() for column in df.columns]
    if not target_column:
        raise ValidationAppError("Configure a target column on the project before uploading data.")
    if target_column not in df.columns:
        raise ValidationAppError(
            f"Target column '{target_column}' was not found in the CSV.",
            details={"available_columns": list(df.columns)[:50]},
        )
    target = df[target_column]
    labelled = target.dropna()
    if len(labelled) < 10:
        raise ValidationAppError("At least 10 labelled rows are required to train a model.")
    if labelled.nunique() < 2:
        raise ValidationAppError("The target column must contain at least two distinct values.")
    if task_type == "classification":
        class_count = labelled.nunique()
        if class_count > 100:
            raise ValidationAppError("Classification targets are limited to 100 classes.")
        counts = labelled.astype(str).value_counts()
        if counts.min() < 2:
            raise ValidationAppError("Every target class needs at least two examples.")
        df[target_column] = target.astype(str).str.strip().where(target.notna())
    else:
        numeric_target = pd.to_numeric(target, errors="coerce")
        if numeric_target.notna().sum() < 10:
            raise ValidationAppError("Regression targets must be numeric.")
        if numeric_target.isna().sum() > target.notna().sum() * 0.5:
            raise ValidationAppError("Too many target values could not be parsed as numbers.")
    profile = build_profile(df, target_column, task_type)
    return df, profile


def create_dataset_version(
    db: Session,
    *,
    project: Project,
    user: User,
    data: bytes,
    original_filename: str,
    dataset_name: str,
    description: str = "",
    notes: str = "",
    is_reference: bool = False,
) -> DatasetVersion:
    df, profile = parse_and_validate_csv(
        data, task_type=project.task_type, target_column=project.target_column
    )
    dataset = db.scalar(
        select(Dataset).where(
            Dataset.project_id == project.id, func.lower(Dataset.name) == dataset_name.lower()
        )
    )
    if not dataset:
        dataset = Dataset(
            project_id=project.id,
            name=dataset_name,
            description=description,
            created_by=user.id,
        )
        db.add(dataset)
        db.flush()
    max_version = db.scalar(
        select(func.max(DatasetVersion.version)).where(DatasetVersion.dataset_id == dataset.id)
    )
    version = int(max_version or 0) + 1
    content_hash = sha256_bytes(data)
    storage_path = f"datasets/{project.id}/{dataset.id}/v{version}.csv"
    storage.save_bytes(storage_path, data, content_type="text/csv")
    if is_reference:
        db.query(DatasetVersion).filter(
            DatasetVersion.dataset_id == dataset.id, DatasetVersion.is_reference.is_(True)
        ).update({DatasetVersion.is_reference: False})
    schema = profile["columns"]
    record = DatasetVersion(
        dataset_id=dataset.id,
        version=version,
        filename=f"{slugify(dataset_name)}-v{version}.csv",
        original_filename=original_filename[:255],
        storage_path=storage_path,
        size_bytes=len(data),
        content_hash=content_hash,
        row_count=int(df.shape[0]),
        column_count=int(df.shape[1]),
        schema_json=schema,
        profile_json=profile,
        is_reference=is_reference,
        notes=notes,
        created_by=user.id,
    )
    dataset.updated_at = datetime.utcnow()
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def create_sample_version(
    db: Session,
    *,
    project: Project,
    user: User,
    key: str,
    shifted: bool = False,
    dataset_name: str | None = None,
    is_reference: bool = False,
) -> DatasetVersion:
    meta = SAMPLE_DATASETS.get(key)
    if not meta:
        raise NotFoundError("Sample dataset not found")
    df = sample_dataframe(key, shifted=shifted)
    if meta["target_column"] not in df.columns and project.target_column:
        df = df.rename(columns={meta["target_column"]: project.target_column})
    data = df.to_csv(index=False).encode("utf-8")
    name = dataset_name or meta["name"]
    return create_dataset_version(
        db,
        project=project,
        user=user,
        data=data,
        original_filename=f"{meta['filename'].replace('.csv', '')}-{'shifted' if shifted else 'baseline'}.csv",
        dataset_name=name,
        description=meta["description"],
        notes="Synthetic demo data. Not production data.",
        is_reference=is_reference,
    )


def load_dataset_frame(version: DatasetVersion) -> pd.DataFrame:
    try:
        data = storage.read_bytes(version.storage_path)
        return pd.read_csv(io.BytesIO(data), low_memory=False)
    except AppError:
        raise
    except Exception as exc:
        raise AppError(
            500, "dataset_read_failed", "The stored dataset could not be read.", {"error": str(exc)[:200]}
        ) from exc


def get_dataset_version(db: Session, version_id: str, project_id: str | None = None) -> DatasetVersion:
    version = db.get(DatasetVersion, version_id)
    if not version:
        raise NotFoundError("Dataset version not found")
    dataset = db.get(Dataset, version.dataset_id)
    if not dataset or (project_id and dataset.project_id != project_id):
        raise NotFoundError("Dataset version not found")
    return version


def serialize_dataset_version(db: Session, version: DatasetVersion, include_profile: bool = True) -> dict[str, Any]:
    dataset = db.get(Dataset, version.dataset_id)
    payload = {
        "id": version.id,
        "dataset_id": version.dataset_id,
        "dataset_name": dataset.name if dataset else "",
        "version": version.version,
        "filename": version.filename,
        "original_filename": version.original_filename,
        "size_bytes": version.size_bytes,
        "content_hash": version.content_hash,
        "row_count": version.row_count,
        "column_count": version.column_count,
        "schema": version.schema_json,
        "profile": version.profile_json if include_profile else {},
        "is_reference": version.is_reference,
        "notes": version.notes,
        "created_at": version.created_at,
        "created_by": version.created_by,
    }
    return payload


def ensure_unique_dataset_name(db: Session, project_id: str, name: str, exclude_id: str | None = None) -> None:
    stmt = select(Dataset).where(
        Dataset.project_id == project_id, func.lower(Dataset.name) == name.strip().lower()
    )
    if exclude_id:
        stmt = stmt.where(Dataset.id != exclude_id)
    if db.scalar(stmt.limit(1)):
        raise ConflictError("A dataset with that name already exists in this project.")


def feature_columns_for_training(
    df: pd.DataFrame, target_column: str, profile: dict[str, Any] | None = None
) -> tuple[list[str], list[str]]:
    """Select feature columns, excluding target, PII-like fields and identifiers."""
    excluded: list[str] = []
    selected: list[str] = []
    row_count = max(1, len(df))
    for column in df.columns:
        if column == target_column:
            continue
        if is_pii_column(column):
            excluded.append(column)
            continue
        series = df[column]
        # Unique string-like identifier columns or constant columns add noise/leakage.
        if series.nunique(dropna=True) <= 1:
            excluded.append(column)
            continue
        kind = _column_kind(series)
        if kind == "categorical" and series.nunique(dropna=True) >= row_count * 0.95:
            excluded.append(column)
            continue
        selected.append(column)
    return selected, excluded
