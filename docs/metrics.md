# Metrics, drift and alert semantics

This document defines every metric category exposed by Aperture MLOps, how it is computed, and what it does **not** prove. It also lists the Prometheus metrics and the provisioned Grafana dashboard.

---

## 1. Two metric surfaces

| Surface | Where | Purpose |
| --- | --- | --- |
| Product monitoring | `/monitoring`, deployment detail, `/overview`, REST API | Model behavior: traffic, latency, errors, distributions, data quality, drift, label-gated performance |
| Operational metrics | `GET /metrics` (Prometheus) | Service health: HTTP traffic, prediction throughput/latency, job outcomes, active deployments, alert counts |

Product metrics are computed from rows in the application database. Prometheus metrics are process counters/histograms and reset when the API process restarts.

---

## 2. Product monitoring metrics

### 2.1 Request volume and source mix

| Metric | Definition |
| --- | --- |
| `volume` | Number of prediction events in the selected window after filters |
| `total_requests` | Count in the database before the row-load cap |
| `loaded_rows` | Rows actually loaded for percentile computation |
| `sampled` | `true` when `total_requests > loaded_rows` (the aggregation cap is 200,000 rows) |
| `production_count` | Events where `simulated = false` |
| `simulated_count` | Events where `simulated = true` |
| `source` | `production`, `mixed`, `simulated`, or `none` |

The UI can filter to all traffic, production only, or simulated only. Simulated events are always labelled.

### 2.2 Latency

| Metric | Definition |
| --- | --- |
| `latency_ms.p50` | 50th percentile of end-to-end prediction latency |
| `latency_ms.p95` | 95th percentile |
| `latency_ms.p99` | 99th percentile |
| `latency_ms.avg` | Arithmetic mean |

Percentiles are computed from stored `PredictionEvent.latency_ms` values, including failed requests where latency was recorded. The timeseries endpoint returns per-bucket `latency_p50` and `latency_p95`.

Latency measured here is the API's model-scoring path, not network time between the client and the API.

### 2.3 Errors and invalid inputs

| Metric | Definition |
| --- | --- |
| `error_count` | Events with `status != "success"` |
| `error_rate` | `error_count / max(1, volume)` |
| `invalid_input_count` | Events whose `error_type = "invalid_input"` |
| `invalid_input_rate` | `invalid_input_count / max(1, volume)` |
| `errors_by_type` | Counts grouped by `error_type` (`unknown` when absent) |

Invalid inputs are a subset of errors. Raw feature payloads are not included in error metrics or logs by default.

### 2.4 Confidence

| Metric | Definition |
| --- | --- |
| `confidence.avg` | Mean model-provided confidence among events that report one |
| `confidence.min` / `confidence.max` | Observed range |
| `labels_count` | Ground-truth labels received for events in the window |

Confidence is **model-provided and not calibrated accuracy**. It must not be presented as a probability of correctness unless the model was explicitly calibrated and validated for that interpretation.

### 2.5 Prediction distribution

- **Classification:** counts and shares per predicted label, top 30 labels.
- **Regression:** histogram with up to 20 bins, plus mean/min/max. The API also returns `bins`, `counts` and an empty `buckets` array; the UI renders the histogram.

Distribution changes are descriptive. They do not identify a cause and are not concept drift.

### 2.6 Version usage

Counts per `model_version_id` with model name and version number. Useful during rollback or canary analysis to see which version actually produced events.

### 2.7 Timeseries

Buckets are hourly, daily or weekly. Each point contains:

- `timestamp`
- `volume`
- `errors`
- `simulated`
- `error_rate`
- `latency_p50`, `latency_p95`
- `avg_confidence`

Empty buckets are included so gaps are visible rather than silently connected.

### 2.8 Data quality

For each model feature, compared with the deployment's reference dataset version:

- current missing rate
- reference missing rate
- missing-rate delta
- sample count
- status (`ok` or `warning`; warning when current missing rate > 10% or delta > 5 percentage points)

Schema changes are reported as missing features, added features and type changes when a drift report provides them. If no feature samples were captured, the API returns `status: "no_data"` with a message, zero samples and empty arrays rather than inventing values.

Feature samples are captured only when `CAPTURE_MONITORING_SAMPLES=true`, subject to `MONITORING_SAMPLE_RATE`, and are retained for `FEATURE_SAMPLE_RETENTION_DAYS`.

### 2.9 Process resources

`resources` reports process-wide values from `psutil`:

- memory RSS and VMS
- CPU percent
- thread count
- open files
- measurement timestamp

