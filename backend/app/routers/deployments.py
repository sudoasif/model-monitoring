from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import (
    get_current_user,
    get_workspace_context,
    project_context_for_user,
)
from app.errors import AppError, NotFoundError, UnauthorizedError, ValidationAppError
from app.models import (
    Dataset,
    DatasetVersion,
    Deployment,
    ModelVersion,
    PredictionEvent,
    Project,
    User,
)
from app.schemas import (
    BatchPredictionRequest,
    BatchPredictionResult,
    DeploymentCreate,
    DeploymentCreated,
    DeploymentOut,
    DeploymentUpdate,
    ExplainRequest,
    PredictionRequest,
    PredictionResult,
)
from app.security import decode_token, generate_api_key
from app.services.audit import record_audit
from app.services.explainability import global_explanation, local_explanation
from app.services.prediction import (
    deployment_authenticated,
    deployment_sample_record,
    evaluate_deployment_health_and_alert,
    predict_records,
)
from app.services.rate_limit import limiter
from app.services.serializers import serialize_deployment
from app.utils import client_ip, slugify, utcnow

router = APIRouter(tags=["deployments"])
public_router = APIRouter(tags=["prediction"])


def _slug(db: Session, name: str) -> str:
    base = slugify(name) or "deployment"
    for _ in range(10):
        candidate = f"{base}-{uuid.uuid4().hex[:6]}"
        if not db.scalar(select(Deployment.id).where(Deployment.slug == candidate)):
            return candidate
    return f"{base}-{uuid.uuid4().hex[:10]}"


