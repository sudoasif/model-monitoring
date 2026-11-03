"""Operational checks: health, readiness, metrics, and alert evaluation policy."""
from __future__ import annotations

from typing import Any

from app.database import SessionLocal
from app.models import Alert, Project
from app.services.alerts import evaluate_rules
from tests.conftest import Account


def _ok(response: Any, expected: int = 200) -> dict[str, Any]:
    assert response.status_code == expected, response.text
    return response.json()


def test_health_readiness_and_prometheus_metrics(client) -> None:
    live = _ok(client.get("/api/health"))
    assert live["status"] == "ok"
    assert live["version"]

    root_health = _ok(client.get("/health"))
    assert root_health["status"] == "ok"

    ready = _ok(client.get("/api/health/ready"))
    assert ready["status"] == "ready"
    assert ready["checks"]["database"]["status"] == "ok"
    assert ready["checks"]["storage"]["status"] == "ok"
    assert ready["checks"]["job_runner"]["mode"] == "sync"

    version = _ok(client.get("/api/version"))
    assert version["api_prefix"] == "/api"

    metrics = client.get("/metrics")
    assert metrics.status_code == 200
    assert "text/plain" in metrics.headers["content-type"]
    body = metrics.text
    assert "mlops_http_requests_total" in body
    assert "mlops_predictions_total" in body


def test_alert_evaluation_dedupe_min_samples_and_severity(
    client, admin: Account, classification_project: dict
) -> None:
    project_id = classification_project["id"]

    high_rule = _ok(
        client.post(
            "/api/alert-rules",
            headers=admin.headers,
            json={
                "name": "High latency guard",
                "project_id": project_id,
                "metric_type": "latency_p95",
                "comparison": "gt",
                "threshold": 250,
                "severity": "critical",
                "window_minutes": 15,
                "cooldown_minutes": 60,
                "min_samples": 10,
                "channels": ["in_app"],
            },
        ),
        201,
    )
    assert high_rule["id"]
    rules = _ok(
        client.get(
            f"/api/alert-rules?project_id={project_id}",
            headers=admin.headers,
        )
    )
    stored_high = next(item for item in rules["items"] if item["id"] == high_rule["id"])
    assert stored_high["min_samples"] == 10

    low_sample_rule = _ok(
        client.post(
            "/api/alert-rules",
            headers=admin.headers,
            json={
                "name": "Latency guard with large sample floor",
                "project_id": project_id,
                "metric_type": "latency_p95",
                "comparison": "gt",
                "threshold": 250,
                "severity": "warning",
                "cooldown_minutes": 60,
                "min_samples": 500,
                "channels": ["in_app"],
            },
        ),
        201,
    )

    db = SessionLocal()
    try:
        project = db.get(Project, project_id)
        assert project is not None

        # A sample count below a rule's floor suppresses that rule while the
        # other rule still evaluates normally.
        created = evaluate_rules(
            db,
            project=project,
            deployment=None,
            observed={"latency_p95": 900.0},
            sample_counts={"latency_p95": 25},
            simulated=True,
        )
        assert len(created) == 1
        alert = created[0]
        assert alert.rule_id == high_rule["id"]
        assert alert.severity == "critical"
        assert alert.type == "latency_p95"
        assert alert.details_json["observed"] == 900.0
        assert alert.details_json["sample_count"] == 25
        assert alert.simulated is True

        # Re-evaluating inside the cooldown returns no new alert.
        again = evaluate_rules(
            db,
            project=project,
            deployment=None,
            observed={"latency_p95": 950.0},
            sample_counts={"latency_p95": 25},
            simulated=True,
        )
        assert again == []

        # With a sufficient sample count the second rule can fire once. Its
        # lower severity is preserved, proving severity comes from the rule.
        after_floor = evaluate_rules(
            db,
            project=project,
            deployment=None,
            observed={"latency_p95": 950.0},
            sample_counts={"latency_p95": 600},
            simulated=True,
        )
        assert len(after_floor) == 1
        assert after_floor[0].rule_id == low_sample_rule["id"]
        assert after_floor[0].severity == "warning"

        # Values below the threshold never create alerts.
        assert (
            evaluate_rules(
                db,
                project=project,
                deployment=None,
                observed={"latency_p95": 10.0},
                sample_counts={"latency_p95": 600},
                simulated=True,
            )
            == []
        )

        alert_count = db.query(Alert).count()
        assert alert_count == 2
    finally:
        db.close()


def test_alert_rules_use_their_configured_window(
    client, admin: Account, classification_project: dict
) -> None:
    project_id = classification_project["id"]
    short_rule = _ok(
        client.post(
            "/api/alert-rules",
            headers=admin.headers,
            json={
                "name": "Short latency window",
                "project_id": project_id,
                "metric_type": "latency_p95",
                "comparison": "gt",
                "threshold": 100,
                "severity": "warning",
                "window_minutes": 15,
                "cooldown_minutes": 60,
                "min_samples": 1,
                "channels": ["in_app"],
            },
        ),
        201,
    )
    long_rule = _ok(
        client.post(
            "/api/alert-rules",
            headers=admin.headers,
            json={
                "name": "Long latency window",
                "project_id": project_id,
                "metric_type": "latency_p95",
                "comparison": "gt",
                "threshold": 500,
                "severity": "high",
                "window_minutes": 60,
                "cooldown_minutes": 60,
                "min_samples": 1,
                "channels": ["in_app"],
            },
        ),
        201,
    )

    db = SessionLocal()
    try:
        project = db.get(Project, project_id)
        assert project is not None
        created = evaluate_rules(
            db,
            project=project,
            deployment=None,
            observed={"latency_p95": 0.0},
            observed_by_window={
                15: {"latency_p95": 200.0},
                60: {"latency_p95": 900.0},
            },
            sample_counts_by_window={
                15: {"latency_p95": 10},
                60: {"latency_p95": 10},
            },
        )
        assert {alert.rule_id for alert in created} == {short_rule["id"], long_rule["id"]}
        assert {alert.type for alert in created} == {"latency_p95"}
    finally:
        db.close()


def test_alert_evaluation_ignores_unobserved_metrics(
    client, admin: Account, classification_project: dict
) -> None:
    _ok(
        client.post(
            "/api/alert-rules",
            headers=admin.headers,
            json={
                "name": "Error rate guard",
                "project_id": classification_project["id"],
                "metric_type": "error_rate",
                "comparison": "gt",
                "threshold": 0.05,
                "severity": "high",
                "channels": ["in_app"],
            },
        ),
        201,
    )
    db = SessionLocal()
    try:
        project = db.get(Project, classification_project["id"])
        assert project is not None
        created = evaluate_rules(
            db,
            project=project,
            deployment=None,
            observed={"latency_p95": 999.0},
            sample_counts={"latency_p95": 100},
        )
        assert created == []
        assert db.query(Alert).count() == 0
    finally:
        db.close()
