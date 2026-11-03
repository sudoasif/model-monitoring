from __future__ import annotations

from datetime import datetime
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: Any | None = None
    request_id: str | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


class Message(BaseModel):
    message: str


# ---------------------------------------------------------------- auth


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    full_name: str = Field(min_length=2, max_length=160)
    workspace_name: str | None = Field(default=None, max_length=120)

    @field_validator("password")
    @classmethod
    def _password_strength(cls, value: str) -> str:
        if not any(ch.isalpha() for ch in value) or not any(ch.isdigit() for ch in value):
            raise ValueError("Password must contain at least one letter and one number.")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    full_name: str
    role: str
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None = None


class RoleUpdateRequest(BaseModel):
    role: Literal["admin", "user"]


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=128)


class WorkspaceOut(BaseModel):
    id: str
    name: str
    slug: str
    role: str
    settings: dict[str, Any] = {}


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    settings: dict[str, Any] | None = None


class MemberOut(BaseModel):
    user_id: str
    email: str
    full_name: str
    role: str
    system_role: str
    created_at: datetime


class MemberRoleUpdate(BaseModel):
    role: Literal["owner", "admin", "member"]


class MemberCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    role: Literal["owner", "admin", "member"] = "member"


# ---------------------------------------------------------------- projects


class ProjectCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    description: str = Field(default="", max_length=4000)
    task_type: Literal["classification", "regression"]
    target_column: str = Field(default="", max_length=160)
    positive_label: str | None = Field(default=None, max_length=120)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    task_type: Literal["classification", "regression"] | None = None
    target_column: str | None = Field(default=None, max_length=160)
    positive_label: str | None = Field(default=None, max_length=120)
    status: Literal["active", "archived"] | None = None
    config: dict[str, Any] | None = None


class ProjectOut(BaseModel):
    id: str
    workspace_id: str
    name: str
    slug: str
    description: str
    task_type: str
    target_column: str
    positive_label: str | None
    status: str
    config: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    dataset_count: int = 0
    model_count: int = 0
    deployment_count: int = 0
    latest_run: dict[str, Any] | None = None


class DatasetVersionOut(BaseModel):
    id: str
    dataset_id: str
    dataset_name: str
    version: int
    filename: str
    original_filename: str
    size_bytes: int
    content_hash: str
    row_count: int
    column_count: int
    schema: list[dict[str, Any]]
    profile: dict[str, Any]
    is_reference: bool
    notes: str
    created_at: datetime
    created_by: str


class DatasetOut(BaseModel):
    id: str
    project_id: str
    name: str
    description: str
    created_at: datetime
    versions: list[DatasetVersionOut] = []


class DatasetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    is_reference: bool | None = None
    notes: str | None = Field(default=None, max_length=2000)


class SampleDatasetRequest(BaseModel):
    sample_key: Literal["churn-classification", "house-regression"]
    shifted: bool = False
    is_reference: bool = False
    name: str | None = Field(default=None, max_length=160)


# ---------------------------------------------------------------- training / experiments


class TrainRequest(BaseModel):
    dataset_version_id: str
    algorithms: list[str] | None = None
    tune: bool = False
    n_trials: int = Field(default=10, ge=1, le=50)
    test_size: float = Field(default=0.2, ge=0.1, le=0.4)
    random_state: int = Field(default=42, ge=0, le=2**31 - 1)
    model_name: str | None = Field(default=None, max_length=180)
    notes: str = Field(default="", max_length=2000)


class ExperimentOut(BaseModel):
    id: str
    project_id: str
    project_name: str
    name: str
    mlflow_experiment_id: str | None
    run_count: int
    created_at: datetime


class TrainingRunOut(BaseModel):
    id: str
    project_id: str
    project_name: str
    experiment_id: str
    experiment_name: str
    name: str
    algorithm: str
    status: str
    message: str
    mlflow_run_id: str | None
    params: dict[str, Any]
    metrics: dict[str, Any]
    validation_metrics: dict[str, Any]
    train_metrics: dict[str, Any]
    candidate_results: list[dict[str, Any]]
    feature_columns: list[str]
    target_summary: dict[str, Any]
    prediction_distribution: dict[str, Any]
    duration_seconds: float | None
    git_commit: str
    dataset_version_id: str
    dataset_name: str | None = None
    dataset_version: int | None = None
    registered_model_id: str | None
    model_version_id: str | None
    model_version_number: int | None = None
    job_id: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime


class CompareRequest(BaseModel):
    run_ids: list[str] = Field(min_length=2, max_length=10)


# ---------------------------------------------------------------- registry


