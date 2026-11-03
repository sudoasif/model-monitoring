"""Application configuration.

All secrets are read from environment variables. Nothing sensitive is stored in
the database. Defaults are suitable for local development only; production
deployments must set SECRET_KEY and disable insecure defaults.
"""
from __future__ import annotations

import os
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(BASE_DIR.parent / ".env", BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_name: str = "Aperture MLOps"
    environment: str = "development"
    debug: bool = False
    api_prefix: str = "/api"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    allowed_hosts: str = "*"

    secret_key: str = "dev-only-secret-change-me-in-production-0123456789"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 30
    refresh_token_days: int = 7
    cookie_secure: bool = False
    cookie_samesite: str = "lax"
    access_cookie_name: str = "mlops_access"
    refresh_cookie_name: str = "mlops_refresh"

    data_dir: Path = BASE_DIR / "data"
    database_url: str = ""
    auto_create_tables: bool = True
    sqlite_busy_timeout_ms: int = 15000
    retention_days: int = 90
    feature_sample_retention_days: int = 30

    mlflow_enabled: bool = True
    mlflow_tracking_uri: str = ""
    mlflow_artifact_root: str = ""
    mlflow_registry_enabled: bool = True
    mlflow_ui_url: str = ""
    git_commit: str = ""

    storage_backend: str = "local"  # local | s3
    artifact_dir: Path = BASE_DIR / "data" / "artifacts"
    s3_endpoint_url: str = ""
    s3_bucket: str = "mlops-artifacts"
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""
    s3_region: str = "us-east-1"

    job_runner: str = "thread"  # thread | sync | celery
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/1"
    redis_url: str = ""

    max_upload_bytes: int = 50 * 1024 * 1024
    max_dataset_rows: int = 200_000
    max_dataset_columns: int = 200
    max_prediction_body_bytes: int = 2 * 1024 * 1024
    max_batch_size: int = 1000
    json_body_limit_bytes: int = 6 * 1024 * 1024

    rate_limit_auth_per_minute: int = 20
    rate_limit_predict_per_minute: int = 240
    rate_limit_api_per_minute: int = 600

    min_drift_samples: int = 30
    drift_engine: str = "evidently"  # evidently | custom
    drift_alpha: float = 0.05
    drift_psi_threshold: float = 0.2
    drift_share_threshold: float = 0.3
    default_min_label_samples: int = 30
    performance_degradation_threshold: float = 0.10

    capture_monitoring_samples: bool = True
    monitoring_sample_rate: float = 1.0
    log_raw_prediction_input: bool = False

    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from_email: str = ""
    smtp_starttls: bool = True
    slack_webhook_url: str = ""
    alert_email_to: str = ""

    demo_mode: bool = True
    scheduler_enabled: bool = False
    otel_enabled: bool = False
    otel_exporter_endpoint: str = ""

    model_showcase_cache_ttl_seconds: int = 600

    @model_validator(mode="after")
    def _finalize(self) -> Settings:
        data = Path(self.data_dir).resolve()
        data.mkdir(parents=True, exist_ok=True)
        self.data_dir = data
        self.artifact_dir = Path(self.artifact_dir).resolve()
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        if not self.database_url:
            self.database_url = f"sqlite:///{(data / 'mlops.db').as_posix()}"
        if not self.mlflow_tracking_uri:
            self.mlflow_tracking_uri = f"sqlite:///{(data / 'mlflow.db').as_posix()}"
        if not self.mlflow_artifact_root:
            self.mlflow_artifact_root = (data / "mlflow-artifacts").as_uri()
        if not self.git_commit:
            self.git_commit = os.getenv("GIT_COMMIT", "")
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def allowed_host_list(self) -> list[str]:
        return [host.strip() for host in self.allowed_hosts.split(",") if host.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod"}


settings = Settings()
