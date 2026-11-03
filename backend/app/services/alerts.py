from __future__ import annotations

import logging
import smtplib
from datetime import timedelta
from email.message import EmailMessage
from typing import Any

import httpx
from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Alert, AlertRule, Deployment, Project
from app.observability import ALERTS_CREATED
from app.services.audit import record_audit
from app.utils import utcnow

logger = logging.getLogger(__name__)

SEVERITY_ORDER = {"info": 0, "warning": 1, "high": 2, "critical": 3}


def _send_email(alert: Alert) -> dict[str, Any]:
    if not settings.smtp_host or not settings.alert_email_to:
        return {"status": "skipped", "reason": "SMTP is not configured (SMTP_HOST / ALERT_EMAIL_TO)."}
    recipients = [address.strip() for address in settings.alert_email_to.split(",") if address.strip()]
    if not recipients:
        return {"status": "skipped", "reason": "No alert recipients configured."}
    message = EmailMessage()
    message["Subject"] = f"[{alert.severity.upper()}] {alert.title}"
    message["From"] = settings.smtp_from_email or settings.smtp_username or "alerts@localhost"
    message["To"] = ", ".join(recipients)
    message.set_content(
        f"{alert.message}\n\nSeverity: {alert.severity}\nType: {alert.type}\n"
        f"Alert ID: {alert.id}\nCreated: {alert.created_at.isoformat()}\n\n"
        "Open the platform to acknowledge and investigate this alert."
    )
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=8) as smtp:
            if settings.smtp_starttls:
                smtp.starttls()
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(message)
        return {"status": "sent", "recipients": len(recipients)}
    except Exception as exc:
        logger.warning("alert_email_failed", exc_info=True)
        return {"status": "failed", "error": str(exc)[:200]}


def _send_slack(alert: Alert) -> dict[str, Any]:
    url = settings.slack_webhook_url
    if not url:
        return {"status": "skipped", "reason": "SLACK_WEBHOOK_URL is not configured."}
    if not url.startswith("https://"):
        return {"status": "skipped", "reason": "Slack webhook URL must use HTTPS."}
    text = f"*{alert.severity.upper()}* · {alert.title}\n{alert.message}\nType: `{alert.type}` · Alert ID: `{alert.id}`"
    try:
        response = httpx.post(url, json={"text": text}, timeout=8)
        if response.status_code >= 300:
            return {"status": "failed", "http_status": response.status_code}
        return {"status": "sent"}
    except Exception as exc:
        logger.warning("alert_slack_failed", exc_info=True)
        return {"status": "failed", "error": str(exc)[:200]}


def test_notification(channel: str) -> dict[str, Any]:
    """Send a synthetic test notification without creating an alert record."""
    now = utcnow()
    alert = Alert(
        id="test-notification",
        workspace_id="test",
        project_id="test",
        deployment_id=None,
        rule_id=None,
        type="notification_test",
        severity="info",
        title="Test notification from Aperture MLOps",
        message=(
            "This is a test notification. If you received it, alert delivery through this channel is configured."
        ),
        status="open",
        dedupe_key="test-notification",
        details_json={"test": True},
        notification_json={},
        simulated=False,
        created_at=now,
    )
    if channel == "email":
        return _send_email(alert)
    if channel == "slack":
        return _send_slack(alert)
    return {"status": "failed", "error": "Unsupported notification channel."}


def notify_alert(db: Session, alert: Alert, channels: list[str], simulated: bool) -> None:
    payload: dict[str, Any] = {"attempted_at": utcnow().isoformat(), "channels": {}}
    if simulated:
        payload["note"] = "Simulated/demo alert: external notifications suppressed."
        for channel in channels:
            if channel != "in_app":
                payload["channels"][channel] = {"status": "skipped", "reason": "Simulated alert."}
        payload["channels"]["in_app"] = {"status": "delivered"}
        alert.notification_json = payload
        db.commit()
        return
    for channel in channels:
        if channel == "in_app":
            payload["channels"]["in_app"] = {"status": "delivered"}
        elif channel == "email":
            payload["channels"]["email"] = _send_email(alert)
        elif channel == "slack":
            payload["channels"]["slack"] = _send_slack(alert)
    alert.notification_json = payload
    db.commit()