This is **not per-deployment attribution**. It describes the API process that answered the request.

---

## 3. Drift metrics

Drift analysis compares a reference distribution with a current distribution. The reference can be:

- the deployment's configured reference dataset version, or
- a selected dataset version.

The current data can be:

- captured production feature samples, or
- a selected dataset version.

Both are sampled deterministically (up to 20,000 rows per side) before analysis.

### 3.1 Feature-level statistics

| Feature kind | Primary statistic | Supporting statistic |
| --- | --- | --- |
| Numeric | PSI over reference quantile bins (10 bins) | Two-sample Kolmogorov–Smirnov |
| Categorical | PSI over the top 20 reference categories plus `__other__` | Chi-square test of independence |

Implementation details:

- Numeric PSI bins come from reference quantiles; the outer edges are extended to cover the current range. Zero-probability bins are smoothed to `1e-6` before taking logs.
- Categorical PSI groups rare/new categories into `__other__` and caps categories at 20.
- Chi-square merges the rarest categories until all expected counts are at least 5, or only two rows remain. If the assumption still cannot be met, the result is flagged with `low_expected_counts`.
- KS and chi-square p-values are computed per feature, then adjusted with the **Benjamini–Hochberg** procedure across all tested features to control the false discovery rate.

### 3.2 Drift decision rule

A feature is marked drifted when either condition holds:

1. `PSI >= DRIFT_PSI_THRESHOLD` (default `0.2`), or
2. the Benjamini–Hochberg adjusted p-value is significant at `DRIFT_ALPHA` (default `0.05`) **and** PSI is absent or at least `0.1`.

Requiring a meaningful effect size alongside statistical significance prevents large samples from flagging trivial differences. Conversely, PSI alone can flag drift even when a p-value is unavailable.

### 3.3 Severity

Feature severity from PSI:

| PSI | Severity |
| --- | --- |
| `< 0.1` | `low` |
| `>= 0.1` | `medium` |
| `>= 0.2` | `high` |
| `>= 0.25` | `critical` |

Dataset severity:

| Condition | Severity |
| --- | --- |
| No drifted features | `none` |
| Drift share `>= 0.5` or max PSI `>= 0.25` | `critical` |
| Drift share `>= 0.25` or max PSI `>= 0.2` | `high` |
| Drift share `>= 0.1` or max PSI `>= 0.1` | `medium` |
| Otherwise (at least one drifted feature) | `low` |

A missing-rate shift can raise a feature's severity to `medium` even when distribution tests are quiet.

### 3.4 Prediction drift

Prediction drift compares the model output distribution with the training/validation baseline:

- Classification: PSI over baseline class shares.
- Regression: PSI over baseline histogram bins and shares.

Prediction drift is reported separately from feature drift. It is **not** evidence of concept drift by itself: the input population can change while the feature-to-outcome relationship remains stable, or vice versa.

### 3.5 Concept drift

Concept drift is a change in the relationship between features and the target. This platform handles it conservatively:

- **Without sufficient labels:** `status = "not_assessed"` and an explanation that labels are required.
- **With labels and no degradation beyond the guardrail:** `no_degradation_detected`. This is not proof of stability.
- **With labels and degradation beyond the guardrail:** `suspected_not_confirmed`. The explanation explicitly says confirmation requires segment analysis, drift reports and label-quality investigation.

Distribution tests never set concept drift to "confirmed".

### 3.6 Low-sample handling

- `MIN_DRIFT_SAMPLES` (default `30`) controls the minimum sample expectation.
- Reports include explicit warnings when either side is small, when a feature has too few non-null values, when schema changes are present, or when Evidently is unavailable and the local engine is used.
- The report still returns whatever evidence exists, marked with its limitations, instead of failing silently.

### 3.7 Engines

- **Local statistical engine (primary evidence):** PSI, KS, chi-square, BH FDR.
- **Evidently (`evidently==0.7.23`, `DataDriftPreset`):** run as an additional engine when available. Failures are logged and surfaced as a warning; the local engine's results remain available.

`DRIFT_ENGINE=evidently` selects Evidently as the configured engine label; the local statistics are still computed and stored as the auditable evidence.

---

## 4. Performance metrics (labels required)

Performance is computed only from ground-truth labels joined to prediction events. Unlabelled predictions never produce accuracy, F1, ROC-AUC, MAE, RMSE or R².

### 4.1 Minimum labels

