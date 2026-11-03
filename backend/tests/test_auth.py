from __future__ import annotations

import pytest

from app.config import settings
from tests.conftest import Account


def test_first_registration_creates_system_admin_and_owner(client) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": "First.User@Example.com",
            "password": "StrongPassword1",
            "full_name": "First User",
            "workspace_name": "First Workspace",
        },
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["token_type"] == "bearer"
    assert payload["expires_in"] > 0
    assert payload["user"]["role"] == "admin"
    assert payload["user"]["email"] == "first.user@example.com"
    assert "hashed_password" not in payload["user"]

    me = client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {payload['access_token']}"}
    )
    assert me.status_code == 200
    workspaces = me.json()["workspaces"]
    assert len(workspaces) == 1
    assert workspaces[0]["role"] == "owner"
    assert workspaces[0]["name"] == "First Workspace"


def test_subsequent_registrations_are_regular_users(client, admin: Account) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": "second@example.com",
            "password": "StrongPassword1",
            "full_name": "Second User",
        },
    )
    assert response.status_code == 201
    assert response.json()["user"]["role"] == "user"
    me = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {response.json()['access_token']}"},
    ).json()
    assert len(me["workspaces"]) == 1
    assert me["workspaces"][0]["role"] == "owner"
    assert me["workspaces"][0]["id"] != admin.workspace_id


