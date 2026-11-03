from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import ProjectContext, get_current_user, get_project_context, project_context_for_user
from app.errors import ConflictError, NotFoundError, ValidationAppError
from app.models import Deployment, ModelVersion, Project, RegisteredModel, User
from app.schemas import (
    ApproveRequest,
    ModelCardUpdate,
    ModelOut,
    ModelUpdate,
    ModelVersionOut,
    PromoteRequest,
    RejectRequest,
)
from app.services.audit import record_audit
from app.services.mlflow_tracker import tracker
from app.services.serializers import serialize_model, serialize_model_version

router = APIRouter(tags=["registry"])


def _version_context(db: Session, user: User, version_id: str) -> tuple[ModelVersion, RegisteredModel, Project]:
    version = db.get(ModelVersion, version_id)
    if not version:
        raise NotFoundError("Model version not found")
    model = db.get(RegisteredModel, version.registered_model_id)
    project = db.get(Project, version.project_id)
    if not model or not project:
        raise NotFoundError("Model version lineage is incomplete")
    project_context_for_user(db, user, project.id)
    return version, model, project


def _model_context(db: Session, user: User, model_id: str) -> tuple[RegisteredModel, Project]:
    model = db.get(RegisteredModel, model_id)
    if not model:
        raise NotFoundError("Registered model not found")
    project = db.get(Project, model.project_id)
    if not project:
        raise NotFoundError("Project not found")
    project_context_for_user(db, user, project.id)
    return model, project


def _admin_required(db: Session, user: User, project_id: str) -> None:
    context = project_context_for_user(db, user, project_id)
    if not context.is_admin:
        raise ValidationAppError("Only workspace administrators can approve, reject or promote model versions.")


