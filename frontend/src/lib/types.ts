export type TaskType = "classification" | "regression";

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "user" | string;
  is_active: boolean;
  created_at: string;
  last_login_at?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
  settings: Record<string, unknown>;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

export interface MeResponse {
  user: User;
  workspaces: Workspace[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  task_type: TaskType;
  target_column: string | null;
  positive_label: string | null;
  status: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  dataset_count: number;
  model_count: number;
  deployment_count: number;
  latest_run: {
    id: string;
    name: string;
    status: string;
    algorithm: string;
    metrics: Metrics;
    created_at: string;
  } | null;
}

export interface DatasetField {
  name: string;
  dtype?: string;
  kind: string;
  role: string;
  nullable: boolean;
  unique_count?: number;
  missing_count?: number;
  examples?: unknown[];
  is_pii_like?: boolean;
  range?: { min?: number; max?: number; p50?: number };
  example?: unknown;
}

export interface DatasetVersion {
  id: string;
  dataset_id: string;
  dataset_name: string;
  version: number;
  filename: string;
  original_filename: string;
  size_bytes: number;
  content_hash: string;
  row_count: number;
  column_count: number;
  schema: DatasetField[];
  profile: {
    row_count?: number;
    column_count?: number;
    missing_cells?: number;
    missing_rate?: number;
    duplicate_rows?: number;
    target?: Record<string, unknown>;
    numeric_summary?: Record<string, Record<string, number>>;
    categorical_summary?: Record<string, unknown>;
  };
  is_reference: boolean;
  notes: string | null;
  created_at: string;
  created_by: string;
}

export interface Dataset {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  versions: DatasetVersion[];
}

export interface DatasetPreview {
  dataset_version_id: string;
  dataset_name: string;
  version: number;
  columns: string[];
  dtypes: Record<string, string>;
  rows: Record<string, unknown>[];
  total_rows: number;
  returned_rows: number;
  note: string;
}

export interface Metrics {
  [key: string]: number | string | number[][] | Record<string, unknown> | null;
}

export interface TrainRequest {
  dataset_version_id: string;
  algorithms: string[];
  tune: boolean;
  n_trials: number;
  test_size: number;
  random_state: number;
  model_name?: string;
  notes?: string;
}

export interface TrainingRun {
  id: string;
  project_id: string;
  project_name: string;
  experiment_id: string;
  experiment_name: string;
  name: string;
  algorithm: string;
  status: string;
  message: string | null;
  mlflow_run_id: string | null;
  params: Record<string, unknown>;
  metrics: Metrics;
  validation_metrics: Metrics;
  train_metrics: Metrics;
  candidate_results: Array<Record<string, unknown>>;
  feature_columns: string[];
  target_summary: Record<string, unknown>;
  prediction_distribution: Record<string, unknown>;
  duration_seconds: number | null;
  git_commit: string;
  dataset_version_id: string | null;
  dataset_name: string | null;
  dataset_version: number | null;
  registered_model_id: string | null;
  model_version_id: string | null;
  model_version_number: number | null;
  job_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface Experiment {
  id: string;
  project_id: string;
  project_name: string;
  name: string;
  mlflow_experiment_id: string;
  run_count: number;
  created_at: string;
}

export interface Artifact {
  path: string;
  file_size?: number | null;
  is_dir?: boolean;
}

export interface RunArtifacts {
  run_id: string;
  mlflow_run_id: string | null;
  mlflow_ui_url: string | null;
  run_link: string | null;
  artifacts: Artifact[];
  warning: string | null;
}

export interface ModelVersion {
  id: string;
  registered_model_id: string;
  version: number;
  stage: string;
  approval_status: string;
  validation_status: string;
  validation: {
    status?: string;
    evaluated_on?: string;
    primary_metric?: string;
    primary_value?: number;
    train_metric?: number;
    checks?: Array<{
      name: string;
      passed: boolean;
      observed: number | boolean | string;
      threshold: number | boolean | string;
      message: string;
    }>;
    policy?: Record<string, unknown>;
    label_classes?: string[];
    positive_class?: string;
  };
  metrics: Metrics;
  params: Record<string, unknown>;
  model_card: Record<string, string>;
  feature_schema: DatasetField[];
  mlflow_run_id: string | null;
  mlflow_model_uri: string | null;
  mlflow_model_version: string | null;
  artifact_hash: string;
  training_run_id: string | null;
  dataset_version_id: string | null;
  dataset_name: string | null;
  dataset_version: number | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  approval_note: string | null;
  rejected_reason: string | null;
  created_at: string;
  training_run_name: string | null;
  algorithm: string | null;
  deployment_count: number;
}

export interface RegisteredModel {
  id: string;
  project_id: string;
  project_name: string;
  name: string;
  description: string | null;
  task_type: TaskType;
  created_at: string;
  version_count: number;
  production_version: ModelVersion | null;
  latest_version: ModelVersion | null;
  pending_approvals: number;
}

export interface Deployment {
  id: string;
  project_id: string;
  project_name: string;
  model_version_id: string;
  model_id: string;
  model_name: string;
  model_version: number;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  config: {
    reference_dataset_version_id?: string;
    min_label_samples?: number;
    capture_samples?: boolean;
    deployed_version_history?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  api_key_prefix: string;
  last_health_status: string | null;
  last_health_at: string | null;
  created_at: string;
  prediction_count: number;
  error_rate: number | null;
  p95_latency_ms: number | null;
  latest_drift_severity: string | null;
  latest_drift_at?: string | null;
}

export interface DeploymentCreated extends Deployment {
  api_key: string;
}

export interface HealthStatus {
  status: string;
  deployment: string;
  model_version: number;
  model_name: string;
  project: string;
  task_type: TaskType;
  features: number;
  artifact_hash: string;
  checked_at: string;
}

export interface PredictionSchema {
  features: Record<string, unknown>;
  schema: {
    fields: DatasetField[];
    task_type: TaskType;
    target_column: string | null;
    class_labels?: string[];
    positive_class?: string;
  };
}

export interface PredictionResult {
  request_id: string;
  deployment_id: string;
  model_version: number;
  timestamp: string;
  prediction: string | number;
  label?: string | number;
  confidence?: number;
  probabilities?: Record<string, number> | null;
  latency_ms: number;
  simulated: boolean;
}

export interface BatchResult {
  request_id: string;
  deployment_id: string;
  model_version: number;
  timestamp: string;
  predictions: PredictionResult[];
  count: number;
  latency_ms: number;
}

export interface PredictionRow {
  id: string;
  request_id: string;
  timestamp: string;
  status: string;
  latency_ms: number | null;
  error_type: string | null;
  error_message?: string | null;
  prediction: string | null;
  confidence: number | null;
  simulated: boolean;
  is_batch?: boolean;
  ground_truth: string | null;
  label_received_at: string | null;
  label_simulated?: boolean | null;
}

export interface GlobalExplanation {
  deployment_id: string;
  deployment_name: string;
  model_id: string;
  model_name: string;
  model_version_id: string;
  model_version: number;
  task_type: TaskType;
  target_column: string;
  method: string;
  sample_size: number;
  reference: {
    dataset_version_id: string;
    dataset_version: number;
    dataset_name: string;
    rows_available: number;
    rows_used: number;
  };
  global_importance: Array<{
    feature: string;
    mean_abs_shap: number;
    mean_shap: number;
    share: number;
    direction: string;
    kind: string;
  }>;
  all_feature_count: number;
  class_labels: string[];
  warnings: string[];
  generated_at: string;
  cached: boolean;
}

export interface LocalExplanation {
  deployment_id: string;
  model_version_id: string;
  model_version: number;
  model_name: string;
  task_type: TaskType;
  method: string;
  prediction: string | number;
  probabilities: Record<string, number> | null;
  base_value: number | null;
  contributions: Array<{
    feature: string;
    value: unknown;
    contribution: number;
    direction: string;
  }>;
  all_feature_count: number;
  input: Record<string, unknown>;
  warnings: string[];
}

export interface Overview {
  workspace: { id: string; name: string; role: string };
  window: { start: string; end: string; days: number };
  counts: {
    projects: number;
    deployments: number;
    active_deployments: number;
    unhealthy_deployments: number;
    open_alerts: number;
    critical_alerts: number;
    pending_approvals: number;
  };
  traffic: {
    requests: number;
    errors: number;
    error_rate: number;
    simulated: number;
    production: number;
    latency_p95_ms: number | null;
    source: string;
  };
  recent_runs: TrainingRun[];
  recent_alerts: Alert[];
  recent_drift_reports: DriftReport[];
  projects: Project[];
  resources: {
    scope: string;
    memory_rss_bytes: number;
    memory_vms_bytes: number;
    cpu_percent: number;
    threads: number;
    open_files: number;
    measured_at: string;
    note: string;
  };
}

export interface MonitoringMetrics {
  deployment_id: string;
  window: { start: string; end: string };
  total_requests: number;
  loaded_rows: number;
  sampled: boolean;
  volume: number;
  error_count: number;
  error_rate: number;
  invalid_input_count: number;
  invalid_input_rate: number;
  latency_ms: { p50: number | null; p95: number | null; p99: number | null; avg: number | null };
  confidence: { avg: number | null; min: number | null; max: number | null };
  simulated_count: number;
  production_count: number;
  source: string;
  version_usage: Array<{ model_name: string; version: number; model_version_id: string; count: number }>;
  errors_by_type: Array<{ error_type: string; count: number }>;
  prediction_distribution: {
    kind: string;
    buckets: Array<{ value: string; count: number; share: number }>;
    bins?: number[];
    counts?: number[];
  };
  labels_count: number;
  task_type: TaskType;
}

export interface TimeseriesPoint {
  timestamp: string;
  volume: number;
  errors: number;
  simulated: number;
  error_rate: number;
  latency_p50: number | null;
  latency_p95: number | null;
  avg_confidence: number | null;
}

export interface Timeseries {
  granularity: string;
  window: { start: string; end: string };
  points: TimeseriesPoint[];
  loaded_rows: number;
  truncated: boolean;
}

export interface Performance {
  deployment_id: string;
  deployment_name: string;
  model_version: number;
  window: { start: string; end: string };
  min_labels: number;
  prediction_count: number;
  label_count: number;
  simulated_labels: number;
  baseline_metrics: Metrics;
  primary_metric: string;
  status: string;
  metrics: Metrics | null;
  delta: {
    absolute?: number;
    relative_degradation?: number;
    direction?: string;
    threshold?: number;
  } | null;
  degraded: boolean;
  message: string;
  concept_drift: {
    status: string;
    explanation: string;
    labels_evaluated?: number;
    performance_degraded?: boolean;
    message?: string;
  };
  delayed_labels: { p50_seconds: number | null; p95_seconds: number | null; sample_count: number };
}

export interface LabelStatus {
  deployment_id: string;
  window: { start: string; end: string };
  prediction_count: number;
  label_count: number;
  label_rate: number;
  min_labels: number;
  status: string;
  delayed_labels: { p50_seconds: number | null; p95_seconds: number | null; sample_count: number };
  message: string;
}

export interface DeploymentMonitoring {
  deployment: Deployment;
  project: Project;
  model_version: {
    id: string;
    version: number;
    artifact_hash: string;
    artifact_size_bytes: number;
    model_card: Record<string, string>;
  };
  window: { start: string; end: string; granularity: string };
  simulated_filter: string;
  metrics: MonitoringMetrics;
  timeseries: Timeseries;
  performance: Performance;
  performance_trend: { points: Array<{ date: string; metrics: Metrics; label_count?: number; status?: string }>; baseline_metrics: Metrics; primary_metric: string; min_labels: number };
  data_quality: DataQuality;
  recent_predictions: PredictionRow[];
  latest_drift_report: DriftReport | null;
  latest_performance_report_id: string | null;
  resources: Overview["resources"];
}

export interface DataQuality {
  status: string;
  message?: string | null;
  sample_count: number;
  window: { start: string; end: string };
  features: Array<{
    name: string;
    kind: string;
    missing_rate: number;
    reference_missing_rate: number;
    missing_delta: number;
    sample_count: number;
    status: string;
  }>;
  schema_changes: {
    missing_features: string[];
    added_features: string[];
    type_changes: string[];
  };
  latest_drift_report_id: string | null;
  latest_drift_severity: string | null;
}

export interface DriftFeature {
  feature: string;
  feature_type: string;
  method: string;
  statistic: number | null;
  p_value: number | null;
  adjusted_p_value: number | null;
  psi: number | null;
  threshold: number | null;
  drifted: boolean;
  severity: string;
  reference_missing_rate: number;
  current_missing_rate: number;
  reference_sample_size: number;
  current_sample_size: number;
  details: Record<string, unknown>;
  recommendation: string;
}

export interface DriftReport {
  id: string;
  project_id: string;
  project_name: string;
  deployment_id: string | null;
  deployment_name: string | null;
  reference_dataset_version_id: string | null;
  reference_label: string;
  current_dataset_version_id: string | null;
  current_label: string;
  status: string;
  engine: string;
  severity: string;
  drift_share: number;
  drifted_feature_count: number;
  feature_count: number;
  reference_sample_size: number;
  current_sample_size: number;
  summary: {
    overview?: Record<string, unknown>;
    schema_changes?: Record<string, unknown>;
    missing_value_changes?: unknown[];
    top_drifted_features?: Array<Record<string, unknown>>;
    prediction_drift?: Record<string, unknown>;
    concept_drift?: Record<string, unknown>;
    evidently?: Record<string, unknown>;
    warnings?: string[];
    [key: string]: unknown;
  };
  window: { start?: string; end?: string };
  created_at: string;
  created_by: string | null;
  report: Record<string, unknown>;
  config: Record<string, unknown>;
  features: DriftFeature[];
}

export interface DriftOptions {
  project_id: string;
  deployments: Array<{
    id: string;
    name: string;
    status: string;
    reference_dataset_version_id: string | null;
  }>;
  dataset_versions: Array<{
    id: string;
    dataset_name: string;
    version: number;
    rows: number;
    is_reference: boolean;
    notes: string | null;
    created_at: string;
  }>;
}

export interface Alert {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_name: string | null;
  deployment_id: string | null;
  deployment_name: string | null;
  rule_id: string | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  status: string;
  details: Record<string, unknown>;
  notification: Record<string, unknown>;
  simulated: boolean;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface AlertDetail extends Alert {
  incident: Incident | null;
  rule: Partial<AlertRule> | null;
  remediation_log: Array<Record<string, unknown>>;
}

export interface AlertSummary {
  workspace_id: string;
  window_days: number;
  by_status: Record<string, number>;
  by_severity: Record<string, number>;
  by_type: Array<{ type: string; count: number }>;
  unacknowledged: number;
  open_incidents: number;
}

export interface AlertRule {
  id: string;
  name: string;
  project_id: string | null;
  project_name: string | null;
  metric_type: string;
  comparison: string;
  threshold: number;
  window_minutes: number;
  severity: string;
  enabled: boolean;
  cooldown_minutes: number;
  channels: string[];
  min_samples: number;
  created_at: string;
  updated_at: string;
  last_triggered_at?: string | null;
}

export interface Incident {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_name: string | null;
  deployment_id: string | null;
  deployment_name: string | null;
  alert_id: string | null;
  title: string;
  description: string;
  status: string;
  severity: string;
  owner_id: string | null;
  owner_name: string | null;
  notes?: Array<{ at: string; by: string; note: string }>;
  resolution_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface PipelineJob {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_name: string | null;
  deployment_id: string | null;
  deployment_name: string | null;
  job_type: string;
  status: string;
  progress: number;
  stage: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  simulated: boolean;
  triggered_by_name: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  logs?: string;
}

export interface JobSummary {
  by_status: Record<string, number>;
  by_type: Array<{ job_type: string; count: number }>;
  recent: PipelineJob[];
  active: number;
}

export interface RetrainingStatus {
  deployment_id: string;
  project_id: string;
  baseline_model_version: { id: string; version: number; stage: string; metrics: Metrics } | null;
  label_stats: {
    labelled_events: number;
    labels_with_features: number;
    feature_coverage: number;
    latest_label_at: string | null;
    counted_since: string | null;
  };
  min_labels_required: number;
  label_status: string;
  active_job: PipelineJob | null;
  last_successful_job: PipelineJob | null;
  recent_jobs: PipelineJob[];
  last_comparison: {
    recommendation?: string;
    reason?: string;
    primary_metric?: string;
    baseline_value?: number;
    candidate_value?: number;
    candidate_model_version_id?: string;
    baseline_model_version_id?: string;
    approval_required?: boolean;
    auto_promoted?: boolean;
    metric_deltas?: Record<string, number>;
    [key: string]: unknown;
  } | null;
  approval_required: boolean;
  note: string;
}

export interface DemoStatus {
  demo_mode: boolean;
  simulation_requires_explicit_start: boolean;
  sample_datasets: Array<{
    key: string;
    name: string;
    task_type: TaskType;
    target_column: string;
    description: string;
  }>;
  demo_projects: Array<{ id: string; name: string; task_type: TaskType }>;
  seeded_project_count: number;
  note: string;
}

export interface SettingsSnapshot {
  workspace: {
    id: string;
    name: string;
    slug: string;
    role: string;
    settings: Record<string, unknown>;
    project_count: number;
  };
  user: {
    id: string;
    email: string;
    full_name: string;
    system_role: string;
    workspace_role: string;
    is_workspace_admin: boolean;
  };
  platform: {
    environment: string;
    demo_mode: boolean;
    job_runner: string;
    storage_backend: string;
    scheduler_enabled: boolean;
    otel_enabled: boolean;
    retention_days: number;
    feature_sample_retention_days: number;
  };
  mlflow: {
    enabled: boolean;
    registry_enabled: boolean;
    ui_url: string | null;
    tracking_uri: string;
    artifact_root: string;
    mode: string;
  };
  limits: Record<string, number>;
  monitoring: {
    drift_engine: string;
    drift_alpha: number;
    drift_psi_threshold: number;
    drift_share_threshold: number;
    min_drift_samples: number;
    default_min_label_samples: number;
    performance_degradation_threshold: number;
    capture_monitoring_samples: boolean;
    monitoring_sample_rate: number;
    raw_input_logging: boolean;
  };
  notifications: {
    email_configured: boolean;
    smtp_host_configured: boolean;
    recipients_configured: boolean;
    slack_configured: boolean;
    channels: string[];
  };
  security: {
    access_token_minutes: number;
    refresh_token_days: number;
    cookie_secure: boolean;
    cors_origins: string[];
    total_system_users: number | null;
  };
  features: Array<{ key: string; enabled: boolean }>;
  documentation: { note: string };
}

export interface AuditEvent {
  id: string;
  workspace_id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface AdminOverview {
  workspace_id: string;
  workspace_name: string;
  counts: Record<string, number>;
  database: { dialect: string; size_bytes?: number | null; path?: string };
  system: Record<string, number> | null;
  storage_health: Record<string, unknown>;
  mlflow_health: Record<string, unknown>;
  environment: string;
  background_runner: string;
}

export interface Member {
  user_id: string;
  email: string;
  full_name: string;
  role: string;
  system_role: string;
  created_at: string;
}

export interface Algorithm {
  key: string;
  label: string;
  family: string;
}

export interface AlgorithmCatalog {
  task_type: TaskType;
  algorithms: Algorithm[];
}

export interface ProjectMonitoring {
  project: Project;
  window: { start: string; end: string; days: number };
  metrics: {
    project_id: string;
    window: { start: string; end: string };
    total_requests: number;
    error_count: number;
    error_rate: number;
    simulated_count: number;
    production_count: number;
    active_deployments: number;
  };
  open_alerts: number;
  deployments: Deployment[];
  recent_runs: TrainingRun[];
  latest_model_id: string | null;
}

export interface PerformanceReport {
  id: string;
  window_start: string;
  window_end: string;
  prediction_count: number;
  label_count: number;
  status: string;
  primary_metric: string;
  metrics: Metrics;
  baseline_metrics: Metrics;
  delta: Record<string, unknown>;
  degraded: boolean;
  suspected_concept_drift: boolean;
  notes: string | null;
  created_at: string;
}

export interface IntegrityResult {
  version_id: string;
  expected_hash: string;
  actual_hash?: string;
  integrity_ok: boolean;
  error?: string;
}

export interface CompareResult {
  project_id: string;
  project_name: string;
  task_type: TaskType;
  primary_metric: string;
  higher_is_better: boolean;
  best_run_id: string | null;
  baseline_run_id: string;
  metric_names: string[];
  comparisons: Record<string, Record<string, number | null>>;
  runs: TrainingRun[];
  git_commits: Record<string, string>;
}

export interface LabelSubmissionResult {
  deployment_id: string;
  created: number;
  skipped: number;
  errors: Array<{ prediction_id: string; error: string }>;
  performance: Performance | null;
}

export interface DeploymentCreatedResult extends Deployment {
  api_key: string;
}