- Default: `DEFAULT_MIN_LABEL_SAMPLES=30`, overridable per deployment via `min_label_samples`.
- Below the threshold, the API returns `status: "insufficient_labels"`, empty metrics and an explicit message. The UI shows an "Insufficient labels" state.
- Classification also requires labels whose values match the deployed model's class schema. Labels outside the schema are excluded and counted in the message.

### 4.2 Classification metrics

| Metric | Definition |
| --- | --- |
| `accuracy` | Correct predictions / valid labelled predictions |
| `precision_macro` | Macro-averaged precision over model classes |
| `recall_macro` | Macro-averaged recall |
| `f1_macro` | Macro-averaged F1 |
| `roc_auc` | Binary AUC from the positive-class probability, or one-vs-rest AUC for multiclass |
| `log_loss` | Multiclass/binary log loss when probabilities are present |
| `confusion_matrix` | Matrix in model class order |
| `per_class` | Support, precision and recall per class |

Zero-division cases use `zero_division=0`.

### 4.3 Regression metrics

| Metric | Definition |
| --- | --- |
| `mae` | Mean absolute error |
| `mse` | Mean squared error |
| `rmse` | Square root of MSE |
| `r2` | Coefficient of determination |
| `mape` | Mean absolute percentage error over non-zero targets, or `null` |
| `residual_mean` | Mean of `prediction - actual` |

### 4.4 Degradation and primary metric

The primary metric defaults to:

- `f1_macro` for classification
- `rmse` for regression

It can be overridden per project with `performance_metric`.

Relative degradation is direction-aware:

- Higher-is-better metrics: `(baseline - current) / |baseline|`
- Lower-is-better metrics: `(current - baseline) / |baseline|`

The deployment is marked degraded when relative degradation exceeds `PERFORMANCE_DEGRADATION_THRESHOLD` (default `0.10`, i.e. 10%). A degraded result sets concept-drift status to `suspected_not_confirmed`.

### 4.5 Delayed labels

The API reports:

- `p50_seconds` and `p95_seconds` — delay between prediction time and label receipt
- `sample_count` — number of labelled events contributing
- label rate over 30 days (`GET /deployments/{id}/labels/status`)

These statistics make label latency visible. A low label rate is not evidence of model health.

### 4.6 Performance trend and reports

- The trend endpoint groups labelled events by day and computes metrics only for days meeting the minimum label count.
- Gaps mean there were not enough labels for that window; they are not zero performance.
- Evaluation reports are immutable snapshots with window, metrics, delta, degraded flag, concept-drift status and simulated-label count.
- Reports are created when labels are submitted or when `POST /deployments/{id}/performance/evaluate` is called explicitly.

---

## 5. Alert rules

### 5.1 Rule types

| Type | Observed value |
| --- | --- |
| `data_drift_share` | Share of tested features marked drifted in the latest report |
| `feature_psi` | Maximum feature PSI in the latest report |
| `performance_degradation` | Relative degradation of the primary labelled metric |
| `latency_p95` | p95 prediction latency in milliseconds |
| `error_rate` | Error share in the window |
| `invalid_input_rate` | Invalid-input share |
| `prediction_distribution_psi` | PSI between the baseline output distribution and current predictions |
| `endpoint_unavailable` | `1` when the deployment's last health check is unhealthy, `0` otherwise; health checks also raise a system alert |

Rules have:

- `comparison` (`gt` or `lt`)
- `threshold`
- `severity` (`info`, `warning`, `high`, `critical`)
- `window_minutes`
- `cooldown_minutes`
- `min_samples`
- notification `channels` (`in_app`, optional `email`, `slack`)

### 5.2 Evaluation semantics

- Operational rules (`latency_p95`, `error_rate`, `invalid_input_rate`, `prediction_distribution_psi`, `endpoint_unavailable`) are evaluated after real prediction traffic, at most once per 60 seconds per deployment to keep serving latency predictable. Each rule is evaluated against its own configured `window_minutes`.
- Drift rules are evaluated when a drift report completes. Performance rules are evaluated when labelled performance is computed.
- Endpoint health failures also create a system `endpoint_unavailable` alert when deployment health is checked or a deployment is activated.
- A rule triggers only when its metric is **observed** for the window. Missing data does not trigger a "zero" alert.
- If `min_samples > 0` and the sample count is known and below the minimum, the rule is skipped. This prevents low-traffic noise.
- `gt` triggers when `value > threshold`; `lt` triggers when `value < threshold`.
- Cooldown deduplication uses a stable key of project, deployment, alert type and rule. A duplicate inside the cooldown is not created.
- Alerts record observed value, threshold, comparison, window, rule, context and sample count in their details.
- Acknowledging or resolving an alert records the actor and timestamp in the audit trail.
- Notifications are best-effort. In-app alerts always exist; SMTP/Slack failures do not roll back the alert.