@router.get("/projects/{project_id}/models", response_model=list[ModelOut])
def list_models(
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> list[ModelOut]:
    models = db.scalars(
        select(RegisteredModel)
        .where(RegisteredModel.project_id == ctx.project.id)
        .order_by(RegisteredModel.created_at.desc())
    ).all()
    return [ModelOut(**serialize_model(db, model)) for model in models]


@router.get("/models/{model_id}", response_model=ModelOut)
def get_model(
    model_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ModelOut:
    model, _project = _model_context(db, user, model_id)
    return ModelOut(**serialize_model(db, model))


@router.get("/models/{model_id}/versions", response_model=list[ModelVersionOut])
def list_versions(
    model_id: str,
    approval_status: Literal["pending", "approved", "rejected"] | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ModelVersionOut]:
    model, _project = _model_context(db, user, model_id)
    stmt = select(ModelVersion).where(ModelVersion.registered_model_id == model.id)
    if approval_status:
        stmt = stmt.where(ModelVersion.approval_status == approval_status)
    versions = db.scalars(stmt.order_by(ModelVersion.version.desc())).all()
    return [ModelVersionOut(**serialize_model_version(db, version)) for version in versions]


@router.patch("/models/{model_id}", response_model=ModelOut)
def update_model(
    model_id: str,
    payload: ModelUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ModelOut:
    model, project = _model_context(db, user, model_id)
    if payload.name is not None:
        if db.scalar(
            select(RegisteredModel.id).where(
                RegisteredModel.project_id == project.id,
                func.lower(RegisteredModel.name) == payload.name.strip().lower(),
                RegisteredModel.id != model.id,
            )
        ):
            raise ConflictError("A registered model with that name already exists in this project.")
        model.name = payload.name.strip()
    if payload.description is not None:
        model.description = payload.description.strip()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="model.updated",
        entity_type="registered_model",
        entity_id=model.id,
        details={"fields": sorted(payload.model_dump(exclude_unset=True).keys())},
        request=request,
    )
    db.commit()
    return ModelOut(**serialize_model(db, model))


@router.get("/versions/{version_id}", response_model=ModelVersionOut)
def get_version(
    version_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ModelVersionOut:
    version, _model, _project = _version_context(db, user, version_id)
    return ModelVersionOut(**serialize_model_version(db, version))


@router.get("/versions/{version_id}/deployments")
def version_deployments(
    version_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    version, _model, _project = _version_context(db, user, version_id)
    deployments = db.scalars(select(Deployment).where(Deployment.model_version_id == version.id)).all()
    return [
        {
            "id": deployment.id,
            "name": deployment.name,
            "slug": deployment.slug,
            "status": deployment.status,
            "last_health_status": deployment.last_health_status,
            "created_at": deployment.created_at,
        }
        for deployment in deployments
    ]


@router.patch("/versions/{version_id}/model-card", response_model=ModelVersionOut)
def update_model_card(
    version_id: str,
    payload: ModelCardUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ModelVersionOut:
    version, _model, project = _version_context(db, user, version_id)
    card = dict(version.model_card_json or {})
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            card[key] = value
    card["last_edited_by"] = user.full_name
    card["last_edited_at"] = __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc
    ).isoformat()
    version.model_card_json = card
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="model_card.updated",
        entity_type="model_version",
        entity_id=version.id,
        details={"fields": sorted(payload.model_dump(exclude_unset=True).keys())},
        request=request,
    )
    db.commit()
    return ModelVersionOut(**serialize_model_version(db, version))


@router.post("/versions/{version_id}/approve", response_model=ModelVersionOut)
def approve_version(
    version_id: str,
    payload: ApproveRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ModelVersionOut:
    version, model, project = _version_context(db, user, version_id)
    _admin_required(db, user, project.id)
    if version.approval_status == "approved":
        raise ConflictError("This model version is already approved.")
    if version.validation_status == "failed":
        raise ValidationAppError(
            "This version failed validation gates and cannot be approved. Review the validation details, "
            "retrain, or fix the data first."
        )
    version.approval_status = "approved"
    version.approved_by = user.id
    version.approved_at = __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
    version.approval_note = payload.note.strip()
    version.rejected_reason = ""
    if payload.promote_to_production:
        for other in db.scalars(
            select(ModelVersion).where(
                ModelVersion.registered_model_id == model.id,
                ModelVersion.stage == "production",
                ModelVersion.id != version.id,
            )
        ).all():
            other.stage = "none"
        version.stage = "production"
        tracker.set_alias(project, version.mlflow_model_version, "production")
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="model_version.approved",
        entity_type="model_version",
        entity_id=version.id,
        details={
            "note": payload.note,
            "promoted_to_production": payload.promote_to_production,
            "validation_status": version.validation_status,
            "artifact_hash": version.artifact_hash,
            "deployment_created": False,
        },
        request=request,
    )
    db.commit()
    return ModelVersionOut(**serialize_model_version(db, version))


@router.post("/versions/{version_id}/reject", response_model=ModelVersionOut)
def reject_version(
    version_id: str,
    payload: RejectRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ModelVersionOut:
    version, _model, project = _version_context(db, user, version_id)
    _admin_required(db, user, project.id)
    deployments = int(
        db.scalar(select(func.count(Deployment.id)).where(Deployment.model_version_id == version.id)) or 0
    )
    if deployments:
        raise ConflictError("Roll back or delete deployments before rejecting this version.")
    version.approval_status = "rejected"
    version.rejected_reason = payload.reason.strip()
    version.stage = "archived" if version.stage == "production" else version.stage
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="model_version.rejected",
        entity_type="model_version",
        entity_id=version.id,
        details={"reason": payload.reason},
        request=request,
    )
    db.commit()
    return ModelVersionOut(**serialize_model_version(db, version))


@router.post("/versions/{version_id}/promote", response_model=ModelVersionOut)
def promote_version(
    version_id: str,
    payload: PromoteRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ModelVersionOut:
    version, model, project = _version_context(db, user, version_id)
    _admin_required(db, user, project.id)
    if payload.target == "production":
        if version.approval_status != "approved":
            raise ValidationAppError("Only approved model versions can be promoted to production.")
        if version.validation_status == "failed":
            raise ValidationAppError("This version failed validation gates and cannot be promoted to production.")
        previous = db.scalars(
            select(ModelVersion).where(
                ModelVersion.registered_model_id == model.id,
                ModelVersion.stage == "production",
                ModelVersion.id != version.id,
            )
        ).all()
        for other in previous:
            other.stage = "none"
        version.stage = "production"
        tracker.set_alias(project, version.mlflow_model_version, "production")
        details = {"previous_production_version_ids": [item.id for item in previous]}
    elif payload.target == "staging":
        version.stage = "staging"
        tracker.set_alias(project, version.mlflow_model_version, "staging")
        details = {}
    elif payload.target == "archived":
        if version.stage == "production":
            raise ValidationAppError("Promote a different version to production before archiving this one.")
        version.stage = "archived"
        tracker.remove_alias(project, "staging")
        details = {}
    else:
        version.stage = "none"
        details = {}
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=user,
        action="model_version.promoted",
        entity_type="model_version",
        entity_id=version.id,
        details={
            "target_stage": payload.target,
            "note": payload.note,
            "deployment_changed": False,
            **details,
        },
        request=request,
    )
    db.commit()
    return ModelVersionOut(**serialize_model_version(db, version))


@router.get("/registry/version/{version_id}/integrity")
def verify_artifact(
    version_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    import hashlib

    from app.services.storage import storage

    version, _model, _project = _version_context(db, user, version_id)
    try:
        path = storage.materialize(version.artifact_key)
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        actual = digest.hexdigest()
        return {
            "version_id": version.id,
            "expected_hash": version.artifact_hash,
            "actual_hash": actual,
            "integrity_ok": actual == version.artifact_hash,
        }
    except Exception as exc:
        return {
            "version_id": version.id,
            "expected_hash": version.artifact_hash,
            "integrity_ok": False,
            "error": str(exc)[:300],
        }
