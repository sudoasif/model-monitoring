from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats


def _clean_probs(probabilities: Iterable[float]) -> np.ndarray:
    probs = np.asarray(list(probabilities), dtype=float)
    if probs.size == 0:
        return probs
    probs = np.clip(probs, 1e-6, None)
    total = probs.sum()
    return probs / total if total > 0 else np.full(probs.size, 1 / probs.size)


def psi_from_proportions(expected: Iterable[float], actual: Iterable[float]) -> float:
    expected_probs = _clean_probs(expected)
    actual_probs = _clean_probs(actual)
    if expected_probs.shape != actual_probs.shape:
        raise ValueError("PSI inputs must have the same shape")
    return float(np.sum((actual_probs - expected_probs) * np.log(actual_probs / expected_probs)))


def numeric_psi(reference: pd.Series, current: pd.Series, bins: int = 10) -> tuple[float, dict[str, Any]]:
    reference = pd.to_numeric(reference, errors="coerce").dropna()
    current = pd.to_numeric(current, errors="coerce").dropna()
    if reference.empty or current.empty:
        return 0.0, {"bins": [], "reference_shares": [], "current_shares": []}
    edges = np.unique(np.nanquantile(reference, np.linspace(0, 1, bins + 1)))
    if edges.size < 2:
        value = float(reference.iloc[0])
        ref_counts = np.array([len(reference)])
        cur_counts = np.array([len(current)])
        return 0.0 if np.allclose(ref_counts, cur_counts) else psi_from_proportions([1.0], [1.0]), {
            "bins": [value],
            "reference_shares": [1.0],
            "current_shares": [1.0],
        }
    edges[0] = min(edges[0], float(current.min()))
    edges[-1] = max(edges[-1], float(current.max()))
    ref_counts, _ = np.histogram(reference, bins=edges)
    cur_counts, _ = np.histogram(current, bins=edges)
    ref_shares = ref_counts / max(1, ref_counts.sum())
    cur_shares = cur_counts / max(1, cur_counts.sum())
    psi = psi_from_proportions(ref_shares, cur_shares)
    return psi, {
        "bins": [float(edge) for edge in edges],
        "reference_counts": ref_counts.tolist(),
        "current_counts": cur_counts.tolist(),
        "reference_shares": ref_shares.tolist(),
        "current_shares": cur_shares.tolist(),
    }


def categorical_psi(reference: pd.Series, current: pd.Series, max_categories: int = 20) -> tuple[float, dict[str, Any]]:
    reference = reference.dropna().astype(str)
    current = current.dropna().astype(str)
    if reference.empty or current.empty:
        return 0.0, {"categories": [], "reference_shares": [], "current_shares": []}
    top = reference.value_counts().head(max_categories).index.tolist()
    ref_counts = reference.map(lambda value: value if value in top else "__other__").value_counts()
    cur_counts = current.map(lambda value: value if value in top else "__other__").value_counts()
    categories = list(dict.fromkeys(top + ["__other__"] + cur_counts.index.tolist()))
    categories = [category for category in categories if category in ref_counts.index or category in cur_counts.index]
    ref_shares = np.asarray([ref_counts.get(category, 0) / len(reference) for category in categories], dtype=float)
    cur_shares = np.asarray([cur_counts.get(category, 0) / len(current) for category in categories], dtype=float)
    psi = psi_from_proportions(ref_shares, cur_shares)
    return psi, {
        "categories": categories,
        "reference_counts": [int(ref_counts.get(category, 0)) for category in categories],
        "current_counts": [int(cur_counts.get(category, 0)) for category in categories],
        "reference_shares": ref_shares.tolist(),
        "current_shares": cur_shares.tolist(),
        "new_categories": sorted([value for value in set(current.unique()) if value not in set(reference.unique())])[:50],
    }


