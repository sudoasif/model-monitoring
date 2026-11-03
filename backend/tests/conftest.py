"""Test configuration and fixtures.

Environment variables are set *before* importing the application so the test
suite never touches a developer's local database, MLflow store, or artifacts.
"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

TEST_ROOT = Path(tempfile.mkdtemp(prefix="aperture-mlops-tests-"))
(TEST_ROOT / "data").mkdir(parents=True, exist_ok=True)
(TEST_ROOT / "artifacts").mkdir(parents=True, exist_ok=True)

os.environ.update(
    {
        "ENVIRONMENT": "test",
        "DEBUG": "false",
        "SECRET_KEY": "test-only-secret-key-0123456789abcdef",
        "DATA_DIR": str(TEST_ROOT / "data"),
        "DATABASE_URL": f"sqlite:///{(TEST_ROOT / 'test.db').as_posix()}",
        "MLFLOW_ENABLED": "true",
        "MLFLOW_TRACKING_URI": f"sqlite:///{(TEST_ROOT / 'mlflow.db').as_posix()}",
        "MLFLOW_ARTIFACT_ROOT": (TEST_ROOT / "mlflow-artifacts").as_uri(),
        "ARTIFACT_DIR": str(TEST_ROOT / "artifacts"),
        "JOB_RUNNER": "sync",
        "AUTO_CREATE_TABLES": "true",
        "RATE_LIMIT_AUTH_PER_MINUTE": "100000",
        "RATE_LIMIT_API_PER_MINUTE": "100000",
        "RATE_LIMIT_PREDICT_PER_MINUTE": "100000",
        "CAPTURE_MONITORING_SAMPLES": "true",
        "MONITORING_SAMPLE_RATE": "1.0",
        "DEMO_MODE": "true",
        "MLFLOW_DISABLE_AGENT_HINT": "1",
    }
)

from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.services.rate_limit import limiter  # noqa: E402

DEFAULT_PASSWORD = "TestPassword123"


@dataclass
class Account:
    user: dict[str, Any]
    workspace: dict[str, Any]
    access_token: str
    password: str = DEFAULT_PASSWORD
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.user["id"]

    @property
    def email(self) -> str:
        return self.user["email"]

    @property
    def workspace_id(self) -> str:
        return self.workspace["id"]


@pytest.fixture(scope="session")
def client() -> TestClient:
    # The context manager is required for lifespan startup (table creation and
    # Prometheus gauge initialization).
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def clean_state(client: TestClient) -> Any:
    """Every test starts with an empty application database and fresh cookies."""
    client.cookies.clear()
    limiter.reset()
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def account_factory(client: TestClient):
    def _create(
        email: str = "admin@example.com",
        full_name: str = "Ada Admin",
        workspace_name: str = "Aperture Test",
        password: str = DEFAULT_PASSWORD,
    ) -> Account:
        response = client.post(
            "/api/auth/register",
            json={
                "email": email,
                "password": password,
                "full_name": full_name,
                "workspace_name": workspace_name,
            },
        )
        assert response.status_code == 201, response.text
        payload = response.json()
        headers = {"Authorization": f"Bearer {payload['access_token']}"}
        me = client.get("/api/auth/me", headers=headers)
        assert me.status_code == 200, me.text
        workspace = me.json()["workspaces"][0]
        headers["X-Workspace-Id"] = workspace["id"]
        return Account(
            user=payload["user"],
            workspace=workspace,
            access_token=payload["access_token"],
            password=password,
            headers=headers,
        )

    return _create


@pytest.fixture
def admin(account_factory) -> Account:
    return account_factory(email="admin@example.com", full_name="Ada Admin", workspace_name="Acme MLOps")


@pytest.fixture
def member(client: TestClient, admin: Account, account_factory) -> Account:
    account = account_factory(
        email="member@example.com",
        full_name="Mia Member",
        workspace_name="Mia Personal",
    )
    response = client.post(
        "/api/workspaces/current/members",
        headers=admin.headers,
        json={"email": account.email, "role": "member"},
    )
    assert response.status_code == 201, response.text
    account.headers = {**account.headers, "X-Workspace-Id": admin.workspace_id}
    return account


@pytest.fixture
def classification_project(client: TestClient, admin: Account) -> dict[str, Any]:
    response = client.post(
        "/api/projects",
        headers=admin.headers,
        json={
            "name": "Customer Churn",
            "description": "Synthetic churn prediction for the test suite.",
            "task_type": "classification",
            "target_column": "is_churned",
            "positive_label": "1",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def regression_project(client: TestClient, admin: Account) -> dict[str, Any]:
    response = client.post(
        "/api/projects",
        headers=admin.headers,
        json={
            "name": "House Prices",
            "description": "Synthetic property valuation for the test suite.",
            "task_type": "regression",
            "target_column": "price",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_sample_version(
    client: TestClient,
    account: Account,
    project_id: str,
    sample_key: str = "churn-classification",
    shifted: bool = False,
    is_reference: bool = False,
) -> dict[str, Any]:
    response = client.post(
        f"/api/projects/{project_id}/datasets/sample",
        headers=account.headers,
        json={
            "sample_key": sample_key,
            "shifted": shifted,
            "is_reference": is_reference,
            "name": "Customer Churn" if not shifted else "Customer Churn (shifted)",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def upload_csv(
    client: TestClient,
    account: Account,
    project_id: str,
    content: bytes,
    filename: str = "data.csv",
    content_type: str = "text/csv",
    name: str = "Uploaded",
    is_reference: bool = False,
) -> Any:
    return client.post(
        f"/api/projects/{project_id}/datasets/upload",
        headers=account.headers,
        files={"file": (filename, content, content_type)},
        data={"name": name, "is_reference": "true" if is_reference else "false"},
    )
