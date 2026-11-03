from __future__ import annotations

import pytest

from app.models import Project
from app.services.retraining import _compare_candidate


def _project(task_type: str = "classification", policy: dict | None = None) -> Project:
    return Project(
        id="project-test",
        name="Test Project",
        slug="test-project",
        task_type=task_type,
        target_column="target",
        config_json={"promotion_policy": policy or {}},
        created_by="user-test",
    )


def test_classification_candidate_must_materially_improve() -> None:
    project = _project()
    baseline = {"roc_auc": 0.80, "f1_macro": 0.70}
    improved = _compare_candidate(
        project, baseline, {"roc_auc": 0.85, "f1_macro": 0.75}, {"status": "passed"}
    )
    assert improved["recommendation"] == "promote_candidate"
    assert improved["primary_metric"] == "roc_auc"
    assert improved["approval_required"] is True
    assert improved["auto_promoted"] is False
    assert improved["baseline_model_version_id"] is None

    marginal = _compare_candidate(
        project, baseline, {"roc_auc": 0.802, "f1_macro": 0.701}, {"status": "passed"}
    )
    assert marginal["recommendation"] == "keep_baseline"

    worse = _compare_candidate(
        project, baseline, {"roc_auc": 0.70, "f1_macro": 0.60}, {"status": "passed"}
    )
    assert worse["recommendation"] == "keep_baseline"


def test_failed_validation_always_rejects_candidate() -> None:
    result = _compare_candidate(
        _project(),
        {"roc_auc": 0.80},
        {"roc_auc": 0.95},
        {"status": "failed", "checks": []},
    )
    assert result["recommendation"] == "reject_candidate"
    assert "failed validation" in result["reason"].lower()


def test_validation_warning_requires_manual_review() -> None:
    result = _compare_candidate(
        _project(), {"roc_auc": 0.8}, {"roc_auc": 0.9}, {"status": "warning"}
    )
    assert result["recommendation"] == "needs_review"


def test_missing_metric_requires_review() -> None:
    result = _compare_candidate(_project(), {"accuracy": 0.9}, {"accuracy": 0.95}, {"status": "passed"})
    assert result["recommendation"] == "needs_review"
    assert result["baseline_value"] is None
    assert result["candidate_value"] is None


def test_classification_policy_threshold_is_configurable() -> None:
    project = _project(policy={"retrain_min_improvement": 0.10})
    result = _compare_candidate(
        project, {"roc_auc": 0.80}, {"roc_auc": 0.85}, {"status": "passed"}
    )
    assert result["recommendation"] == "keep_baseline"


def test_regression_comparison_uses_error_reduction() -> None:
    project = _project("regression")
    baseline = {"rmse": 10.0, "mae": 7.0, "r2": 0.80}
    improved = _compare_candidate(
        project, baseline, {"rmse": 9.7, "mae": 6.8, "r2": 0.82}, {"status": "passed"}
    )
    assert improved["primary_metric"] == "rmse"
    assert improved["recommendation"] == "promote_candidate"
    assert improved["metric_deltas"]["rmse"] == pytest.approx(-0.3)

    marginal = _compare_candidate(
        project, baseline, {"rmse": 9.9, "mae": 6.95, "r2": 0.805}, {"status": "passed"}
    )
    assert marginal["recommendation"] == "keep_baseline"

    worse = _compare_candidate(
        project, baseline, {"rmse": 12.0, "mae": 8.0, "r2": 0.70}, {"status": "passed"}
    )
    assert worse["recommendation"] == "keep_baseline"


def test_regression_falls_back_to_r2_with_correct_direction() -> None:
    project = _project("regression")
    improved = _compare_candidate(
        project, {"r2": 0.50}, {"r2": 0.60}, {"status": "passed"}
    )
    assert improved["primary_metric"] == "r2"
    assert improved["recommendation"] == "promote_candidate"

    worse = _compare_candidate(project, {"r2": 0.50}, {"r2": 0.40}, {"status": "passed"})
    assert worse["recommendation"] == "keep_baseline"


def test_regression_zero_baseline_does_not_divide_by_zero() -> None:
    result = _compare_candidate(
        _project("regression"),
        {"rmse": 0.0},
        {"rmse": 0.1},
        {"status": "passed"},
    )
    assert result["recommendation"] == "keep_baseline"
    assert "relative improvement" in result["reason"]