def chi_square_test(reference: pd.Series, current: pd.Series, max_categories: int = 20) -> tuple[float | None, float | None, dict[str, Any]]:
    reference = reference.dropna().astype(str)
    current = current.dropna().astype(str)
    if reference.empty or current.empty:
        return None, None, {"reason": "empty"}
    top = pd.concat([reference, current]).value_counts().head(max_categories).index.tolist()
    categories = list(dict.fromkeys(top + ["__other__"]))
    ref_counts = reference.map(lambda value: value if value in top else "__other__").value_counts()
    cur_counts = current.map(lambda value: value if value in top else "__other__").value_counts()
    table = np.asarray(
        [[ref_counts.get(category, 0), cur_counts.get(category, 0)] for category in categories], dtype=float
    )
    table = table[table.sum(axis=1) > 0]
    # Chi-square is unreliable with expected counts below 5. Merge the rarest
    # categories into one bucket until the assumption is met or two rows remain.
    while table.shape[0] > 2:
        row_sums = table.sum(axis=1)
        col_sums = table.sum(axis=0)
        total = float(table.sum())
        if total <= 0:
            return None, None, {"reason": "empty_contingency_table"}
        expected = np.outer(row_sums, col_sums) / total
        if (expected >= 5).all():
            break
        order = np.argsort(row_sums)
        first, second = int(order[0]), int(order[1])
        merged = table[first] + table[second]
        remaining = [row for index, row in enumerate(table) if index not in (first, second)]
        table = np.vstack([np.asarray(remaining, dtype=float), merged])
    if table.shape[0] < 2:
        return None, None, {"reason": "insufficient_category_counts", "table": table.tolist()}
    try:
        statistic, p_value, dof, expected_table = stats.chi2_contingency(table.T, correction=False)
        low_expected = bool((expected_table < 5).any())
        return float(statistic), float(p_value), {
            "dof": int(dof),
            "low_expected_counts": low_expected,
            "table": table.tolist(),
        }
    except ValueError as exc:
        return None, None, {"reason": str(exc)[:200]}


def ks_test(reference: pd.Series, current: pd.Series) -> tuple[float | None, float | None]:
    ref = pd.to_numeric(reference, errors="coerce").dropna()
    cur = pd.to_numeric(current, errors="coerce").dropna()
    if len(ref) < 2 or len(cur) < 2:
        return None, None
    result = stats.ks_2samp(ref, cur, alternative="two-sided", method="auto")
    return float(result.statistic), float(result.pvalue)


def benjamini_hochberg(p_values: list[float | None]) -> list[float | None]:
    indexed = [(index, value) for index, value in enumerate(p_values) if value is not None]
    if not indexed:
        return [None for _ in p_values]
    sorted_values = sorted(indexed, key=lambda pair: pair[1])
    m = len(sorted_values)
    adjusted = [None] * len(p_values)
    previous = 1.0
    for rank in range(m, 0, -1):
        index, p_value = sorted_values[rank - 1]
        value = min(previous, p_value * m / rank)
        adjusted[index] = float(min(1.0, value))
        previous = value
    return adjusted


def severity_from_psi(psi: float | None) -> str:
    if psi is None:
        return "unknown"
    if psi >= 0.25:
        return "critical"
    if psi >= 0.2:
        return "high"
    if psi >= 0.1:
        return "medium"
    return "low"


def dataset_severity(drift_share: float, drifted_count: int, psi_values: list[float]) -> str:
    if drifted_count == 0:
        return "none"
    if drift_share >= 0.5 or (psi_values and max(psi_values) >= 0.25):
        return "critical"
    if drift_share >= 0.25 or (psi_values and max(psi_values) >= 0.2):
        return "high"
    if drift_share >= 0.1 or (psi_values and max(psi_values) >= 0.1):
        return "medium"
    return "low"


def classification_distribution_psi(baseline: dict[str, Any], current_labels: list[str | None]) -> float | None:
    baseline_rows = baseline.get("distribution") or []
    if not baseline_rows:
        return None
    labels = [str(row.get("value")) for row in baseline_rows]
    expected = [float(row.get("share") or 0.0) for row in baseline_rows]
    present = [str(value) for value in current_labels if value is not None]
    if not present:
        return None
    counts = {label: 0 for label in labels}
    counts["__other__"] = 0
    for value in present:
        if value in counts:
            counts[value] += 1
        else:
            counts["__other__"] += 1
    labels.append("__other__")
    expected.append(0.0)
    total = max(1, len(present))
    actual = [counts.get(label, 0) / total for label in labels]
    return psi_from_proportions(expected, actual)


def regression_distribution_psi(baseline: dict[str, Any], current_values: list[float | None]) -> float | None:
    bins = baseline.get("bins")
    shares = baseline.get("shares")
    if not bins or not shares or len(bins) < 2:
        return None
    values = np.asarray([float(v) for v in current_values if v is not None], dtype=float)
    if values.size == 0:
        return None
    counts, _ = np.histogram(values, bins=np.asarray(bins, dtype=float))
    actual = counts / max(1, counts.sum())
    expected = np.asarray(shares, dtype=float)
    if expected.shape != actual.shape:
        return None
    return psi_from_proportions(expected, actual)


def missing_rate(series: pd.Series) -> float:
    if len(series) == 0:
        return 0.0
    return float(series.isna().mean())


def safe_float(value: Any) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None
