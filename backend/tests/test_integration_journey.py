"""End-to-end backend journey across the real services.

The test intentionally uses the same HTTP API and synchronous job runner as the
application. It covers the core acceptance path: dataset -> training -> approval
gate -> deployment -> predictions -> monitoring -> labels/performance -> drift
alert -> audited remediation -> retraining comparison.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from app.services.storage import storage
from tests.conftest import Account, create_sample_version


def _ok(response: Any, expected: int = 200) -> dict[str, Any]:
    assert response.status_code == expected, response.text
    return response.json()


def _job(client, account: Account, job_id: str) -> dict[str, Any]:
    return _ok(client.get(f"/api/jobs/{job_id}", headers=account.headers))


def test_full_model_lifecycle(client, admin: Account, classification_project: dict, member: Account) -> None:
    project_id = classification_project["id"]

    # ---------------------------------------------------------------- dataset
    reference = create_sample_version(
        client, admin, project_id, sample_key="churn-classification", is_reference=True
    )
    assert reference["row_count"] == 1500
    assert reference["profile"]["target"]["unique_count"] == 2
    assert reference["is_reference"] is True

    # ---------------------------------------------------------------- training
    train = client.post(
        f"/api/projects/{project_id}/train",
        headers=admin.headers,
        json={
            "dataset_version_id": reference["id"],
            "algorithms": ["logistic_regression"],
            "tune": False,
            "test_size": 0.2,
            "random_state": 7,
            "notes": "Integration journey training run",
        },
    )
    assert train.status_code == 202, train.text
    train_job = _job(client, admin, train.json()["id"])
    assert train_job["status"] == "succeeded", train_job
    assert train_job["progress"] == 100

    runs = _ok(client.get(f"/api/projects/{project_id}/runs", headers=admin.headers))
    assert runs["total"] == 1
    run = runs["items"][0]
    assert run["status"] == "succeeded"
    assert run["mlflow_run_id"], "MLflow tracking must record a run id"
    assert run["git_commit"] is not None
    assert run["duration_seconds"] is not None
    metrics = run["metrics"]
    for metric in ("accuracy", "precision_macro", "recall_macro", "f1_macro", "roc_auc"):
        assert isinstance(metrics.get(metric), (int, float)), (metric, metrics)
    assert metrics["sample_count"] >= 20
    assert len(metrics["class_labels"]) == 2
    assert run["feature_columns"]
    assert "customer_email" not in run["feature_columns"]
    assert "customer_id" not in run["feature_columns"]
    assert run["prediction_distribution"]["kind"] == "classification"

    artifacts = _ok(client.get(f"/api/runs/{run['id']}/artifacts", headers=admin.headers))
    assert artifacts["mlflow_run_id"] == run["mlflow_run_id"]
    artifact_paths = {item["path"] for item in artifacts["artifacts"]}
    assert any(path.endswith("model_bundle.joblib") for path in artifact_paths), artifacts
    assert any(path.endswith("validation.json") for path in artifact_paths), artifacts

    # ----------------------------------------------------------- registry gate
    models = _ok(client.get(f"/api/projects/{project_id}/models", headers=admin.headers))
    assert len(models) == 1
    model = models[0]
    assert model["version_count"] == 1
    version = model["latest_version"]
    assert version["approval_status"] == "pending"
    assert version["validation_status"] == "passed", version["validation"]
    assert version["mlflow_model_version"] is not None
    assert len(version["artifact_hash"]) == 64
    assert version["model_card"]["intended_use"]

    pending_deploy = client.post(
        "/api/deployments",
        headers=admin.headers,
        json={
            "project_id": project_id,
            "model_version_id": version["id"],
            "name": "Churn API",
            "reference_dataset_version_id": reference["id"],
        },
    )
    assert pending_deploy.status_code == 422, pending_deploy.text
    assert "approved" in pending_deploy.json()["error"]["message"].lower()

    # Only admins may approve; the member can read but not promote.
    member_approve = client.post(
        f"/api/versions/{version['id']}/approve",
        headers=member.headers,
        json={"note": "member attempt"},
    )
    assert member_approve.status_code == 422
    approved = _ok(
        client.post(
            f"/api/versions/{version['id']}/approve",
            headers=admin.headers,
            json={"note": "Reviewed validation report and model card.", "promote_to_production": True},
        )
    )
    assert approved["approval_status"] == "approved"
    assert approved["stage"] == "production"
    assert approved["approved_by"] == admin.id

    integrity = _ok(client.get(f"/api/registry/version/{version['id']}/integrity", headers=admin.headers))
    assert integrity["integrity_ok"] is True

    # ------------------------------------------------------------- deployment
    deployment = _ok(
        client.post(
            "/api/deployments",
            headers=admin.headers,
            json={
                "project_id": project_id,
                "model_version_id": version["id"],
                "name": "Churn API",
                "description": "Integration journey deployment",
                "reference_dataset_version_id": reference["id"],
                "min_label_samples": 30,
            },
        ),
        201,
    )
    deployment_id = deployment["id"]
    api_key = deployment["api_key"]
    assert api_key.startswith("mlp_")
    assert deployment["status"] == "active"

    health = _ok(client.get(f"/api/deployments/{deployment_id}/health", headers=admin.headers))
    assert health["status"] == "healthy"
    assert health["artifact_hash"] == version["artifact_hash"]

    # Real traffic must evaluate operational alert rules, not only demo
    # simulation or drift/performance jobs. This rule fires on any served
    # prediction with at least one sample.
    latency_rule = _ok(
        client.post(
            "/api/alert-rules",
            headers=admin.headers,
            json={
                "name": "Traffic latency guard",
                "project_id": project_id,
                "metric_type": "latency_p95",
                "comparison": "gt",
                "threshold": 0,
                "severity": "warning",
                "window_minutes": 30,
                "cooldown_minutes": 60,
                "min_samples": 1,
                "channels": ["in_app"],
            },
        ),
        201,
    )
    assert latency_rule["id"]

    schema = _ok(client.get(f"/api/deployments/{deployment_id}/prediction-schema", headers=admin.headers))
    features = schema["features"]
    assert set(features) == set(run["feature_columns"])
    assert schema["schema"]["class_labels"] == metrics["class_labels"]

    # ------------------------------------------------------------- predictions
    single = _ok(
        client.post(
            f"/api/deployments/{deployment_id}/predict",
            headers={"X-API-Key": api_key},
            json={"features": features, "return_probabilities": True, "request_id": "journey-single-1"},
        )
    )
    assert single["request_id"] == "journey-single-1"
    assert single["prediction"] in metrics["class_labels"]
    assert 0.0 <= single["confidence"] <= 1.0
    assert abs(sum(single["probabilities"].values()) - 1.0) < 1e-6
    assert single["latency_ms"] >= 0

    replay = client.post(
        f"/api/deployments/{deployment_id}/predict",
        headers={"X-API-Key": api_key},
        json={"features": features, "request_id": "journey-single-1"},
    )
    assert replay.status_code == 422
    assert "already been used" in replay.json()["error"]["message"]

    invalid_features = dict(features)
    invalid_features.pop(next(iter(invalid_features)))
    invalid = client.post(
        f"/api/deployments/{deployment_id}/predict",
        headers={"X-API-Key": api_key},
        json={"features": invalid_features},
    )
    assert invalid.status_code == 422
    assert "schema validation" in invalid.json()["error"]["message"].lower()

    batch_records = []
    for index in range(40):
        record = dict(features)
        # Vary numeric features within the observed reference ranges so the
        # captured monitoring sample is not a single constant row.
        record["tenure_months"] = 2 + (index % 60)
        record["monthly_charges"] = 25.0 + (index % 12) * 8.5
        record["support_tickets"] = index % 4
        batch_records.append(record)
    batch = _ok(
        client.post(
            f"/api/deployments/{deployment_id}/predict/batch",
            headers=admin.headers,
            json={"records": batch_records, "return_probabilities": True},
        )
    )
    assert batch["count"] == 40
    assert len(batch["predictions"]) == 40
    assert batch["latency_ms"] >= 0

    client.cookies.clear()
    unauth = client.post(f"/api/deployments/{deployment_id}/predict", json={"features": features})
    assert unauth.status_code == 403

    public = _ok(
        client.post(
            f"/api/predict/{deployment['slug']}",
            headers={"X-API-Key": api_key},
            json={"features": features},
        )
    )
    assert public["deployment_id"] == deployment_id

    # The latency rule is evaluated from real prediction traffic. The batch
    # request supplies enough samples to pass the rule's floor.
    traffic_alerts = _ok(
        client.get("/api/alerts?status=all&type=latency_p95", headers=admin.headers)
    )
    assert traffic_alerts["total"] >= 1
    assert traffic_alerts["items"][0]["rule_id"] == latency_rule["id"]

    # --------------------------------------------------------------- monitoring
    monitoring = _ok(
        client.get(
            f"/api/deployments/{deployment_id}/monitoring?days=7&granularity=hour",
            headers=admin.headers,
        )
    )
    traffic = monitoring["metrics"]
    assert traffic["total_requests"] == 43  # 1 single + 1 public + 40 batch + 1 invalid
    assert traffic["error_count"] == 1
    assert traffic["errors_by_type"][0]["error_type"] == "invalid_input"
    quality = monitoring["data_quality"]
    assert {"status", "sample_count", "window", "features", "schema_changes"} <= set(quality)
    assert {"missing_features", "added_features", "type_changes"} <= set(quality["schema_changes"])
    assert monitoring["metrics"]["prediction_distribution"]["buckets"]
    assert traffic["invalid_input_count"] == 1
    assert traffic["error_rate"] > 0
    assert traffic["latency_ms"]["p50"] is not None
    assert traffic["latency_ms"]["p95"] is not None
    assert traffic["latency_ms"]["p99"] is not None
    assert traffic["prediction_distribution"]
    assert traffic["version_usage"][0]["version"] == version["version"]
    assert monitoring["data_quality"]["sample_count"] > 0
    assert monitoring["recent_predictions"]
    assert monitoring["timeseries"]["points"]

    events = _ok(
        client.get(
            f"/api/deployments/{deployment_id}/predictions?limit=100",
            headers=admin.headers,
        )
    )
    assert events["total"] == 43
    successful = [event for event in events["items"] if event["status"] == "success"]
    assert len(successful) == 42
    assert all(event["request_id"] for event in successful)
    assert all(event["timestamp"] for event in successful)

    overview = _ok(client.get("/api/overview?days=7", headers=admin.headers))
    assert overview["counts"]["projects"] == 1
    assert overview["counts"]["deployments"] == 1
    assert overview["traffic"]["requests"] == 43
    assert overview["traffic"]["production"] == 43
    assert overview["traffic"]["simulated"] == 0

    # ------------------------------------------- labels / performance / concept
    insufficient = _ok(
        client.get(f"/api/deployments/{deployment_id}/performance?days=7", headers=admin.headers)
    )
    assert insufficient["status"] == "insufficient_labels"
    assert insufficient["metrics"] == {}
    assert insufficient["concept_drift"]["status"] == "not_assessed"

    labels = [
        {"prediction_id": event["id"], "label": event["prediction"]}
        for event in successful[:35]
    ]
    labelled = _ok(
        client.post(
            "/api/labels",
            headers=admin.headers,
            json={"deployment_id": deployment_id, "labels": labels, "source": "api"},
        )
    )
    assert labelled["created"] == 35
    assert labelled["errors"] == []
    assert labelled["performance"]["status"] == "ok"
    assert labelled["performance"]["metrics"]["accuracy"] == 1.0
    assert labelled["performance"]["concept_drift"]["status"] in {
        "no_degradation_detected",
        "suspected_not_confirmed",
    }

    label_status = _ok(
        client.get(f"/api/deployments/{deployment_id}/labels/status?days=7", headers=admin.headers)
    )
    assert label_status["status"] == "sufficient"
    assert label_status["label_count"] == 35
    assert label_status["delayed_labels"]["sample_count"] == 35

    evaluated = _ok(
        client.post(
            f"/api/deployments/{deployment_id}/performance/evaluate?days=7",
            headers=admin.headers,
        )
    )
    assert evaluated["status"] == "ok"
    assert evaluated["report_id"]
    reports = _ok(
        client.get(f"/api/deployments/{deployment_id}/performance/reports", headers=admin.headers)
    )
    assert reports["total"] >= 2

    # --------------------------------------------------------------- drift
    shifted = create_sample_version(
        client, admin, project_id, sample_key="churn-classification", shifted=True
    )
    rule = _ok(
        client.post(
            "/api/alert-rules",
            headers=admin.headers,
            json={
                "name": "Journey data drift guard",
                "project_id": project_id,
                "metric_type": "data_drift_share",
                "comparison": "gt",
                "threshold": 0.1,
                "severity": "high",
                "window_minutes": 60,
                "cooldown_minutes": 60,
                "min_samples": 0,
                "channels": ["in_app"],
            },
        ),
        201,
    )
    drift_start = client.post(
        "/api/drift/analyze",
        headers=admin.headers,
        json={
            "project_id": project_id,
            "deployment_id": deployment_id,
            "reference_dataset_version_id": reference["id"],
            "current_dataset_version_id": shifted["id"],
        },
    )
    assert drift_start.status_code == 202, drift_start.text
    drift_job = _job(client, admin, drift_start.json()["id"])
    assert drift_job["status"] == "succeeded", drift_job
    assert drift_job["result"]["report_id"]

    drift_report = _ok(
        client.get(f"/api/drift/reports/{drift_job['result']['report_id']}", headers=admin.headers)
    )
    assert drift_report["status"] == "completed"
    assert drift_report["severity"] in {"medium", "high", "critical"}
    assert drift_report["drift_share"] > 0.1
    assert drift_report["drifted_feature_count"] >= 1
    assert drift_report["reference_sample_size"] == 1500
    assert drift_report["current_sample_size"] == 1500
    assert drift_report["report"]["summary"]["reporting_notes"]["data_drift"]
    assert drift_report["report"]["summary"]["concept_drift"]["status"] in {
        "no_degradation_detected",
        "suspected_not_confirmed",
        "insufficient_labels",
    }
    assert drift_report["features"]
    assert all(feature["method"] for feature in drift_report["features"])
    assert any(feature["drifted"] for feature in drift_report["features"])
    assert any(feature["adjusted_p_value"] is not None for feature in drift_report["features"])

    # --------------------------------------------------------------- alerts
    alerts = _ok(client.get("/api/alerts?status=all", headers=admin.headers))
    assert alerts["total"] >= 1
    alert = next(item for item in alerts["items"] if item["type"] == "data_drift_share")
    assert alert["severity"] == "high"
    assert alert["status"] == "open"
    assert alert["rule_id"] == rule["id"]
    # The shifted fixture is a synthetic demo dataset, so the resulting alert must
    # be explicitly labelled as simulated even though the drift computation is real.
    assert alert["simulated"] is True
    assert alert["details"]["observed"] > 0.1

    ack = _ok(client.post(f"/api/alerts/{alert['id']}/acknowledge", headers=member.headers))
    assert ack["status"] == "acknowledged"
    assert ack["acknowledged_by"] == member.id

    remediation = _ok(
        client.post(
            f"/api/alerts/{alert['id']}/remediation",
            headers=member.headers,
            json={"action": "open_incident", "note": "Investigating shifted contract mix."},
        )
    )
    assert remediation["automatic_change"] is False
    assert remediation["incident"]["status"] == "open"

    forbidden_retrain = client.post(
        f"/api/alerts/{alert['id']}/remediation",
        headers=member.headers,
        json={"action": "schedule_retraining", "note": "member attempt"},
    )
    assert forbidden_retrain.status_code == 403

    rollback_recommendation = _ok(
        client.post(
            f"/api/alerts/{alert['id']}/remediation",
            headers=admin.headers,
            json={"action": "recommend_rollback", "note": "Check prior version."},
        )
    )
    assert rollback_recommendation["action_taken"] == "none"
    current_deployment = _ok(
        client.get(f"/api/deployments/{deployment_id}", headers=admin.headers)
    )
    assert current_deployment["model_version_id"] == version["id"]

    detail = _ok(client.get(f"/api/alerts/{alert['id']}", headers=admin.headers))
    assert detail["incident"]["id"] == remediation["incident"]["id"]
    assert len(detail["remediation_log"]) == 2
    assert all(entry["automatic_change"] is False for entry in detail["remediation_log"])

    resolved = _ok(
        client.post(
            f"/api/alerts/{alert['id']}/resolve",
            headers=admin.headers,
            json={"note": "Rollback evaluated; keeping current model and monitoring."},
        )
    )
    assert resolved["status"] == "resolved"
    assert resolved["resolved_by"] == admin.id
    assert resolved["resolution_note"]

    incidents = _ok(client.get("/api/incidents", headers=admin.headers))
    assert incidents["total"] == 1
    incident_id = incidents["items"][0]["id"]
    mitigated = _ok(
        client.patch(
            f"/api/incidents/{incident_id}",
            headers=admin.headers,
            json={"status": "mitigated", "note": "Traffic inspected; no action required."},
        )
    )
    assert mitigated["status"] == "mitigated"

    # ------------------------------------------------------------- retraining
    retrain = client.post(
        "/api/retrain",
        headers=admin.headers,
        json={
            "project_id": project_id,
            "deployment_id": deployment_id,
            "min_new_labels": 30,
            "tune": False,
            "notes": "Journey retraining after drift review.",
        },
    )
    assert retrain.status_code == 202, retrain.text
    retrain_job = _job(client, admin, retrain.json()["id"])
    assert retrain_job["status"] == "succeeded", retrain_job
    comparison = retrain_job["result"]["comparison"]
    assert comparison["recommendation"] in {
        "promote_candidate",
        "keep_baseline",
        "reject_candidate",
        "needs_review",
    }
    assert comparison["baseline_value"] is not None
    assert comparison["candidate_value"] is not None
    assert retrain_job["result"]["approval_status"] == "pending"

    retraining_status = _ok(
        client.get(f"/api/deployments/{deployment_id}/retraining", headers=admin.headers)
    )
    assert retraining_status["approval_required"] is True
    assert retraining_status["last_comparison"] is not None
    # Labels consumed by the successful retraining are excluded from the "new
    # labels since last run" counter, so the next run correctly needs fresh data.
    assert retraining_status["label_status"] == "insufficient_labels"
    assert retraining_status["label_stats"]["labels_with_features"] == 0

    versions = _ok(client.get(f"/api/models/{model['id']}/versions", headers=admin.headers))
    assert len(versions) == 2
    candidate = next(item for item in versions if item["version"] == 2)
    assert candidate["approval_status"] == "pending"
    assert candidate["training_run_id"] != version["training_run_id"]
    assert candidate["dataset_version_id"] != reference["id"]
    assert candidate["validation_status"] in {"passed", "failed"}

    all_runs = _ok(
        client.get(
            f"/api/projects/{project_id}/runs?limit=100",
            headers=admin.headers,
        )
    )
    assert all_runs["total"] == 2
    candidate_run = next(item for item in all_runs["items"] if item["id"] == candidate["training_run_id"])
    compare = _ok(
        client.post(
            "/api/runs/compare",
            headers=admin.headers,
            json={"run_ids": [run["id"], candidate_run["id"]]},
        )
    )
    assert compare["primary_metric"] == "roc_auc"
    assert compare["higher_is_better"] is True
    assert compare["best_run_id"] in {run["id"], candidate_run["id"]}
    assert compare["baseline_run_id"] == run["id"]
    assert set(compare["comparisons"]) == {run["id"], candidate_run["id"]}
    assert compare["git_commits"][run["id"]] is not None

    # A pending candidate cannot be deployed even if its metrics look better.
    blocked = client.post(
        "/api/deployments",
        headers=admin.headers,
        json={
            "project_id": project_id,
            "model_version_id": candidate["id"],
            "name": "Candidate deployment",
            "reference_dataset_version_id": reference["id"],
        },
    )
    assert blocked.status_code == 422
    assert "approved" in blocked.json()["error"]["message"].lower()

    # ------------------------------------------------ promotion and rollback
    approved_candidate = _ok(
        client.post(
            f"/api/versions/{candidate['id']}/approve",
            headers=admin.headers,
            json={
                "note": "Candidate reviewed against baseline; approved for a controlled rollout.",
                "promote_to_production": True,
            },
        )
    )
    assert approved_candidate["approval_status"] == "approved"
    assert approved_candidate["stage"] == "production"
    baseline_after = _ok(
        client.get(f"/api/versions/{version['id']}", headers=admin.headers)
    )
    assert baseline_after["stage"] == "none"

    rolled_forward = _ok(
        client.post(
            f"/api/deployments/{deployment_id}/rollback?target_version_id={candidate['id']}",
            headers=admin.headers,
        )
    )
    assert rolled_forward["model_version_id"] == candidate["id"]

    rolled_back = _ok(
        client.post(
            f"/api/deployments/{deployment_id}/rollback?target_version_id={version['id']}",
            headers=admin.headers,
        )
    )
    assert rolled_back["model_version_id"] == version["id"]
    assert rolled_back["model_version"] == version["version"]

    # ------------------------------------------------------- artifact integrity
    artifact_path = Path(
        storage.materialize(
            f"artifacts/projects/{project_id}/runs/{run['id']}/model_bundle.joblib"
        )
    )
    original = artifact_path.read_bytes()
    try:
        artifact_path.write_bytes(original + b"tampered")
        tampered = _ok(
            client.get(f"/api/registry/version/{version['id']}/integrity", headers=admin.headers)
        )
        assert tampered["integrity_ok"] is False
        unhealthy = _ok(
            client.get(f"/api/deployments/{deployment_id}/health", headers=admin.headers)
        )
        assert unhealthy["status"] == "unhealthy"
        assert unhealthy["reason"] == "artifact_integrity_failed"
    finally:
        artifact_path.write_bytes(original)
    restored = _ok(
        client.get(f"/api/registry/version/{version['id']}/integrity", headers=admin.headers)
    )
    assert restored["integrity_ok"] is True
    assert restored["actual_hash"] == hashlib.sha256(original).hexdigest()

    # ------------------------------------------------------------ audit trail
    audit = _ok(
        client.get(
            "/api/audit-events?limit=100&entity_type=alert",
            headers=admin.headers,
        )
    )
    actions = {event["action"] for event in audit["items"]}
    assert "alert.created" in actions
    assert "alert.acknowledged" in actions
    assert "alert.resolved" in actions
    assert "alert.remediation.open_incident" in actions
    assert "alert.remediation.recommend_rollback" in actions
