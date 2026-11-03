from __future__ import annotations

import contextvars
import json
import logging
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from prometheus_client import Counter, Gauge, Histogram
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="")
request_path_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_path", default="")


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": request_id_var.get() or None,
            "service": "mlops-api",
        }
        if request_path_var.get():
            payload["path"] = request_path_var.get()
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        extra = getattr(record, "extra_fields", None)
        if isinstance(extra, dict):
            payload.update(extra)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonLogFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
    for noisy in ("uvicorn.access", "httpcore", "httpx", "botocore", "mlflow"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    logging.getLogger("uvicorn").setLevel(logging.INFO)


HTTP_REQUESTS = Counter(
    "mlops_http_requests_total", "HTTP requests processed", ["method", "route", "status"]
)
HTTP_DURATION = Histogram(
    "mlops_http_request_duration_seconds",
    "HTTP request duration",
    ["method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
)
PREDICTIONS = Counter(
    "mlops_predictions_total", "Model predictions served", ["deployment_id", "status", "batch"]
)
PREDICTION_LATENCY = Histogram(
    "mlops_prediction_latency_seconds",
    "Model prediction latency",
    ["deployment_id"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5),
)
TRAINING_JOBS = Counter(
    "mlops_training_jobs_total", "Training job outcomes", ["status", "task_type"]
)
DRIFT_REPORTS = Counter("mlops_drift_reports_total", "Drift reports by severity", ["severity"])
ALERTS_CREATED = Counter("mlops_alerts_total", "Alerts created", ["severity", "type"])
ACTIVE_DEPLOYMENTS = Gauge("mlops_active_deployments", "Deployments currently active")
PIPELINE_JOBS = Counter("mlops_pipeline_jobs_total", "Pipeline job outcomes", ["job_type", "status"])
BACKGROUND_JOBS_IN_PROGRESS = Gauge("mlops_background_jobs_in_progress", "Background jobs in progress")


class ObservabilityMiddleware(BaseHTTPMiddleware):
    """Correlates requests, logs structured access events and records metrics."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        supplied = request.headers.get("x-request-id", "")
        request_id = supplied if supplied and 8 <= len(supplied) <= 64 and supplied.isascii() else str(uuid.uuid4())
        token = request_id_var.set(request_id)
        path_token = request_path_var.set(request.url.path)
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-ID"] = request_id
            return response
        except Exception:
            logging.getLogger("app.request").exception(
                "unhandled_request_error", extra={"extra_fields": {"method": request.method, "path": request.url.path}}
            )
            raise
        finally:
            elapsed = time.perf_counter() - started
            route = request.scope.get("route")
            route_label = getattr(route, "path", None) or "unmatched"
            if path_token is not None:
                HTTP_REQUESTS.labels(request.method, route_label, str(status)).inc()
                HTTP_DURATION.labels(request.method, route_label).observe(elapsed)
            logging.getLogger("app.access").info(
                "request_completed",
                extra={
                    "extra_fields": {
                        "method": request.method,
                        "path": request.url.path,
                        "status": status,
                        "duration_ms": round(elapsed * 1000, 2),
                    }
                },
            )
            request_id_var.reset(token)
            request_path_var.reset(path_token)


def current_request_id() -> str:
    return request_id_var.get()