def _deployment_context(db: Session, user: User, deployment_id: str) -> tuple[Deployment, Project]:
    deployment = db.get(Deployment, deployment_id)
    if not deployment:
        deployment = db.scalar(select(Deployment).where(Deployment.slug == deployment_id))
    if not deployment:
        raise NotFoundError("Deployment not found")
    project = db.get(Project, deployment.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    return deployment, project


def _require_admin(db: Session, user: User, project: Project) -> None:
    context = project_context_for_user(db, user, project.id)
    if not context.is_admin:
        raise ValidationAppError("Only workspace administrators can manage deployments.")


def _request_user(request: Request, db: Session) -> User | None:
    token = ""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        token = header.split(" ", 1)[1].strip()
    if not token:
        token = request.cookies.get(settings.access_cookie_name) or ""
    if not token:
        return None
    payload = decode_token(token, "access")
    user = db.get(User, payload.get("sub"))
    if not user or not user.is_active:
        raise UnauthorizedError("User account is inactive or missing.")
    return user


def _prediction_auth(db: Session, deployment: Deployment, request: Request) -> User | None:
    user = _request_user(request, db)
    api_key = request.headers.get("x-api-key") or request.headers.get("authorization", "").removeprefix("ApiKey ").strip()
    return deployment_authenticated(db, deployment, user, api_key)


@router.get("/deployments")
def list_deployments(
    project_id: str | None = None,
    status: str | None = None,
    q: str | None = None,
    limit: int = 20,
    offset: int = 0,
    ctx=Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    stmt = select(Deployment).join(Project, Project.id == Deployment.project_id).where(
        Project.workspace_id == ctx.workspace.id
    )
    count_stmt = select(func.count(Deployment.id)).join(Project, Project.id == Deployment.project_id).where(
        Project.workspace_id == ctx.workspace.id
    )
    if project_id:
        stmt = stmt.where(Deployment.project_id == project_id)
        count_stmt = count_stmt.where(Deployment.project_id == project_id)
    if status:
        stmt = stmt.where(Deployment.status == status)
        count_stmt = count_stmt.where(Deployment.status == status)
    if q:
        pattern = f"%{q.strip()}%"
        condition = or_(Deployment.name.ilike(pattern), Deployment.description.ilike(pattern))
        stmt = stmt.where(condition)
        count_stmt = count_stmt.where(condition)
    total = int(db.scalar(count_stmt) or 0)
    deployments = db.scalars(stmt.order_by(Deployment.created_at.desc()).limit(limit).offset(offset)).all()
    return {
        "items": [serialize_deployment(db, deployment) for deployment in deployments],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.post("/deployments", response_model=DeploymentCreated, status_code=201)
def create_deployment(
    payload: DeploymentCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeploymentCreated:
    project = db.get(Project, payload.project_id)
    if not project:
        raise NotFoundError("Project not found")
    _require_admin(db, user, project)
    if project.status != "active":
        raise ValidationAppError("Archived projects cannot create deployments.")
    version = db.get(ModelVersion, payload.model_version_id)
    if not version or version.project_id != project.id:
        raise NotFoundError("Model version not found in this project")
    if version.approval_status != "approved":
        raise ValidationAppError(
            "Only approved model versions can be deployed. Submit the version for approval first."
        )
    if version.validation_status == "failed":
        raise ValidationAppError("This model version failed validation gates and cannot be deployed.")
    reference_id = payload.reference_dataset_version_id or version.dataset_version_id
    if reference_id:
        reference = db.get(DatasetVersion, reference_id)
        dataset = db.get(Dataset, reference.dataset_id) if reference else None
        if not reference or not dataset or dataset.project_id != project.id:
            raise ValidationAppError("The reference dataset version must belong to this project.")
    else:
        raise ValidationAppError(
            "A reference dataset is required for drift monitoring. Link a dataset version before deploying."
        )
    api_key, prefix, api_key_hash = generate_api_key()
    deployment = Deployment(
        project_id=project.id,
        model_version_id=version.id,
        name=payload.name.strip(),
        slug=_slug(db, payload.name),
        description=payload.description.strip(),
        status="active",
        config_json={
            "reference_dataset_version_id": reference_id,
            "min_label_samples": payload.min_label_samples,
            "capture_samples": True,
            "deployed_version_history": [
                {
                    "model_version_id": version.id,
                    "model_version": version.version,
                    "deployed_at": utcnow().isoformat(),
                    "deployed_by": user.id,
                    "action": "created",
                }
            ],
        },
        api_key_hash=api_key_hash,
        api_key_prefix=prefix,
        created_by=user.id,
    )
    db.add(deployment)
    db.flush()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="deployment.created",
        entity_type="deployment",
        entity_id=deployment.id,
        details={
            "project_id": project.id,
            "model_version_id": version.id,
            "model_version": version.version,
            "api_key_prefix": prefix,
            "artifact_hash": version.artifact_hash,
        },
        request=request,
    )
    db.commit()
    health = None
    try:
        health = evaluate_deployment_health_and_alert(db, deployment, request)
    except Exception:
        pass
    payload_out = serialize_deployment(db, deployment)
    payload_out["last_health_status"] = "healthy" if (health or {}).get("status") == "healthy" else deployment.last_health_status
    return DeploymentCreated(**payload_out, api_key=api_key)


@router.get("/deployments/{deployment_id}", response_model=DeploymentOut)
def get_deployment(
    deployment_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeploymentOut:
    deployment, _project = _deployment_context(db, user, deployment_id)
    return DeploymentOut(**serialize_deployment(db, deployment))


@router.patch("/deployments/{deployment_id}", response_model=DeploymentOut)
def update_deployment(
    deployment_id: str,
    payload: DeploymentUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeploymentOut:
    deployment, project = _deployment_context(db, user, deployment_id)
    _require_admin(db, user, project)
    config = dict(deployment.config_json or {})
    if payload.name is not None:
        deployment.name = payload.name.strip()
    if payload.description is not None:
        deployment.description = payload.description.strip()
    if payload.reference_dataset_version_id is not None:
        reference = db.get(DatasetVersion, payload.reference_dataset_version_id)
        dataset = db.get(Dataset, reference.dataset_id) if reference else None
        if not reference or not dataset or dataset.project_id != project.id:
            raise ValidationAppError("The reference dataset version must belong to this project.")
        config["reference_dataset_version_id"] = reference.id
    if payload.min_label_samples is not None:
        config["min_label_samples"] = payload.min_label_samples
    if payload.capture_samples is not None:
        config["capture_samples"] = payload.capture_samples
    deployment.config_json = config
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="deployment.updated",
        entity_type="deployment",
        entity_id=deployment.id,
        details={"fields": sorted(payload.model_dump(exclude_unset=True).keys())},
        request=request,
    )
    db.commit()
    return DeploymentOut(**serialize_deployment(db, deployment))


@router.post("/deployments/{deployment_id}/status", response_model=DeploymentOut)
def set_deployment_status(
    deployment_id: str,
    status: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeploymentOut:
    if status not in {"active", "paused"}:
        raise ValidationAppError("Status must be 'active' or 'paused'.")
    deployment, project = _deployment_context(db, user, deployment_id)
    _require_admin(db, user, project)
    deployment.status = status
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action=f"deployment.{status}",
        entity_type="deployment",
        entity_id=deployment.id,
        details={"status": status},
        request=request,
    )
    db.commit()
    return DeploymentOut(**serialize_deployment(db, deployment))


@router.post("/deployments/{deployment_id}/rollback", response_model=DeploymentOut)
def rollback_deployment(
    deployment_id: str,
    target_version_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeploymentOut:
    from app.services.prediction import model_cache

    deployment, project = _deployment_context(db, user, deployment_id)
    _require_admin(db, user, project)
    target = db.get(ModelVersion, target_version_id)
    if not target or target.project_id != project.id:
        raise NotFoundError("Target model version not found in this project")
    if target.approval_status != "approved":
        raise ValidationAppError("Rollback targets must be approved model versions.")
    if target.id == deployment.model_version_id:
        raise ValidationAppError("The deployment is already serving that model version.")
    previous_id = deployment.model_version_id
    previous = db.get(ModelVersion, previous_id)
    deployment.model_version_id = target.id
    config = dict(deployment.config_json or {})
    history = list(config.get("deployed_version_history") or [])
    history.append(
        {
            "model_version_id": target.id,
            "model_version": target.version,
            "deployed_at": utcnow().isoformat(),
            "deployed_by": user.id,
            "action": "rollback",
            "previous_model_version_id": previous_id,
        }
    )
    config["deployed_version_history"] = history[-50:]
    deployment.config_json = config
    model_cache.invalidate(previous_id)
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="deployment.rollback",
        entity_type="deployment",
        entity_id=deployment.id,
        details={
            "from_model_version_id": previous_id,
            "from_model_version": previous.version if previous else None,
            "to_model_version_id": target.id,
            "to_model_version": target.version,
            "artifact_hash": target.artifact_hash,
        },
        request=request,
    )
    db.commit()
    try:
        evaluate_deployment_health_and_alert(db, deployment, request)
    except Exception:
        pass
    return DeploymentOut(**serialize_deployment(db, deployment))


@router.post("/deployments/{deployment_id}/rotate-key", response_model=DeploymentCreated)
def rotate_api_key(
    deployment_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeploymentCreated:
    deployment, project = _deployment_context(db, user, deployment_id)
    _require_admin(db, user, project)
    api_key, prefix, api_key_hash = generate_api_key()
    deployment.api_key_hash = api_key_hash
    deployment.api_key_prefix = prefix
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="deployment.api_key_rotated",
        entity_type="deployment",
        entity_id=deployment.id,
        details={"api_key_prefix": prefix},
        request=request,
    )
    db.commit()
    return DeploymentCreated(**serialize_deployment(db, deployment), api_key=api_key)


@router.get("/deployments/{deployment_id}/health")
def deployment_health(
    deployment_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment = db.get(Deployment, deployment_id) or db.scalar(
        select(Deployment).where(Deployment.slug == deployment_id)
    )
    if not deployment:
        raise NotFoundError("Deployment not found")
    _prediction_auth(db, deployment, request)
    return evaluate_deployment_health_and_alert(db, deployment, request)


@router.get("/deployments/{deployment_id}/prediction-schema")
def get_prediction_schema(
    deployment_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_context(db, user, deployment_id)
    return deployment_sample_record(db, deployment)


@router.get("/deployments/{deployment_id}/sample")
def get_sample(
    deployment_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_context(db, user, deployment_id)
    return deployment_sample_record(db, deployment)


@router.get("/deployments/{deployment_id}/explainability")
def deployment_global_explanation(
    deployment_id: str,
    top_n: int = 15,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_context(db, user, deployment_id)
    return global_explanation(db, deployment, top_n=max(1, min(int(top_n), 30)))


@router.post("/deployments/{deployment_id}/explain")
def deployment_local_explanation(
    deployment_id: str,
    payload: ExplainRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    deployment, _project = _deployment_context(db, user, deployment_id)
    return local_explanation(db, deployment, payload.features, top_n=payload.top_n)


def _check_prediction_body(request: Request) -> None:
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > settings.max_prediction_body_bytes:
                raise AppError(
                    413,
                    "payload_too_large",
                    f"Prediction payload exceeds the {settings.max_prediction_body_bytes // 1024} KB limit.",
                )
        except ValueError:
            raise ValidationAppError("Invalid Content-Length header.") from None


def _rate_limit_prediction(request: Request, deployment: Deployment) -> None:
    api_key = request.headers.get("x-api-key", "")
    identity = api_key[:16] if api_key else client_ip(request)
    limiter.hit(
        f"predict:{deployment.id}:{identity}",
        settings.rate_limit_predict_per_minute,
        60,
    )


@router.post("/deployments/{deployment_id}/predict", response_model=PredictionResult)
def predict_single(
    deployment_id: str,
    payload: PredictionRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> PredictionResult:
    deployment = db.get(Deployment, deployment_id) or db.scalar(
        select(Deployment).where(Deployment.slug == deployment_id)
    )
    if not deployment:
        raise NotFoundError("Deployment not found")
    _prediction_auth(db, deployment, request)
    _check_prediction_body(request)
    _rate_limit_prediction(request, deployment)
    if payload.request_id:
        existing = db.scalar(
            select(PredictionEvent).where(PredictionEvent.request_id == payload.request_id)
        )
        if existing:
            raise ValidationAppError("request_id has already been used. Use a unique idempotency key.")
    results = predict_records(
        db,
        deployment=deployment,
        records=[payload.features],
        return_probabilities=payload.return_probabilities,
        simulated=False,
        persist=True,
        is_batch=False,
        request_id=payload.request_id,
    )
    result = dict(results[0])
    return PredictionResult(**result)


@router.post("/deployments/{deployment_id}/predict/batch", response_model=BatchPredictionResult)
def predict_batch(
    deployment_id: str,
    payload: BatchPredictionRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> BatchPredictionResult:
    deployment = db.get(Deployment, deployment_id) or db.scalar(
        select(Deployment).where(Deployment.slug == deployment_id)
    )
    if not deployment:
        raise NotFoundError("Deployment not found")
    _prediction_auth(db, deployment, request)
    _check_prediction_body(request)
    _rate_limit_prediction(request, deployment)
    if len(payload.records) > settings.max_batch_size:
        raise ValidationAppError(f"Batch size exceeds the {settings.max_batch_size} record limit.")
    import time

    started = time.perf_counter()
    results = predict_records(
        db,
        deployment=deployment,
        records=payload.records,
        return_probabilities=payload.return_probabilities,
        simulated=False,
        persist=True,
        is_batch=True,
    )
    elapsed = (time.perf_counter() - started) * 1000
    return BatchPredictionResult(
        request_id=results[0]["request_id"].rsplit("-", 1)[0] if results else str(uuid.uuid4()),
        deployment_id=deployment.id,
        model_version=results[0]["model_version"] if results else 0,
        timestamp=utcnow(),
        predictions=[PredictionResult(**result) for result in results],
        count=len(results),
        latency_ms=round(elapsed, 3),
    )


@public_router.post("/predict/{deployment_slug}", response_model=PredictionResult)
def predict_by_slug(
    deployment_slug: str,
    payload: PredictionRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> PredictionResult:
    return predict_single(deployment_slug, payload, request, db)
