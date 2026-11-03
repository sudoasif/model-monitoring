from __future__ import annotations

import io

import joblib
import numpy as np
import pandas as pd
import pytest

from app.errors import AppError, ValidationAppError
from app.models import ModelVersion
from app.services.prediction import (
    ModelCache,
    _map_prediction,
    prediction_schema,
    validate_features,
)
from app.services.storage import storage
from app.utils import sha256_bytes


def _bundle() -> dict:
    return {
        "feature_schema": [
            {"name": "age", "kind": "numeric", "nullable": False},
            {"name": "city", "kind": "categorical", "nullable": True},
            {"name": "flag", "kind": "boolean", "nullable": False},
        ]
    }


def test_validate_features_accepts_and_orders_values() -> None:
    validated = validate_features(
        _bundle(), {"flag": True, "city": "north", "age": 34}
    )
    assert list(validated) == ["age", "city", "flag"]
    assert validated["age"] == 34.0
    assert validated["city"] == "north"
    assert validated["flag"] == 1


def test_validate_features_allows_null_only_when_nullable() -> None:
    validated = validate_features(
        _bundle(), {"age": 34, "city": None, "flag": 0}
    )
    assert pd.isna(validated["city"])
    with pytest.raises(ValidationAppError) as exc_info:
        validate_features(_bundle(), {"age": None, "city": "north", "flag": 0})
    assert exc_info.value.status_code == 422
    assert exc_info.value.details["fields"][0]["field"] == "age"


@pytest.mark.parametrize(
    ("record", "field"),
    [
        ({"city": "north", "flag": 0}, "age"),
        ({"age": 10, "flag": 0, "unexpected": 1}, "unexpected"),
        ({"age": "not-a-number", "city": "north", "flag": 0}, "age"),
        ({"age": float("inf"), "city": "north", "flag": 0}, "age"),
        ({"age": 10, "city": "north", "flag": 2}, "flag"),
        ({"age": 10, "city": ["north"], "flag": 0}, "city"),
        ({"age": 10, "city": "x" * 501, "flag": 0}, "city"),
    ],
)
def test_validate_features_rejects_invalid_values(record: dict, field: str) -> None:
    with pytest.raises(ValidationAppError) as exc_info:
        validate_features(_bundle(), record)
    assert exc_info.value.status_code == 422
    fields = {item["field"] for item in exc_info.value.details["fields"]}
    assert field in fields


def test_validate_features_can_ignore_extra_fields() -> None:
    validated = validate_features(
        _bundle(), {"age": 10, "city": "north", "flag": 0, "debug": "ignored"}, allow_extra=True
    )
    assert "debug" not in validated


def test_prediction_schema_uses_representative_examples() -> None:
    bundle = {
        "task_type": "classification",
        "target_column": "churn",
        "class_labels": ["0", "1"],
        "positive_class": "1",
        "feature_schema": [
            {
                "name": "age",
                "kind": "numeric",
                "nullable": False,
                "examples": [21, 22],
                "range": {"min": 18, "max": 90, "p50": 34},
            },
            {
                "name": "city",
                "kind": "categorical",
                "nullable": True,
                "examples": ["north"],
            },
        ],
    }
    schema = prediction_schema(bundle)
    assert schema["task_type"] == "classification"
    assert schema["class_labels"] == ["0", "1"]
    assert schema["fields"][0]["example"] == 34
    assert schema["fields"][1]["example"] == "north"


def test_map_prediction_returns_probabilities_and_confidence() -> None:
    bundle = {"task_type": "classification", "class_labels": ["no", "yes"]}
    proba = np.asarray([[0.25, 0.75], [0.6, 0.4]])
    raw, label, confidence, probabilities = _map_prediction(bundle, proba, 1, 0)
    assert raw == 1
    assert label == "yes"
    assert confidence == pytest.approx(0.75)
    assert probabilities == {"no": 0.25, "yes": 0.75}

    regression_bundle = {"task_type": "regression"}
    value, label, confidence, probabilities = _map_prediction(regression_bundle, None, 123.5, 0)
    assert value == 123.5
    assert label is None and confidence is None and probabilities is None


def test_model_cache_refuses_tampered_artifacts() -> None:
    artifact_key = "tests/tampered/model.joblib"
    storage.save_bytes(artifact_key, b"not-the-real-model", content_type="application/octet-stream")
    version = ModelVersion(
        id="version-tampered",
        artifact_key=artifact_key,
        artifact_hash=sha256_bytes(b"expected-different-bytes"),
    )
    cache = ModelCache()
    with pytest.raises(AppError) as exc_info:
        cache.get(version)
    assert exc_info.value.status_code == 500
    assert exc_info.value.code == "artifact_integrity_failed"


def test_model_cache_loads_and_invalidates_valid_bundle() -> None:
    bundle = {"pipeline": "dummy", "feature_columns": ["age"]}
    buffer = io.BytesIO()
    joblib.dump(bundle, buffer)
    payload = buffer.getvalue()
    artifact_key = "tests/valid/model.joblib"
    storage.save_bytes(artifact_key, payload, content_type="application/octet-stream")
    version = ModelVersion(
        id="version-valid",
        artifact_key=artifact_key,
        artifact_hash=sha256_bytes(payload),
    )
    cache = ModelCache()
    first = cache.get(version)
    second = cache.get(version)
    assert first is second
    cache.invalidate(version.id)
    assert cache.get(version) is not first


def test_model_cache_rejects_unsupported_bundle() -> None:
    buffer = io.BytesIO()
    joblib.dump({"not_a_bundle": True}, buffer)
    payload = buffer.getvalue()
    artifact_key = "tests/invalid-bundle/model.joblib"
    storage.save_bytes(artifact_key, payload, content_type="application/octet-stream")
    version = ModelVersion(
        id="version-invalid",
        artifact_key=artifact_key,
        artifact_hash=sha256_bytes(payload),
    )
    with pytest.raises(AppError) as exc_info:
        ModelCache().get(version)
    assert exc_info.value.code == "invalid_model_bundle"
