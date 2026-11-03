from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import ProjectContext, WorkspaceContext, get_project_context, get_workspace_context
from app.errors import ConflictError, ValidationAppError
from app.models import Dataset, Deployment, Project
from app.schemas import ProjectCreate, ProjectOut, ProjectUpdate
from app.services.audit import record_audit
from app.services.serializers import serialize_project
from app.utils import slugify

router = APIRouter(prefix="/projects", tags=["projects"])

DEFAULT_PROMOTION_POLICY = {
    "min_primary_metric": None,
    "max_generalization_gap": 0.30,
    "min_test_samples": 20,
    "retrain_min_improvement": 0.005,
    "retrain_min_relative_improvement": 0.02,
    "require_approval": True,
    "allow_auto_promote": False,
}


def _unique_slug(db: Session, workspace_id: str, name: str) -> str:
    base = slugify(name) or "project"
    candidate = base
    counter = 1
    while db.scalar(
        select(Project.id).where(Project.workspace_id == workspace_id, Project.slug == candidate)
    ):
        counter += 1
        candidate = f"{base}-{counter}"
    return candidate


@router.get("", response_model=dict[str, Any])
def list_projects(
    q: str | None = Query(default=None, max_length=200),
    status: Literal["active", "archived"] | None = None,
    sort: str = Query(default="updated_at", pattern="^(name|created_at|updated_at)$"),
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    stmt = select(Project).where(Project.workspace_id == ctx.workspace.id)
    count_stmt = select(func.count(Project.id)).where(Project.workspace_id == ctx.workspace.id)
    if q:
        pattern = f"%{q.strip()}%"
        condition = or_(Project.name.ilike(pattern), Project.description.ilike(pattern))
        stmt = stmt.where(condition)
        count_stmt = count_stmt.where(condition)
    if status:
        stmt = stmt.where(Project.status == status)
        count_stmt = count_stmt.where(Project.status == status)
    total = int(db.scalar(count_stmt) or 0)
    column = getattr(Project, sort)
    stmt = stmt.order_by(column.desc() if order == "desc" else column.asc()).limit(limit).offset(offset)
    projects = db.scalars(stmt).all()
    return {
        "items": [serialize_project(db, project) for project in projects],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    payload: ProjectCreate,
    request: Request,
    ctx: WorkspaceContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
) -> ProjectOut:
    name = payload.name.strip()
    if db.scalar(
        select(Project.id).where(
            Project.workspace_id == ctx.workspace.id, func.lower(Project.name) == name.lower()
        )
    ):
        raise ConflictError("A project with that name already exists in this workspace.")
    policy = {**DEFAULT_PROMOTION_POLICY}
    if payload.task_type == "classification":
        policy["min_primary_metric"] = 0.60
    else:
        policy["min_primary_metric"] = 0.30
    project = Project(
        workspace_id=ctx.workspace.id,
        name=name,
        slug=_unique_slug(db, ctx.workspace.id, name),
        description=payload.description.strip(),
        task_type=payload.task_type,
        target_column=payload.target_column.strip(),
        positive_label=payload.positive_label,
        config_json={"promotion_policy": policy},
        created_by=ctx.user.id,
    )
    db.add(project)
    db.flush()
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=ctx.user,
        action="project.created",
        entity_type="project",
        entity_id=project.id,
        details={"name": project.name, "task_type": project.task_type},
        request=request,
    )
    db.commit()
    return ProjectOut(**serialize_project(db, project))


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(ctx: ProjectContext = Depends(get_project_context), db: Session = Depends(get_db)) -> ProjectOut:
    return ProjectOut(**serialize_project(db, ctx.project))


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(
    payload: ProjectUpdate,
    request: Request,
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> ProjectOut:
    project = ctx.project
    if payload.name is not None and payload.name.strip() != project.name:
        if not ctx.is_admin:
            raise ValidationAppError("Only workspace administrators can rename projects.")
        name = payload.name.strip()
        if db.scalar(
            select(Project.id).where(
                Project.workspace_id == project.workspace_id,
                func.lower(Project.name) == name.lower(),
                Project.id != project.id,
            )
        ):
            raise ConflictError("A project with that name already exists in this workspace.")
        project.name = name
        project.slug = _unique_slug(db, project.workspace_id, name)
    if payload.description is not None:
        project.description = payload.description.strip()
    if payload.task_type is not None and payload.task_type != project.task_type:
        dataset_count = int(
            db.scalar(select(func.count(Dataset.id)).where(Dataset.project_id == project.id)) or 0
        )
        if dataset_count:
            raise ValidationAppError("The task type cannot be changed after datasets have been uploaded.")
        project.task_type = payload.task_type
    if payload.target_column is not None:
        project.target_column = payload.target_column.strip()
    if payload.positive_label is not None:
        project.positive_label = payload.positive_label or None
    if payload.status is not None:
        if payload.status == "archived" and not ctx.is_admin:
            raise ValidationAppError("Only workspace administrators can archive projects.")
        project.status = payload.status
    if payload.config is not None:
        current = dict(project.config_json or {})
        current.update(payload.config)
        project.config_json = current
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=ctx.workspace_ctx.user,
        action="project.updated",
        entity_type="project",
        entity_id=project.id,
        details={"fields": sorted(payload.model_dump(exclude_unset=True).keys())},
        request=request,
    )
    db.commit()
    return ProjectOut(**serialize_project(db, project))


@router.delete("/{project_id}", status_code=204)
def delete_project(
    request: Request,
    ctx: ProjectContext = Depends(get_project_context),
    db: Session = Depends(get_db),
) -> None:
    if not ctx.is_admin:
        raise ValidationAppError("Only workspace administrators can delete projects.")
    deployment_count = int(
        db.scalar(select(func.count(Deployment.id)).where(Deployment.project_id == ctx.project.id)) or 0
    )
    if deployment_count:
        raise ConflictError("Archive the project instead of deleting it while deployments still reference its models.")
    record_audit(
        db,
        workspace_id=ctx.project.workspace_id,
        actor=ctx.workspace_ctx.user,
        action="project.deleted",
        entity_type="project",
        entity_id=ctx.project.id,
        details={"name": ctx.project.name},
        request=request,
    )
    db.delete(ctx.project)
    db.commit()
