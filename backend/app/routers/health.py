from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import __version__
from app.config import settings
from app.database import get_db
from app.services.mlflow_tracker import tracker
from app.services.storage import storage
from app.utils import utcnow

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": settings.app_name,
        "version": __version__,
        "environment": settings.environment,
        "timestamp": utcnow().isoformat(),
    }


@router.get("/health/ready")
def readiness(response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    checks: dict[str, Any] = {}
    ready = True

    try:
        db.execute(text("SELECT 1"))
        checks["database"] = {"status": "ok", "dialect": db.bind.dialect.name if db.bind else "unknown"}
    except Exception as exc:
        ready = False
        checks["database"] = {"status": "error", "error": str(exc)[:200]}

    storage_health = storage.check_health()
    checks["storage"] = storage_health
    if storage_health.get("status") != "ok":
        ready = False

    if settings.mlflow_enabled:
        mlflow_health = tracker.health()
        checks["mlflow"] = {
            "status": mlflow_health.get("status"),
            "ui_url": settings.mlflow_ui_url or None,
        }
        # MLflow is a non-critical dependency for serving predictions: report
        # degradation but do not make the API unready when tracking is down.
        if mlflow_health.get("status") == "error":
            checks["mlflow"]["detail"] = "Tracking is unavailable; training runs will record this condition."
    else:
        checks["mlflow"] = {"status": "disabled"}

    checks["job_runner"] = {
        "mode": settings.job_runner,
        "pid": os.getpid(),
    }
    if not ready:
        response.status_code = 503
    return {
        "status": "ready" if ready else "not_ready",
        "version": __version__,
        "environment": settings.environment,
        "checks": checks,
        "timestamp": utcnow().isoformat(),
    }


@router.get("/version")
def version() -> dict[str, Any]:
    return {
        "service": settings.app_name,
        "version": __version__,
        "git_commit": settings.git_commit or "unversioned",
        "environment": settings.environment,
        "api_prefix": settings.api_prefix,
    }