### 5.3 Remediation

Remediation is explicit and auditable:

- `open_incident` — workspace members
- `schedule_retraining` — workspace admin
- `recommend_rollback` — workspace admin, advisory only

No remediation action deploys or rolls back a model automatically. Deployment and rollback remain separate, human-triggered operations.

### 5.4 Default demo rules

Demo seeding creates these rules (they can be edited or disabled):

| Rule | Type | Threshold | Severity | Window | Cooldown | Min samples |
| --- | --- | --- | --- | --- | --- | --- |
| High data drift share | `data_drift_share` | `0.3` | high | 1440 min | 60 min | 50 |
| Prediction distribution shift | `prediction_distribution_psi` | `0.2` | warning | 120 min | 60 min | 30 |
| Elevated error rate | `error_rate` | `0.05` | critical | 30 min | 15 min | 10 |
| Slow predictions (p95) | `latency_p95` | `1500 ms` | warning | 30 min | 30 min | 10 |

Default rules are demo configuration, not universal production thresholds. Tune them to your traffic and SLOs.

---

## 6. Prometheus metrics

Scraped by Prometheus from `backend:8000/metrics` in Compose.

### 6.1 HTTP

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `mlops_http_requests_total` | Counter | `method`, `route`, `status` | Requests processed |
| `mlops_http_request_duration_seconds` | Histogram | `method`, `route` | Request duration; buckets from 5 ms to 30 s |

`route` is the matched FastAPI route template, or `unmatched`. Labels are intentionally low-cardinality; raw paths with IDs are not used.

### 6.2 Predictions

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `mlops_predictions_total` | Counter | `deployment_id`, `status`, `batch` | Predictions served, split by success/error and single/batch |
| `mlops_prediction_latency_seconds` | Histogram | `deployment_id` | Model prediction latency; buckets from 5 ms to 5 s |

### 6.3 Pipelines and jobs

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `mlops_training_jobs_total` | Counter | `status`, `task_type` | Training outcomes |
| `mlops_pipeline_jobs_total` | Counter | `job_type`, `status` | All pipeline job outcomes |
| `mlops_background_jobs_in_progress` | Gauge | — | Jobs currently running |
| `mlops_drift_reports_total` | Counter | `severity` | Drift reports by severity |
| `mlops_alerts_total` | Counter | `severity`, `type` | Alerts created |
| `mlops_active_deployments` | Gauge | — | Deployments currently active |

`deployment_id` is high-cardinality by nature. For large fleets, aggregate or relabel it in Prometheus rather than retaining unbounded series.

### 6.4 Grafana

Compose provisions:

- Datasource: **Prometheus** (`uid: prometheus`), default
- Dashboard: **Aperture MLOps — Platform overview** (`uid: aperture-overview`)

Panels:

1. API request rate by status
2. HTTP latency p95 by route
3. Prediction throughput
4. Prediction latency p95
5. Active deployments
6. Alerts created in the last hour
7. Pipeline jobs and drift reports
8. API 5xx error rate

The dashboard JSON is in `infra/grafana/dashboards/aperture-overview.json`; provisioning is under `infra/grafana/provisioning/`.

---

## 7. Logs and correlation

- Logs are JSON lines to stdout.
- Every request receives an `X-Request-ID` response header. A valid caller-supplied `X-Request-ID` (8–64 ASCII characters) is reused.
- Log fields include `timestamp`, `level`, `logger`, `message`, `request_id`, `service`, `path`, `method`, `status`, `duration_ms`.
- Unhandled exceptions log a stack trace server-side; the API response contains a generic message and the request ID.
- Raw prediction inputs are not logged unless `LOG_RAW_PREDICTION_INPUT=true`. Keep it `false` for PII-sensitive data.

---

## 8. Reading metrics correctly

- A request count is not a user count. One client can send many requests.
- Latency percentiles require enough samples; low-traffic windows can look erratic.
- Error rate includes validation and model failures; inspect `errors_by_type`.
- Confidence is not calibrated accuracy.
- Prediction drift is not concept drift.
- Performance requires labels. "Insufficient labels" means **unknown**, not zero.
- Simulated traffic is always marked and can be excluded; do not present it as production evidence.
- Drift tests are statistical evidence, not causal explanations.
- A healthy dashboard is not proof that a model is fair, safe or compliant. Use segment-level analysis, label quality review and domain validation alongside these metrics.