def create_alert(
    db: Session,
    *,
    project: Project,
    deployment: Deployment | None,
    alert_type: str,
    severity: str,
    title: str,
    message: str,
    details: dict[str, Any] | None = None,
    rule: AlertRule | None = None,
    dedupe_key: str | None = None,
    channels: list[str] | None = None,
    simulated: bool = False,
    request: Request | None = None,
    cooldown_minutes: int = 30,
) -> tuple[Alert | None, bool]:
    dedupe = dedupe_key or f"{project.id}:{deployment.id if deployment else 'project'}:{alert_type}:{rule.id if rule else 'system'}"
    cutoff = utcnow() - timedelta(minutes=cooldown_minutes)
    existing = db.scalar(
        select(Alert)
        .where(Alert.dedupe_key == dedupe, Alert.created_at >= cutoff)
        .order_by(Alert.created_at.desc())
    )
    if existing:
        return existing, False
    alert = Alert(
        workspace_id=project.workspace_id,
        project_id=project.id,
        deployment_id=deployment.id if deployment else None,
        rule_id=rule.id if rule else None,
        type=alert_type,
        severity=severity,
        title=title[:220],
        message=message,
        status="open",
        dedupe_key=dedupe[:255],
        details_json=details or {},
        simulated=simulated,
        created_at=utcnow(),
    )
    db.add(alert)
    db.flush()
    record_audit(
        db,
        workspace_id=project.workspace_id,
        actor=None,
        action="alert.created",
        entity_type="alert",
        entity_id=alert.id,
        details={"type": alert_type, "severity": severity, "simulated": simulated},
        request=request,
    )
    db.commit()
    ALERTS_CREATED.labels(severity, alert_type).inc()
    notify_alert(db, alert, channels or ["in_app"], simulated)
    return alert, True


def create_system_alert(
    db: Session,
    *,
    project: Project,
    deployment: Deployment | None,
    alert_type: str,
    severity: str,
    title: str,
    message: str,
    details: dict[str, Any] | None = None,
    request: Request | None = None,
    simulated: bool = False,
) -> Alert | None:
    rules = db.scalars(
        select(AlertRule).where(
            AlertRule.workspace_id == project.workspace_id,
            AlertRule.enabled.is_(True),
            AlertRule.metric_type == alert_type,
            (AlertRule.project_id == project.id) | (AlertRule.project_id.is_(None)),
        )
    ).all()
    rule = rules[0] if rules else None
    alert, _created = create_alert(
        db,
        project=project,
        deployment=deployment,
        alert_type=alert_type,
        severity=severity,
        title=title,
        message=message,
        details=details,
        rule=rule,
        channels=rule.channels_json if rule else ["in_app"],
        simulated=simulated,
        request=request,
        cooldown_minutes=rule.cooldown_minutes if rule else 30,
    )
    return alert


def evaluate_rules(
    db: Session,
    *,
    project: Project,
    deployment: Deployment | None,
    observed: dict[str, float | None],
    context: dict[str, Any] | None = None,
    sample_counts: dict[str, int] | None = None,
    observed_by_window: dict[int, dict[str, float | None]] | None = None,
    sample_counts_by_window: dict[int, dict[str, int]] | None = None,
    simulated: bool = False,
    request: Request | None = None,
) -> list[Alert]:
    rules = db.scalars(
        select(AlertRule).where(
            AlertRule.workspace_id == project.workspace_id,
            AlertRule.enabled.is_(True),
            (AlertRule.project_id == project.id) | (AlertRule.project_id.is_(None)),
        )
    ).all()
    created_alerts: list[Alert] = []
    sample_counts = sample_counts or {}
    for rule in rules:
        rule_observed = (
            observed_by_window.get(rule.window_minutes, observed)
            if observed_by_window
            else observed
        )
        rule_counts = (
            sample_counts_by_window.get(rule.window_minutes, sample_counts)
            if sample_counts_by_window
            else sample_counts
        )
        value = rule_observed.get(rule.metric_type)
        if value is None:
            continue
        minimum = max(rule.min_samples, 0)
        count = rule_counts.get(rule.metric_type)
        if minimum and count is not None and count < minimum:
            continue
        triggered = value > rule.threshold if rule.comparison == "gt" else value < rule.threshold
        if not triggered:
            continue
        comparison_text = "above" if rule.comparison == "gt" else "below"
        title = f"{rule.name} {comparison_text} threshold"
        message = (
            f"{rule.metric_type.replace('_', ' ').title()} is {value:.4f} "
            f"({comparison_text} the configured threshold of {rule.threshold:.4f})."
        )
        alert, created = create_alert(
            db,
            project=project,
            deployment=deployment,
            alert_type=rule.metric_type,
            severity=rule.severity,
            title=title,
            message=message,
            details={
                "observed": value,
                "threshold": rule.threshold,
                "comparison": rule.comparison,
                "window_minutes": rule.window_minutes,
                "rule_id": rule.id,
                "context": context or {},
                "sample_count": count,
            },
            rule=rule,
            channels=rule.channels_json,
            simulated=simulated,
            request=request,
            cooldown_minutes=rule.cooldown_minutes,
        )
        if created and alert:
            created_alerts.append(alert)
    return created_alerts