def test_registration_rejects_duplicate_email_case_insensitively(client, admin: Account) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": "ADMIN@example.com",
            "password": "StrongPassword1",
            "full_name": "Impostor",
        },
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "not-an-email", "password": "StrongPassword1", "full_name": "Bad Email"},
        {"email": "weak@example.com", "password": "short", "full_name": "Weak Password"},
        {"email": "letters@example.com", "password": "onlyletterslong", "full_name": "Weak Password"},
        {"email": "valid@example.com", "password": "StrongPassword1", "full_name": "X"},
    ],
)
def test_registration_validates_input(client, payload: dict) -> None:
    response = client.post("/api/auth/register", json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_login_me_and_invalid_credentials(client, admin: Account) -> None:
    wrong = client.post(
        "/api/auth/login", json={"email": admin.email, "password": "WrongPassword1"}
    )
    assert wrong.status_code == 401

    login = client.post(
        "/api/auth/login", json={"email": admin.email, "password": admin.password}
    )
    assert login.status_code == 200
    token = login.json()["access_token"]

    # Login also sets the HttpOnly access cookie, so clear cookies to prove the
    # endpoint rejects requests that carry no credential at all.
    client.cookies.clear()
    unauthenticated = client.get("/api/auth/me")
    assert unauthenticated.status_code == 401
    assert unauthenticated.headers["www-authenticate"] == "Bearer"

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["user"]["email"] == admin.email


def test_refresh_rotates_and_revokes_tokens(client, admin: Account) -> None:
    first_refresh = client.cookies.get(settings.refresh_cookie_name)
    assert first_refresh

    refreshed = client.post("/api/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    rotated = client.cookies.get(settings.refresh_cookie_name)
    assert rotated and rotated != first_refresh

    # Replaying the old refresh token must fail after rotation.
    replay = client.post(
        "/api/auth/refresh", cookies={settings.refresh_cookie_name: first_refresh}
    )
    assert replay.status_code == 401
    assert "revoked" in replay.json()["error"]["message"].lower()


def test_refresh_rejects_access_token_as_refresh_token(client, admin: Account) -> None:
    response = client.post(
        "/api/auth/refresh",
        cookies={settings.refresh_cookie_name: admin.access_token},
    )
    assert response.status_code == 401
    assert "type" in response.json()["error"]["message"].lower()


def test_logout_revokes_refresh_token(client, admin: Account) -> None:
    refresh_cookie = client.cookies.get(settings.refresh_cookie_name)
    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    replay = client.post(
        "/api/auth/refresh", cookies={settings.refresh_cookie_name: refresh_cookie}
    )
    assert replay.status_code == 401


def test_change_password_revokes_sessions(client, admin: Account) -> None:
    old_refresh = client.cookies.get(settings.refresh_cookie_name)
    change = client.post(
        "/api/auth/change-password",
        headers=admin.headers,
        json={"current_password": admin.password, "new_password": "NewStrongPassword2"},
    )
    assert change.status_code == 200, change.text

    assert (
        client.post(
            "/api/auth/login", json={"email": admin.email, "password": admin.password}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/login",
            json={"email": admin.email, "password": "NewStrongPassword2"},
        ).status_code
        == 200
    )
    replay = client.post(
        "/api/auth/refresh", cookies={settings.refresh_cookie_name: old_refresh}
    )
    assert replay.status_code == 401


def test_change_password_requires_current_password(client, admin: Account) -> None:
    response = client.post(
        "/api/auth/change-password",
        headers=admin.headers,
        json={"current_password": "WrongPassword1", "new_password": "NewStrongPassword2"},
    )
    assert response.status_code == 422
    assert "current password" in response.json()["error"]["message"].lower()


def test_workspace_membership_management_and_rbac(
    client, admin: Account, member: Account
) -> None:
    # Members cannot perform administrative workspace actions.
    assert (
        client.patch(
            "/api/workspaces/current", headers=member.headers, json={"name": "Hijacked"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/workspaces/current/members",
            headers=member.headers,
            json={"email": "nobody@example.com"},
        ).status_code
        == 403
    )
    assert (
        client.get("/api/audit-events", headers=member.headers).status_code == 403
    )

    members = client.get("/api/workspaces/current/members", headers=admin.headers)
    assert members.status_code == 200
    emails = {entry["email"] for entry in members.json()}
    assert emails == {admin.email, member.email}

    # A member can still create ordinary resources in the workspace.
    project = client.post(
        "/api/projects",
        headers=member.headers,
        json={
            "name": "Member Project",
            "task_type": "classification",
            "target_column": "target",
        },
    )
    assert project.status_code == 201

    # Role promotion makes the member a workspace administrator.
    promoted = client.patch(
        f"/api/workspaces/current/members/{member.id}",
        headers=admin.headers,
        json={"role": "admin"},
    )
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "admin"
    assert (
        client.patch(
            "/api/workspaces/current", headers=member.headers, json={"name": "Renamed Workspace"}
        ).status_code
        == 200
    )

    # Remove the member and confirm access to the workspace is gone.
    removed = client.delete(
        f"/api/workspaces/current/members/{member.id}", headers=admin.headers
    )
    assert removed.status_code == 204
    assert (
        client.get("/api/projects", headers=member.headers).status_code == 403
    )


def test_member_management_error_conditions(client, admin: Account, member: Account) -> None:
    unknown = client.post(
        "/api/workspaces/current/members",
        headers=admin.headers,
        json={"email": "missing@example.com"},
    )
    assert unknown.status_code == 404

    duplicate = client.post(
        "/api/workspaces/current/members",
        headers=admin.headers,
        json={"email": member.email},
    )
    assert duplicate.status_code == 409

    self_demote = client.patch(
        f"/api/workspaces/current/members/{admin.id}",
        headers=admin.headers,
        json={"role": "member"},
    )
    assert self_demote.status_code == 422
    assert "owner role" in self_demote.json()["error"]["message"].lower()

    self_remove = client.delete(
        f"/api/workspaces/current/members/{admin.id}", headers=admin.headers
    )
    assert self_remove.status_code == 422

    missing_remove = client.delete(
        "/api/workspaces/current/members/not-a-user", headers=admin.headers
    )
    assert missing_remove.status_code == 404


def test_cross_workspace_access_is_hidden(client, admin: Account, classification_project: dict, account_factory) -> None:
    outsider = account_factory(
        email="outsider@example.com", full_name="Olive Outsider", workspace_name="Other Workspace"
    )
    response = client.get(
        f"/api/projects/{classification_project['id']}", headers=outsider.headers
    )
    # 404 rather than 403 prevents workspace/project enumeration.
    assert response.status_code == 404
    assert (
        client.get("/api/projects", headers=outsider.headers).json()["total"] == 0
    )


def test_system_role_management_is_system_admin_only(
    client, admin: Account, member: Account
) -> None:
    forbidden = client.patch(
        f"/api/admin/users/{member.id}/role",
        headers=member.headers,
        json={"role": "admin"},
    )
    assert forbidden.status_code == 403

    promoted = client.patch(
        f"/api/admin/users/{member.id}/role",
        headers=admin.headers,
        json={"role": "admin"},
    )
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "admin"

    self_demote = client.patch(
        f"/api/admin/users/{admin.id}/role",
        headers=admin.headers,
        json={"role": "user"},
    )
    assert self_demote.status_code == 422


def test_member_additions_are_audited(client, admin: Account, member: Account) -> None:
    audit = client.get("/api/audit-events?action=workspace.member_added", headers=admin.headers)
    assert audit.status_code == 200
    payload = audit.json()
    assert payload["total"] == 1
    event = payload["items"][0]
    assert event["action"] == "workspace.member_added"
    assert event["details"]["email"] == member.email
    assert event["actor_name"] == admin.user["full_name"]
