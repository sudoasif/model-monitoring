from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.errors import ForbiddenError, NotFoundError, UnauthorizedError
from app.models import Project, User, Workspace, WorkspaceMember
from app.security import decode_token


@dataclass
class WorkspaceContext:
    workspace: Workspace
    role: str
    user: User

    @property
    def is_admin(self) -> bool:
        return self.user.role == "admin" or self.role in {"owner", "admin"}


def _token_from_request(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header.split(" ", 1)[1].strip()
    cookie = request.cookies.get(settings.access_cookie_name)
    return cookie or None


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
) -> User:
    token = _token_from_request(request)
    if not token:
        raise UnauthorizedError()
    payload = decode_token(token, "access")
    user = db.get(User, payload.get("sub"))
    if not user or not user.is_active:
        raise UnauthorizedError("User account is inactive or missing.")
    request.state.user_id = user.id
    return user


def get_workspace_context(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WorkspaceContext:
    requested = request.headers.get("x-workspace-id")
    if requested:
        workspace = db.get(Workspace, requested)
        if not workspace:
            raise NotFoundError("Workspace not found")
        member = db.scalar(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace.id,
                WorkspaceMember.user_id == user.id,
            )
        )
        if member:
            return WorkspaceContext(workspace=workspace, role=member.role, user=user)
        if user.role == "admin":
            return WorkspaceContext(workspace=workspace, role="admin", user=user)
        raise ForbiddenError("You are not a member of this workspace.")

    membership = db.scalar(
        select(WorkspaceMember).where(WorkspaceMember.user_id == user.id).order_by(WorkspaceMember.created_at)
    )
    if membership:
        workspace = db.get(Workspace, membership.workspace_id)
        if workspace:
            return WorkspaceContext(workspace=workspace, role=membership.role, user=user)
    if user.role == "admin":
        workspace = db.scalar(select(Workspace).order_by(Workspace.created_at))
        if workspace:
            return WorkspaceContext(workspace=workspace, role="admin", user=user)
    workspace = db.scalar(select(Workspace).order_by(Workspace.created_at))
    if not workspace:
        raise ForbiddenError("No workspace is available. Contact an administrator.")
    raise ForbiddenError("You are not a member of any workspace.")


def require_workspace_admin(
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> WorkspaceContext:
    if not ctx.is_admin:
        raise ForbiddenError("Workspace administrator privileges are required.")
    return ctx


def require_system_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise ForbiddenError("System administrator privileges are required.")
    return user


@dataclass
class ProjectContext:
    project: Project
    workspace_ctx: WorkspaceContext
    member_role: str

    @property
    def is_admin(self) -> bool:
        return self.workspace_ctx.is_admin


def project_context_for_user(db: Session, user: User, project_id: str) -> ProjectContext:
    project = db.get(Project, project_id)
    if not project:
        raise NotFoundError("Project not found")
    workspace = db.get(Workspace, project.workspace_id)
    if not workspace:
        raise NotFoundError("Project workspace not found")
    if user.role == "admin":
        return ProjectContext(
            project=project,
            workspace_ctx=WorkspaceContext(workspace=workspace, role="admin", user=user),
            member_role="admin",
        )
    member = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace.id,
            WorkspaceMember.user_id == user.id,
        )
    )
    if not member:
        # Do not disclose existence of projects in other workspaces.
        raise NotFoundError("Project not found")
    return ProjectContext(
        project=project,
        workspace_ctx=WorkspaceContext(workspace=workspace, role=member.role, user=user),
        member_role=member.role,
    )


def get_project_context(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectContext:
    return project_context_for_user(db, user, project_id)


def ensure_project_admin(ctx: ProjectContext) -> None:
    if not ctx.is_admin:
        raise ForbiddenError("Project administrator privileges are required.")
