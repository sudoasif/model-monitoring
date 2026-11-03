from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings

PII_PATTERNS = re.compile(
    r"(^|_)(email|e_mail|name|fullname|first_name|last_name|phone|mobile|address|street|"
    r"ssn|social_security|national_id|passport|credit_card|card_number|iban|account_number|"
    r"ip_address|date_of_birth|dob|latitude|longitude|gps)(_|$)",
    re.IGNORECASE,
)


def utcnow() -> datetime:
    return datetime.now(UTC)


def ensure_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    value = ensure_utc(value)
    return value.isoformat().replace("+00:00", "Z") if value else None


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", normalized).strip("-").lower()
    return slug[:80] or "item"


def unique_slug(db: Session, model: Any, base: str, workspace_id: str | None = None) -> str:
    slug = slugify(base)
    candidate = slug
    counter = 2
    while True:
        stmt = select(model).where(model.slug == candidate)
        if workspace_id is not None and hasattr(model, "workspace_id"):
            stmt = stmt.where(model.workspace_id == workspace_id)
        exists = db.scalar(stmt.limit(1))
        if not exists:
            return candidate
        candidate = f"{slug[:70]}-{counter}"
        counter += 1


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_filename(filename: str, fallback: str = "dataset.csv") -> str:
    filename = filename.replace("\\", "/").split("/")[-1]
    filename = re.sub(r"[^A-Za-z0-9._-]", "_", filename)
    return filename[:200] or fallback


def jsonable(value: Any) -> Any:
    """Recursively convert numpy/pandas values to strict JSON-safe Python values."""
    if value is None:
        return None
    if isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, (datetime,)):
        return iso(value)
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(v) for v in value]
    if isinstance(value, np.ndarray):
        return [jsonable(v) for v in value.tolist()]
    try:
        if value != value:  # NaN
            return None
    except Exception:
        pass
    return str(value)


def percentile(values: Iterable[float], q: float) -> float | None:
    data = np.asarray([float(v) for v in values if v is not None], dtype=float)
    if data.size == 0:
        return None
    return float(np.percentile(data, q))


def is_pii_column(column: str) -> bool:
    return bool(PII_PATTERNS.search(column or ""))


def mask_monitoring_features(features: dict[str, Any], allowed: set[str] | None = None) -> dict[str, Any]:
    """Remove known PII-like fields before any monitoring storage.

    We retain only scalar values for statistical drift. Raw request bodies are
    never persisted.
    """
    result: dict[str, Any] = {}
    for key, value in features.items():
        if is_pii_column(key):
            continue
        if allowed is not None and key not in allowed:
            continue
        if isinstance(value, (dict, list)):
            continue
        if isinstance(value, str) and len(value) > 200:
            value = value[:200]
        result[key] = value
    return result


def default_window(days: int = 7) -> tuple[datetime, datetime]:
    end = utcnow()
    return end - timedelta(days=days), end


def clamp_window(
    start: datetime | None, end: datetime | None, max_days: int = 365
) -> tuple[datetime, datetime]:
    now = utcnow()
    end_dt = ensure_utc(end) or now
    start_dt = ensure_utc(start) or (end_dt - timedelta(days=7))
    if start_dt > end_dt:
        start_dt, end_dt = end_dt, start_dt
    if end_dt - start_dt > timedelta(days=max_days):
        start_dt = end_dt - timedelta(days=max_days)
    return start_dt, end_dt


def client_ip(request: Any) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return getattr(request.client, "host", "") or ""


def redact(text: str, max_length: int = 300) -> str:
    sanitized = re.sub(r"(?i)(password|secret|token|key)=[^&\s]+", r"\1=[redacted]", text)
    return sanitized[:max_length]


def config_value(project_config: dict[str, Any] | None, key: str, default: Any) -> Any:
    if not project_config:
        return default
    if key in project_config and project_config[key] is not None:
        return project_config[key]
    policy = project_config.get("promotion_policy") or {}
    if key in policy and policy[key] is not None:
        return policy[key]
    return default


def git_commit() -> str:
    return settings.git_commit or "unversioned"
