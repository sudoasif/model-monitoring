from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from hashlib import sha256
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import func, select
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from app import __version__
from app.config import settings
from app.database import SessionLocal, init_db
from app.errors import AppError, RateLimitError
from app.observability import ACTIVE_DEPLOYMENTS, ObservabilityMiddleware, configure_logging, current_request_id
from app.routers import (
    alerts,
    auth,
    datasets,
    deployments,
    experiments,
    health,
    monitoring,
    pipelines,
    projects,
    registry,
)
from app.routers import (
    settings as settings_router,
)
from app.services.rate_limit import limiter
from app.utils import client_ip

configure_logging("DEBUG" if settings.debug else "INFO")
logger = logging.getLogger("app.startup")


def _error_payload(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "details": details,
            "request_id": current_request_id() or None,
        }
    }


class JsonBodyLimitMiddleware(BaseHTTPMiddleware):
    """Reject oversized JSON bodies before they reach a route handler."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        content_type = request.headers.get("content-type", "").lower()
        if content_type.startswith("application/json"):
            length = request.headers.get("content-length")
            if length:
                try:
                    if int(length) > settings.json_body_limit_bytes:
                        return JSONResponse(
                            status_code=413,
                            content=_error_payload(
                                "payload_too_large",
                                f"JSON request body exceeds the {settings.json_body_limit_bytes // 1024} KB limit.",
                            ),
                        )
                except ValueError:
                    return JSONResponse(
                        status_code=400,
                        content=_error_payload("invalid_content_length", "Invalid Content-Length header."),
                    )
        return await call_next(request)


class ApiRateLimitMiddleware(BaseHTTPMiddleware):
    """Coarse per-identity API limit. Sensitive routes keep stricter local limits."""

    SKIP_PREFIXES = (
        "/health",
        f"{settings.api_prefix}/health",
        f"{settings.api_prefix}/auth",
        f"{settings.api_prefix}/docs",
        f"{settings.api_prefix}/redoc",
        f"{settings.api_prefix}/openapi.json",
        f"{settings.api_prefix}/metrics",
    )

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        path = request.url.path
        if request.method == "OPTIONS" or not path.startswith(settings.api_prefix):
            return await call_next(request)
        if path.startswith(self.SKIP_PREFIXES) or "/predict" in path:
            return await call_next(request)
        authorization = request.headers.get("authorization", "")
        api_key = request.headers.get("x-api-key", "")
        if authorization:
            identity = f"token:{sha256(authorization.encode()).hexdigest()[:24]}"
        elif api_key:
            identity = f"key:{api_key[:12]}"
        else:
            identity = f"ip:{client_ip(request)}"
        try:
            limiter.hit(f"api:{identity}", settings.rate_limit_api_per_minute, 60)
        except RateLimitError as exc:
            return JSONResponse(
                status_code=429,
                content=_error_payload("rate_limited", "Too many requests. Please retry later."),
                headers={**exc.headers, "X-Request-ID": current_request_id()},
            )
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        return response


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    if settings.auto_create_tables:
        init_db()
        logger.info("database_tables_initialized", extra={"extra_fields": {"path": settings.database_url}})
    else:
        logger.info("database_auto_create_disabled")
    if settings.is_production and settings.secret_key.startswith("dev-only-"):
        logger.warning(
            "insecure_secret_key",
            extra={"extra_fields": {"detail": "Set SECRET_KEY before running in production."}},
        )
    try:
        from app.models import Deployment

        db = SessionLocal()
        try:
            count = int(db.scalar(select(func.count(Deployment.id)).where(Deployment.status == "active")) or 0)
            ACTIVE_DEPLOYMENTS.set(count)
        finally:
            db.close()
    except Exception:
        logger.warning("deployment_gauge_initialization_failed", exc_info=True)
    yield
    logger.info("application_shutdown")


app = FastAPI(
    title=settings.app_name,
    version=__version__,
    description=(
        "MLOps and model monitoring platform. Every metric, prediction, drift report and alert "
        "is produced by real pipeline execution; simulated demo traffic is explicitly labelled."
    ),
    docs_url=f"{settings.api_prefix}/docs",
    redoc_url=f"{settings.api_prefix}/redoc",
    openapi_url=f"{settings.api_prefix}/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(ObservabilityMiddleware)
app.add_middleware(ApiRateLimitMiddleware)
app.add_middleware(JsonBodyLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_host_list or ["*"])
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Workspace-Id",
        "X-API-Key",
        "X-Request-ID",
        "Idempotency-Key",
    ],
    expose_headers=["X-Request-ID", "Retry-After"],
    max_age=600,
)


@app.exception_handler(AppError)
async def app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=_error_payload(exc.code, exc.message, exc.details),
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = []
    for error in exc.errors():
        errors.append(
            {
                "location": [str(part) for part in error.get("loc", [])],
                "message": error.get("msg", "Invalid value"),
                "type": error.get("type", "validation_error"),
            }
        )
    return JSONResponse(
        status_code=422,
        content=_error_payload(
            "validation_error",
            "The request could not be validated.",
            {"errors": errors[:50]},
        ),
    )


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = {
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        405: "method_not_allowed",
        409: "conflict",
        413: "payload_too_large",
        429: "rate_limited",
    }.get(exc.status_code, "http_error")
    detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
    return JSONResponse(
        status_code=exc.status_code,
        content=_error_payload(code, detail),
        headers=exc.headers if isinstance(exc.headers, dict) else None,
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled_exception")
    return JSONResponse(
        status_code=500,
        content=_error_payload(
            "internal_error",
            "An unexpected error occurred. Use the request id when contacting support.",
        ),
    )


api = settings.api_prefix
for router in (
    auth.router,
    auth.workspace_router,
    auth.admin_router,
    projects.router,
    datasets.router,
    experiments.router,
    registry.router,
    deployments.router,
    deployments.public_router,
    monitoring.router,
    monitoring.drift_router,
    alerts.router,
    alerts.rule_router,
    alerts.incident_router,
    pipelines.router,
    pipelines.demo_router,
    settings_router.router,
    health.router,
):
    app.include_router(router, prefix=api)


@app.get("/", include_in_schema=False)
def root() -> dict[str, Any]:
    return {
        "service": settings.app_name,
        "version": __version__,
        "environment": settings.environment,
        "docs": f"{settings.api_prefix}/docs",
        "health": "/health",
        "metrics": "/metrics",
    }


@app.get("/health", include_in_schema=False)
def root_health() -> dict[str, Any]:
    return health.health()


@app.get("/metrics", include_in_schema=False)
def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
