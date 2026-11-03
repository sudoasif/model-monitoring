from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import WorkspaceContext, get_current_user, get_workspace_context, require_workspace_admin
from app.errors import AppError, ConflictError, NotFoundError, UnauthorizedError, ValidationAppError
from app.models import RefreshToken, User, Workspace, WorkspaceMember
from app.schemas import (
    LoginRequest,
    MemberCreate,
    MemberOut,
    MemberRoleUpdate,
    Message,
    PasswordChangeRequest,
    RegisterRequest,
    RoleUpdateRequest,
    TokenResponse,
    UserOut,
    WorkspaceOut,
    WorkspaceUpdate,
)
from app.security import (
    access_cookie_kwargs,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    refresh_cookie_kwargs,
    revoke_refresh_token,
    validate_refresh_token,
    verify_password,
)
from app.services.audit import record_audit
from app.services.rate_limit import limiter
from app.utils import client_ip, slugify, utcnow

router = APIRouter(prefix="/auth", tags=["auth"])
workspace_router = APIRouter(prefix="/workspaces", tags=["workspaces"])
admin_router = APIRouter(prefix="/admin", tags=["admin"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    response.set_cookie(value=access_token, **access_cookie_kwargs())
    response.set_cookie(value=refresh_token, **refresh_cookie_kwargs())


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(settings.access_cookie_name, path="/")
    response.delete_cookie(settings.refresh_cookie_name, path="/")


def _token_response(user: User, response: Response) -> TokenResponse:
    access_token, expires_in = create_access_token(user)
    # Refresh tokens are persisted by the caller.
    return TokenResponse(
        access_token=access_token,
        expires_in=expires_in,
        user=UserOut.model_validate(user),
    )


def _normalise_email(email: str) -> str:
    value = email.strip().lower()
    if not EMAIL_RE.match(value):
        raise ValidationAppError("Enter a valid email address.")
    return value


def _unique_workspace_slug(db: Session, name: str) -> str:
    base = slugify(name) or "workspace"
    candidate = base
    counter = 1
    while db.scalar(select(Workspace.id).where(Workspace.slug == candidate)):
        counter += 1
        candidate = f"{base}-{counter}"
    return candidate


@router.post("/register", response_model=TokenResponse, status_code=201)
def register(payload: RegisterRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> TokenResponse:
    limiter.hit(f"auth:register:{client_ip(request)}", settings.rate_limit_auth_per_minute)
    email = _normalise_email(payload.email)
    if db.scalar(select(User.id).where(func.lower(User.email) == email)):
        raise ConflictError("An account with that email already exists.")
    is_first_user = int(db.scalar(select(func.count(User.id))) or 0) == 0
    user = User(
        email=email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name.strip(),
        role="admin" if is_first_user else "user",
        last_login_at=utcnow(),
    )
    db.add(user)
    db.flush()
    workspace_name = (payload.workspace_name or f"{user.full_name.split()[0]}'s Workspace").strip()
    workspace = Workspace(
        name=workspace_name[:120],
        slug=_unique_workspace_slug(db, workspace_name),
        created_by=user.id,
        settings_json={},
    )
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    db.commit()
    db.refresh(user)
    refresh_token = create_refresh_token(db, user)
    result = _token_response(user, response)
    _set_auth_cookies(response, result.access_token, refresh_token)
    return result


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> TokenResponse:
    limiter.hit(f"auth:login:{client_ip(request)}", settings.rate_limit_auth_per_minute)
    email = payload.email.strip().lower()
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if not user or not verify_password(payload.password, user.hashed_password):
        raise UnauthorizedError("Incorrect email or password.")
    if not user.is_active:
        raise UnauthorizedError("This account has been deactivated.")
    user.last_login_at = utcnow()
    db.commit()
    refresh_token = create_refresh_token(db, user)
    result = _token_response(user, response)
    _set_auth_cookies(response, result.access_token, refresh_token)
    return result


@router.post("/refresh", response_model=TokenResponse)
def refresh(request: Request, response: Response, db: Session = Depends(get_db)) -> TokenResponse:
    token = request.cookies.get(settings.refresh_cookie_name)
    if not token:
        raise UnauthorizedError("No refresh token was supplied.")
    payload = decode_token(token, "refresh")
    jti = payload.get("jti") or ""
    record, user = validate_refresh_token(db, token, jti)
    record.revoked_at = utcnow()
    db.commit()
    refresh_token = create_refresh_token(db, user)
    result = _token_response(user, response)
    _set_auth_cookies(response, result.access_token, refresh_token)
    return result


@router.post("/logout", response_model=Message)
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> Message:
    token = request.cookies.get(settings.refresh_cookie_name)
    if token:
        try:
            payload = decode_token(token, "refresh")
            revoke_refresh_token(db, payload.get("jti") or "")
        except AppError:
            pass
    _clear_auth_cookies(response)
    return Message(message="Signed out.")


@router.get("/me")
def me(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    memberships = db.execute(
        select(WorkspaceMember, Workspace)
        .join(Workspace, Workspace.id == WorkspaceMember.workspace_id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.created_at)
    ).all()
    workspaces = [
        WorkspaceOut(
            id=workspace.id,
            name=workspace.name,
            slug=workspace.slug,
            role=member.role,
            settings=workspace.settings_json or {},
        ).model_dump()
        for member, workspace in memberships
    ]
    return {"user": UserOut.model_validate(user).model_dump(), "workspaces": workspaces}


@router.post("/change-password", response_model=Message)
def change_password(
    payload: PasswordChangeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Message:
    if not verify_password(payload.current_password, user.hashed_password):
        raise ValidationAppError("The current password is incorrect.")
    if len(payload.new_password) < 10 or not any(c.isalpha() for c in payload.new_password) or not any(
        c.isdigit() for c in payload.new_password
    ):
        raise ValidationAppError("The new password must be at least 10 characters and include a letter and a number.")
    user.hashed_password = hash_password(payload.new_password)
    now = utcnow()
    for record in db.scalars(select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))):
        record.revoked_at = now
    db.commit()
    return Message(message="Password changed. Other sessions have been signed out.")


@workspace_router.get("", response_model=list[WorkspaceOut])
def list_workspaces(ctx: WorkspaceContext = Depends(get_workspace_context), db: Session = Depends(get_db)) -> list[WorkspaceOut]:
    memberships = db.execute(
        select(WorkspaceMember, Workspace)
        .join(Workspace, Workspace.id == WorkspaceMember.workspace_id)
        .where(WorkspaceMember.user_id == ctx.user.id)
        .order_by(Workspace.created_at)
    ).all()
    return [
        WorkspaceOut(
            id=workspace.id,
            name=workspace.name,
            slug=workspace.slug,
            role=member.role,
            settings=workspace.settings_json or {},
        )
        for member, workspace in memberships
    ]


@workspace_router.post("", response_model=WorkspaceOut, status_code=201)
def create_workspace(
    payload: WorkspaceUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WorkspaceOut:
    if not payload.name:
        raise ValidationAppError("A workspace name is required.")
    workspace = Workspace(
        name=payload.name.strip(),
        slug=_unique_workspace_slug(db, payload.name),
        created_by=user.id,
        settings_json=payload.settings or {},
    )
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    db.commit()
    return WorkspaceOut(
        id=workspace.id, name=workspace.name, slug=workspace.slug, role="owner", settings=workspace.settings_json or {}
    )


@workspace_router.patch("/current", response_model=WorkspaceOut)
def update_current_workspace(
    payload: WorkspaceUpdate,
    ctx: WorkspaceContext = Depends(require_workspace_admin),
    db: Session = Depends(get_db),
) -> WorkspaceOut:
    workspace = ctx.workspace
    if payload.name is not None:
        workspace.name = payload.name.strip()
    if payload.settings is not None:
        workspace.settings_json = payload.settings
    db.commit()
    return WorkspaceOut(
        id=workspace.id,
        name=workspace.name,
        slug=workspace.slug,
        role=ctx.role,
        settings=workspace.settings_json or {},
    )


@workspace_router.get("/current/members", response_model=list[MemberOut])
def list_members(ctx: WorkspaceContext = Depends(get_workspace_context), db: Session = Depends(get_db)) -> list[MemberOut]:
    rows = db.execute(
        select(WorkspaceMember, User)
        .join(User, User.id == WorkspaceMember.user_id)
        .where(WorkspaceMember.workspace_id == ctx.workspace.id)
        .order_by(WorkspaceMember.created_at)
    ).all()
    return [
        MemberOut(
            user_id=user.id,
            email=user.email,
            full_name=user.full_name,
            role=member.role,
            system_role=user.role,
            created_at=member.created_at,
        )
        for member, user in rows
    ]


@workspace_router.post("/current/members", response_model=MemberOut, status_code=201)
def add_member(
    payload: MemberCreate,
    request: Request,
    ctx: WorkspaceContext = Depends(require_workspace_admin),
    db: Session = Depends(get_db),
) -> MemberOut:
    email = _normalise_email(payload.email)
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if not user:
        raise NotFoundError("No account exists for that email. The user must register first.")
    existing = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == ctx.workspace.id,
            WorkspaceMember.user_id == user.id,
        )
    )
    if existing:
        raise ConflictError("That user is already a member of this workspace.")
    member = WorkspaceMember(workspace_id=ctx.workspace.id, user_id=user.id, role=payload.role)
    db.add(member)
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=ctx.user,
        action="workspace.member_added",
        entity_type="workspace_member",
        entity_id=user.id,
        details={"email": user.email, "role": payload.role},
        request=request,
    )
    db.commit()
    db.refresh(member)
    return MemberOut(
        user_id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=member.role,
        system_role=user.role,
        created_at=member.created_at,
    )


@workspace_router.patch("/current/members/{user_id}", response_model=MemberOut)
def update_member_role(
    user_id: str,
    payload: MemberRoleUpdate,
    request: Request,
    ctx: WorkspaceContext = Depends(require_workspace_admin),
    db: Session = Depends(get_db),
) -> MemberOut:
    member = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == ctx.workspace.id, WorkspaceMember.user_id == user_id
        )
    )
    if not member:
        raise NotFoundError("Workspace member not found")
    if member.user_id == ctx.user.id and payload.role != "owner":
        raise ValidationAppError("You cannot remove your own owner role.")
    if payload.role != "owner" and member.role == "owner":
        owners = int(
            db.scalar(
                select(func.count(WorkspaceMember.id)).where(
                    WorkspaceMember.workspace_id == ctx.workspace.id, WorkspaceMember.role == "owner"
                )
            )
            or 0
        )
        if owners <= 1:
            raise ValidationAppError("Every workspace needs at least one owner.")
    previous_role = member.role
    member.role = payload.role
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=ctx.user,
        action="workspace.member_role_updated",
        entity_type="workspace_member",
        entity_id=member.user_id,
        details={"previous_role": previous_role, "role": payload.role},
        request=request,
    )
    db.commit()
    user = db.get(User, user_id)
    assert user is not None
    return MemberOut(
        user_id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=member.role,
        system_role=user.role,
        created_at=member.created_at,
    )


