from __future__ import annotations

import pandas as pd
import pytest

from app.config import settings
from app.errors import ValidationAppError
from app.services.datasets import (
    build_profile,
    feature_columns_for_training,
    parse_and_validate_csv,
    sample_dataframe,
)
from tests.conftest import Account, create_sample_version, upload_csv


def _classification_csv(rows: int = 80, target: str = "label") -> bytes:
    frame = pd.DataFrame(
        {
            "age": list(range(20, 20 + rows)),
            "city": ["north", "south", "east", "west"] * (rows // 4) + ["north"] * (rows % 4),
            target: [index % 2 for index in range(rows)],
        }
    )
    return frame.to_csv(index=False).encode("utf-8")


def test_parse_valid_classification_csv_builds_profile() -> None:
    frame, profile = parse_and_validate_csv(
        _classification_csv(), task_type="classification", target_column="label"
    )
    assert len(frame) == 80
    assert profile["row_count"] == 80
    assert profile["column_count"] == 3
    roles = {column["name"]: column["role"] for column in profile["columns"]}
    assert roles["label"] == "target"
    assert roles["age"] == "feature"
    assert profile["target"]["task_type"] == "classification"
    assert profile["target"]["unique_count"] == 2


@pytest.mark.parametrize(
    ("content", "task_type", "target", "message"),
    [
        (b"", "classification", "label", "empty"),
        (b"a,b\n1,2\n", "classification", "label", "was not found"),
        (
            b"feature,label\n1,0\n2,0\n3,0\n4,0\n5,0\n6,0\n7,0\n8,0\n9,0\n10,0\n",
            "classification",
            "label",
            "at least two distinct values",
        ),
        (
            b"feature,label\n1,0\n2,1\n",
            "classification",
            "label",
            "At least 10 labelled rows",
        ),
    ],
)
def test_parse_rejects_invalid_datasets(content: bytes, task_type: str, target: str, message: str) -> None:
    with pytest.raises(ValidationAppError) as exc_info:
        parse_and_validate_csv(content, task_type=task_type, target_column=target)
    assert message.lower() in str(exc_info.value).lower()


def test_parse_rejects_duplicate_and_empty_headers() -> None:
    with pytest.raises(ValidationAppError, match="Duplicate column names"):
        parse_and_validate_csv(b"a,a,label\n1,2,0\n", task_type="classification", target_column="label")
    with pytest.raises(ValidationAppError, match="non-empty header"):
        parse_and_validate_csv(b",,\n1,2,3\n", task_type="classification", target_column="label")


def test_parse_rejects_binary_content() -> None:
    with pytest.raises(ValidationAppError, match="binary content"):
        parse_and_validate_csv(
            b"a,label\n\x00,0\n", task_type="classification", target_column="label"
        )


def test_parse_enforces_row_limit() -> None:
    with pytest.raises(ValidationAppError, match="row limit"):
        parse_and_validate_csv(
            _classification_csv(), task_type="classification", target_column="label", row_limit=10
        )


def test_regression_target_must_be_numeric() -> None:
    content = b"feature,price\n" + b"".join(
        f"{index},{'high' if index % 2 else 'low'}\n".encode() for index in range(20)
    )
    with pytest.raises(ValidationAppError, match="must be numeric"):
        parse_and_validate_csv(content, task_type="regression", target_column="price")


def test_feature_selection_excludes_pii_identifiers_and_constants() -> None:
    frame = pd.DataFrame(
        {
            "customer_email": [f"user{index}@example.com" for index in range(100)],
            "customer_id": [f"ID-{index}" for index in range(100)],
            "constant": [1] * 100,
            "age": list(range(100)),
            "segment": ["a", "b"] * 50,
            "target": [index % 2 for index in range(100)],
        }
    )
    selected, excluded = feature_columns_for_training(frame, "target")
    assert selected == ["age", "segment"]
    assert "customer_email" in excluded
    assert "customer_id" in excluded
    assert "constant" in excluded
    assert "target" not in selected


def test_profile_marks_pii_and_warns() -> None:
    frame = pd.DataFrame(
        {
            "customer_email": [f"user{index}@example.com" for index in range(20)],
            "value": [1] * 20,
            "target": [index % 2 for index in range(20)],
        }
    )
    profile = build_profile(frame, "target", "classification")
    assert profile["quality"]["pii_columns"] == ["customer_email"]
    assert "customer_email" in profile["quality"]["high_cardinality_columns"]
    assert profile["quality"]["warnings"]


def test_sample_datasets_are_real_and_shifted() -> None:
    baseline = sample_dataframe("churn-classification")
    shifted = sample_dataframe("churn-classification", shifted=True)
    assert len(baseline) == 1500
    assert len(shifted) == 1500
    assert shifted["monthly_charges"].mean() > baseline["monthly_charges"].mean()
    assert shifted["monthly_charges"].isna().sum() > 0
    prices = sample_dataframe("house-regression")
    assert prices["price"].min() > 0


def test_upload_rejects_wrong_extension_and_content_type(
    client, admin: Account, classification_project: dict
) -> None:
    project_id = classification_project["id"]
    wrong_extension = upload_csv(
        client, admin, project_id, _classification_csv(), filename="data.txt"
    )
    assert wrong_extension.status_code == 422
    assert ".csv" in wrong_extension.json()["error"]["message"]

    wrong_type = upload_csv(
        client,
        admin,
        project_id,
        _classification_csv(),
        filename="data.csv",
        content_type="application/pdf",
    )
    assert wrong_type.status_code == 422
    assert "unsupported content type" in wrong_type.json()["error"]["message"]


def test_upload_enforces_size_limit(
    client, admin: Account, classification_project: dict, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "max_upload_bytes", 200)
    response = upload_csv(
        client, admin, classification_project["id"], _classification_csv(rows=200)
    )
    assert response.status_code == 422
    assert "upload limit" in response.json()["error"]["message"]


def test_upload_preview_and_metadata(client, admin: Account, classification_project: dict) -> None:
    project_id = classification_project["id"]
    content = _classification_csv(target="is_churned")
    response = upload_csv(
        client, admin, project_id, content, filename="churn.csv", name="Churn CSV", is_reference=True
    )
    assert response.status_code == 201, response.text
    version = response.json()
    assert version["row_count"] == 80
    assert version["column_count"] == 3
    assert version["is_reference"] is True
    assert len(version["content_hash"]) == 64
    assert version["profile"]["target"]["unique_count"] == 2

    listing = client.get(f"/api/projects/{project_id}/datasets", headers=admin.headers)
    assert listing.status_code == 200
    datasets = listing.json()
    assert datasets[0]["name"] == "Churn CSV"
    assert datasets[0]["versions"][0]["id"] == version["id"]

    preview = client.get(f"/api/datasets/{version['id']}/preview?limit=5", headers=admin.headers)
    assert preview.status_code == 200
    payload = preview.json()
    assert payload["returned_rows"] == 5
    assert payload["total_rows"] == 80
    assert payload["columns"] == ["age", "city", "is_churned"]

    download = client.get(f"/api/datasets/{version['id']}/download", headers=admin.headers)
    assert download.status_code == 200
    assert download.content == content


def test_archived_project_rejects_uploads(client, admin: Account, classification_project: dict) -> None:
    project_id = classification_project["id"]
    archived = client.patch(
        f"/api/projects/{project_id}", headers=admin.headers, json={"status": "archived"}
    )
    assert archived.status_code == 200
    response = upload_csv(client, admin, project_id, _classification_csv())
    assert response.status_code == 422
    assert "Archived" in response.json()["error"]["message"]


def test_only_admins_can_delete_dataset_versions(
    client, admin: Account, member: Account, classification_project: dict
) -> None:
    project_id = classification_project["id"]
    version = create_sample_version(client, admin, project_id)
    forbidden = client.delete(f"/api/datasets/{version['id']}", headers=member.headers)
    assert forbidden.status_code == 422
    assert "administrators" in forbidden.json()["error"]["message"]

    deleted = client.delete(f"/api/datasets/{version['id']}", headers=admin.headers)
    assert deleted.status_code == 204
    assert client.get(f"/api/datasets/{version['id']}", headers=admin.headers).status_code == 404