class ModelVersionOut(BaseModel):
    id: str
    registered_model_id: str
    version: int
    stage: str
    approval_status: str
    validation_status: str
    validation: dict[str, Any]
    metrics: dict[str, Any]
    params: dict[str, Any]
    model_card: dict[str, Any]
    feature_schema: list[dict[str, Any]]
    mlflow_run_id: str | None
    mlflow_model_uri: str | None
    mlflow_model_version: int | None
    artifact_hash: str
    training_run_id: str | None
    dataset_version_id: str | None
    dataset_name: str | None = None
    dataset_version: int | None = None
    approved_by: str | None
    approved_by_name: str | None = None
    approved_at: datetime | None
    approval_note: str
    rejected_reason: str
    created_at: datetime
    training_run_name: str | None = None
    algorithm: str | None = None
    deployment_count: int = 0


class ModelOut(BaseModel):
    id: str
    project_id: str
    project_name: str
    name: str
    description: str
    task_type: str
    created_at: datetime
    version_count: int
    production_version: ModelVersionOut | None = None
    latest_version: ModelVersionOut | None = None
    pending_approvals: int = 0


class ApproveRequest(BaseModel):
    note: str = Field(default="", max_length=2000)
    promote_to_production: bool = False


class RejectRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class PromoteRequest(BaseModel):
    target: Literal["production", "staging", "archived", "none"] = "production"
    note: str = Field(default="", max_length=2000)


class ModelCardUpdate(BaseModel):
    intended_use: str | None = Field(default=None, max_length=4000)
    limitations: str | None = Field(default=None, max_length=4000)
    training_data: str | None = Field(default=None, max_length=4000)
    evaluation: str | None = Field(default=None, max_length=4000)
    ethical_considerations: str | None = Field(default=None, max_length=4000)
    owner: str | None = Field(default=None, max_length=160)


class ModelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=180)
    description: str | None = Field(default=None, max_length=4000)


# ---------------------------------------------------------------- deployments / predictions


class DeploymentCreate(BaseModel):
    project_id: str
    model_version_id: str
    name: str = Field(min_length=2, max_length=160)
    description: str = Field(default="", max_length=2000)
    reference_dataset_version_id: str | None = None
    min_label_samples: int = Field(default=30, ge=5, le=100_000)


class DeploymentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    reference_dataset_version_id: str | None = None
    min_label_samples: int | None = Field(default=None, ge=5, le=100_000)
    capture_samples: bool | None = None


class DeploymentOut(BaseModel):
    id: str
    project_id: str
    project_name: str
    model_version_id: str
    model_id: str
    model_name: str
    model_version: int
    name: str
    slug: str
    description: str
    status: str
    config: dict[str, Any]
    api_key_prefix: str | None
    last_health_status: str
    last_health_at: datetime | None
    created_at: datetime
    prediction_count: int = 0
    error_rate: float = 0.0
    p95_latency_ms: float | None = None
    latest_drift_severity: str | None = None


class DeploymentCreated(DeploymentOut):
    api_key: str | None = None


class PredictionRequest(BaseModel):
    features: dict[str, Any]
    return_probabilities: bool = False
    request_id: str | None = Field(default=None, max_length=64)


class BatchPredictionRequest(BaseModel):
    records: list[dict[str, Any]] = Field(min_length=1, max_length=1000)
    return_probabilities: bool = False


class PredictionResult(BaseModel):
    request_id: str
    deployment_id: str
    model_version: int
    timestamp: datetime
    prediction: Any
    label: str | None = None
    confidence: float | None = None
    probabilities: dict[str, float] | None = None
    latency_ms: float
    simulated: bool = False


class BatchPredictionResult(BaseModel):
    request_id: str
    deployment_id: str
    model_version: int
    timestamp: datetime
    predictions: list[PredictionResult]
    count: int
    latency_ms: float


# ---------------------------------------------------------------- monitoring


class DriftAnalyzeRequest(BaseModel):
    project_id: str
    deployment_id: str | None = None
    reference_dataset_version_id: str | None = None
    current_dataset_version_id: str | None = None
    window_start: datetime | None = None
    window_end: datetime | None = None


class LabelItem(BaseModel):
    prediction_id: str
    label: Any
    simulated: bool = False


class LabelSubmission(BaseModel):
    deployment_id: str
    labels: list[LabelItem] = Field(min_length=1, max_length=5000)
    source: Literal["api", "import", "demo"] = "api"


class PerformanceQuery(BaseModel):
    deployment_id: str
    window_start: datetime | None = None
    window_end: datetime | None = None


# ---------------------------------------------------------------- alerts / incidents


class AlertRuleCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    project_id: str | None = None
    metric_type: Literal[
        "data_drift_share",
        "feature_psi",
        "performance_degradation",
        "latency_p95",
        "error_rate",
        "invalid_input_rate",
        "prediction_distribution_psi",
        "endpoint_unavailable",
    ]
    comparison: Literal["gt", "lt"] = "gt"
    threshold: float
    window_minutes: int = Field(default=60, ge=5, le=10080)
    severity: Literal["info", "warning", "high", "critical"] = "warning"
    enabled: bool = True
    cooldown_minutes: int = Field(default=30, ge=1, le=10080)
    channels: list[Literal["in_app", "email", "slack"]] = ["in_app"]
    min_samples: int = Field(default=0, ge=0)


class AlertRuleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    comparison: Literal["gt", "lt"] | None = None
    threshold: float | None = None
    window_minutes: int | None = Field(default=None, ge=5, le=10080)
    severity: Literal["info", "warning", "high", "critical"] | None = None
    enabled: bool | None = None
    cooldown_minutes: int | None = Field(default=None, ge=1, le=10080)
    channels: list[Literal["in_app", "email", "slack"]] | None = None
    min_samples: int | None = Field(default=None, ge=0)


class AlertOut(BaseModel):
    id: str
    workspace_id: str
    project_id: str
    project_name: str | None = None
    deployment_id: str | None
    deployment_name: str | None = None
    rule_id: str | None
    type: str
    severity: str
    title: str
    message: str
    status: str
    details: dict[str, Any]
    notification: dict[str, Any]
    simulated: bool
    created_at: datetime
    acknowledged_at: datetime | None
    acknowledged_by: str | None
    resolved_at: datetime | None
    resolved_by: str | None
    resolution_note: str


class ResolveAlertRequest(BaseModel):
    note: str = Field(default="", max_length=2000)


class RemediationRequest(BaseModel):
    action: Literal["open_incident", "schedule_retraining", "recommend_rollback"]
    note: str = Field(default="", max_length=2000)


class IncidentCreate(BaseModel):
    alert_id: str | None = None
    project_id: str
    deployment_id: str | None = None
    title: str = Field(min_length=3, max_length=220)
    description: str = Field(default="", max_length=4000)
    severity: Literal["info", "warning", "high", "critical"] = "warning"
    owner_id: str | None = None


class IncidentUpdate(BaseModel):
    status: Literal["open", "investigating", "mitigated", "resolved"] | None = None
    severity: Literal["info", "warning", "high", "critical"] | None = None
    owner_id: str | None = None
    note: str | None = Field(default=None, max_length=4000)
    resolution_note: str | None = Field(default=None, max_length=4000)


class IncidentOut(BaseModel):
    id: str
    workspace_id: str
    project_id: str
    project_name: str | None = None
    alert_id: str | None
    deployment_id: str | None
    deployment_name: str | None = None
    title: str
    description: str
    severity: str
    status: str
    owner_id: str | None
    owner_name: str | None = None
    notes: list[dict[str, Any]]
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None
    resolution_note: str


# ---------------------------------------------------------------- pipelines


class RetrainRequest(BaseModel):
    project_id: str
    deployment_id: str
    dataset_version_id: str | None = None
    tune: bool = False
    n_trials: int = Field(default=10, ge=1, le=50)
    min_new_labels: int = Field(default=30, ge=1, le=1_000_000)
    notes: str = Field(default="", max_length=2000)


class PipelineJobOut(BaseModel):
    id: str
    workspace_id: str
    project_id: str | None
    project_name: str | None = None
    deployment_id: str | None
    deployment_name: str | None = None
    job_type: str
    status: str
    progress: int
    stage: str
    params: dict[str, Any]
    result: dict[str, Any]
    error: str
    attempts: int
    max_attempts: int
    dedupe_key: str | None
    simulated: bool
    triggered_by_name: str | None = None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class PipelineJobDetail(PipelineJobOut):
    logs: str = ""


# ---------------------------------------------------------------- explainability / demo / settings


class ExplainRequest(BaseModel):
    features: dict[str, Any]
    top_n: int = Field(default=10, ge=1, le=30)


class SimulationRequest(BaseModel):
    deployment_id: str
    count: int = Field(default=50, ge=1, le=2000)
    shift: bool = Field(default=True)
    provide_labels: bool = True
    label_fraction: float = Field(default=0.8, ge=0, le=1)
    interval_ms: int = Field(default=0, ge=0, le=5000)


class DemoSeedRequest(BaseModel):
    task_types: list[Literal["classification", "regression"]] = Field(
        default_factory=lambda: ["classification"], min_length=1, max_length=2
    )


class NotificationTestRequest(BaseModel):
    channel: Literal["email", "slack"]


class AuditEventOut(BaseModel):
    id: str
    actor_id: str | None
    actor_name: str | None = None
    action: str
    entity_type: str
    entity_id: str | None
    details: dict[str, Any]
    ip_address: str
    request_id: str
    created_at: datetime


TokenResponse.model_rebuild()