@workspace_router.delete("/current/members/{user_id}", status_code=204)
def remove_member(
    user_id: str,
    request: Request,
    ctx: WorkspaceContext = Depends(require_workspace_admin),
    db: Session = Depends(get_db),
) -> None:
    member = db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == ctx.workspace.id, WorkspaceMember.user_id == user_id
        )
    )
    if not member:
        raise NotFoundError("Workspace member not found")
    if member.user_id == ctx.user.id:
        raise ValidationAppError("You cannot remove yourself from the workspace.")
    if member.role == "owner":
        owners = int(
            db.scalar(
                select(func.count(WorkspaceMember.id)).where(
                    WorkspaceMember.workspace_id == ctx.workspace.id, WorkspaceMember.role == "owner"
                )
            )
            or 0
        )
        if owners <= 1:
            raise ValidationAppError("Every workspace needs at least one owner.")
    record_audit(
        db,
        workspace_id=ctx.workspace.id,
        actor=ctx.user,
        action="workspace.member_removed",
        entity_type="workspace_member",
        entity_id=member.user_id,
        details={"role": member.role},
        request=request,
    )
    db.delete(member)
    db.commit()


@admin_router.get("/users", response_model=list[UserOut])
def admin_list_users(ctx: WorkspaceContext = Depends(require_workspace_admin), db: Session = Depends(get_db)) -> list[UserOut]:
    # Workspace admins may see users in the system to manage membership; system
    # admins can change roles through the endpoint below.
    users = db.scalars(select(User).order_by(User.created_at)).all()
    return [UserOut.model_validate(user) for user in users]


@admin_router.patch("/users/{user_id}/role", response_model=UserOut)
def admin_update_role(
    user_id: str,
    payload: RoleUpdateRequest,
    ctx: WorkspaceContext = Depends(require_workspace_admin),
    db: Session = Depends(get_db),
) -> UserOut:
    if ctx.user.role != "admin":
        raise AppError(403, "forbidden", "System administrator privileges are required to change user roles.")
    user = db.get(User, user_id)
    if not user:
        raise NotFoundError("User not found")
    if user.id == ctx.user.id and payload.role != "admin":
        raise ValidationAppError("You cannot demote your own system administrator account.")
    user.role = payload.role
    db.commit()
    return UserOut.model_validate(user)
