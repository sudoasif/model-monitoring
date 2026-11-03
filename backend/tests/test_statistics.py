from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.services.statistics import (
    benjamini_hochberg,
    categorical_psi,
    chi_square_test,
    classification_distribution_psi,
    dataset_severity,
    ks_test,
    numeric_psi,
    psi_from_proportions,
    regression_distribution_psi,
    severity_from_psi,
)


def test_psi_from_proportions_is_zero_for_identical_distributions() -> None:
    assert psi_from_proportions([0.2, 0.3, 0.5], [0.2, 0.3, 0.5]) == pytest.approx(0.0, abs=1e-12)


def test_psi_from_proportions_detects_large_shift() -> None:
    psi = psi_from_proportions([0.5, 0.5], [0.95, 0.05])
    assert psi > 0.2


def test_psi_rejects_mismatched_shapes() -> None:
    with pytest.raises(ValueError):
        psi_from_proportions([0.5, 0.5], [1.0])


def test_numeric_psi_stable_and_shifted() -> None:
    rng = np.random.default_rng(7)
    reference = pd.Series(rng.normal(0, 1, 500))
    stable, stable_details = numeric_psi(reference, reference.sample(frac=1.0, random_state=1))
    assert stable == pytest.approx(0.0, abs=1e-9)
    assert stable_details["bins"]
    shifted, _ = numeric_psi(reference, pd.Series(rng.normal(3, 1, 500)))
    assert shifted > 0.2


def test_numeric_psi_handles_constant_and_empty_series() -> None:
    psi, details = numeric_psi(pd.Series([5, 5, 5]), pd.Series([5, 5, 5]))
    assert psi == 0.0
    assert details["bins"] == [5.0]
    empty_psi, empty_details = numeric_psi(pd.Series([], dtype=float), pd.Series([1.0, 2.0]))
    assert empty_psi == 0.0
    assert empty_details["bins"] == []


def test_categorical_psi_detects_new_categories() -> None:
    reference = pd.Series(["a", "b"] * 100)
    current = pd.Series(["c", "d"] * 100)
    psi, details = categorical_psi(reference, current)
    assert psi > 0.2
    assert set(details["new_categories"]) == {"c", "d"}


def test_chi_square_detects_distribution_change() -> None:
    reference = pd.Series(["a"] * 100 + ["b"] * 100)
    current = pd.Series(["a"] * 180 + ["b"] * 20)
    statistic, p_value, details = chi_square_test(reference, current)
    assert statistic is not None and statistic > 0
    assert p_value is not None and p_value < 0.001
    assert details["dof"] == 1


def test_ks_test_detects_shift_and_handles_small_samples() -> None:
    rng = np.random.default_rng(3)
    statistic, p_value = ks_test(pd.Series(rng.normal(0, 1, 300)), pd.Series(rng.normal(0, 1, 300)))
    assert statistic is not None
    assert p_value is not None and p_value > 0.01
    shifted_stat, shifted_p = ks_test(pd.Series(rng.normal(0, 1, 300)), pd.Series(rng.normal(2, 1, 300)))
    assert shifted_stat is not None and shifted_stat > 0.5
    assert shifted_p is not None and shifted_p < 0.001
    small_stat, small_p = ks_test(pd.Series([1.0]), pd.Series([2.0]))
    assert small_stat is None and small_p is None


def test_benjamini_hochberg_controls_false_discovery_rate() -> None:
    adjusted = benjamini_hochberg([0.01, 0.04, 0.03, 0.005])
    assert adjusted == pytest.approx([0.02, 0.04, 0.04, 0.02])


def test_benjamini_hochberg_preserves_missing_values() -> None:
    adjusted = benjamini_hochberg([None, 0.01, None, 0.02])
    assert adjusted[0] is None and adjusted[2] is None
    assert adjusted[1] == pytest.approx(0.02)
    assert adjusted[3] == pytest.approx(0.02)
    assert benjamini_hochberg([None, None]) == [None, None]


def test_classification_distribution_psi() -> None:
    baseline = {
        "kind": "classification",
        "distribution": [
            {"value": "0", "share": 0.5},
            {"value": "1", "share": 0.5},
        ],
    }
    assert classification_distribution_psi(baseline, ["0", "1"] * 50) == pytest.approx(0.0, abs=1e-9)
    shifted = classification_distribution_psi(baseline, ["0"] * 100)
    assert shifted is not None and shifted > 0.2
    assert classification_distribution_psi({}, ["0"]) is None
    assert classification_distribution_psi(baseline, []) is None


def test_regression_distribution_psi() -> None:
    baseline = {"bins": [0.0, 1.0, 2.0, 3.0], "shares": [0.25, 0.5, 0.25]}
    matching = [0.2] * 20 + [1.2] * 40 + [2.2] * 20
    assert regression_distribution_psi(baseline, matching) == pytest.approx(0.0, abs=1e-9)
    assert regression_distribution_psi(baseline, [0.2, 1.2, 2.2] * 20) == pytest.approx(0.1155, abs=1e-3)
    shifted = regression_distribution_psi(baseline, [2.9] * 100)
    assert shifted is not None and shifted > 0.2
    assert regression_distribution_psi({"bins": [0.0], "shares": [1.0]}, [1.0]) is None


def test_severity_thresholds() -> None:
    assert severity_from_psi(None) == "unknown"
    assert severity_from_psi(0.05) == "low"
    assert severity_from_psi(0.12) == "medium"
    assert severity_from_psi(0.2) == "high"
    assert severity_from_psi(0.3) == "critical"
    assert dataset_severity(0.0, 0, []) == "none"
    assert dataset_severity(0.1, 1, [0.11]) == "medium"
    assert dataset_severity(0.3, 3, [0.2]) == "high"
    assert dataset_severity(0.6, 6, [0.12]) == "critical"
