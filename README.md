# Aperture MLOps

[![CI](https://github.com/sudoasif/model-monitoring/actions/workflows/ci.yml/badge.svg)](https://github.com/sudoasif/model-monitoring/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An end-to-end, production-oriented MLOps and model-monitoring platform. It trains real models, tracks them in MLflow, gates promotion behind human approval, serves single and batch predictions, and derives monitoring, drift, performance and alerts from stored prediction events.

> **No mock dashboards.** Every number shown by the UI comes from a real database query, a real model fit, a real drift computation, or an explicitly labelled simulation. Synthetic traffic never starts by itself.

---

## What is verified in this repository

| Area | Status |
| --- | --- |
| Backend unit + API + integration tests | **76 passed** locally |
| Frontend component/unit tests | **20 passed** locally (Vitest + Testing Library) |
| Frontend lint, TypeScript, production build | **Passing** locally (Next.js 16.4.3) |
| Backend lint | **Passing** (`ruff check app tests`) |
| Playwright main journey | **Passing** locally (register → train → approve → deploy → predict → monitor → registry/deployments) |
| Alembic initial migration | Upgrade/downgrade verified on a fresh SQLite database |
| Docker Compose / Postgres / Redis / MinIO / MLflow server / Prometheus / Grafana | **Configuration included, not executed locally** — Docker was unavailable in the authoring environment |

The verified local path uses SQLite, local filesystem artifacts, an in-process thread job runner, and MLflow's SQLite tracking backend. The Compose path is provided for a fuller deployment but must be validated in your environment. See [docs/deployment.md](docs/deployment.md).

---

## Feature overview

### Data and projects
- Workspace-scoped projects with classification and regression task types.
- CSV upload with size, row, column, encoding, delimiter, duplicate-column and target validation.
- Dataset profiling, preview, versioning, download, soft deletion and audit history.
- Two synthetic sample datasets that can be created from the UI or API:
  - `churn-classification` — target `is_churned`
  - `house-regression` — target `price`

### Training and experiments
- Real scikit-learn / XGBoost training with leakage prevention and an untouched held-out test set.
- Optuna hyperparameter search, cross-validation on the training split only, and deterministic seeds.
- Classification metrics: accuracy, precision, recall, F1, ROC-AUC. Regression metrics: MAE, RMSE, R².
- MLflow experiment tracking, artifact logging, run comparison, git commit, duration and best-run selection.
- Model cards, dataset references, feature schema and preprocessing metadata stored with each version.

### Model registry and governance
- Registered models with immutable versions and `candidate` alias on creation.
- Explicit approval, rejection, stage promotion and rollback workflows.
- Human approval is always required before deployment. Training score alone can never deploy a model.
- SHA-256 artifact integrity verification and model-card editing.
- Full audit trail for approval, promotion, deployment, rollback, alerts and retraining.

### Deployment and prediction
- Approved-model deployment with a per-deployment API key and public slug endpoint.
- Single and batch prediction, probabilities, request IDs, timestamps, latency and error tracking.
- Request size and batch-size limits, per-endpoint rate limiting, model caching and health checks.
- Prediction playground, schema introspection, sample payload, API-key rotation and rollback.
- Optional explainability endpoints backed by SHAP.

### Monitoring, drift and performance
- Request volume, p50/p95/p99 latency, average latency, error rate, invalid-input rate and confidence.
- Prediction distribution, model-version usage, error breakdown and process resource usage.
- Data-quality view: missing rates versus reference, schema changes, low-sample states.
- Drift reports with PSI, Kolmogorov–Smirnov and chi-square tests, Benjamini–Hochberg FDR correction, Evidently as an additional engine, and explicit low-sample warnings.
- Data drift, prediction drift and concept drift are reported separately. Concept drift is never confirmed from distribution tests without labels.
- Performance is computed **only** from ground-truth labels, with an explicit `insufficient_labels` state and delayed-label statistics.

### Alerts, incidents and remediation
- Rule types: data-drift share, feature PSI, performance degradation, p95 latency, error rate, invalid-input rate, prediction-distribution PSI and endpoint availability.
- Severity levels, cooldown-based deduplication, acknowledgement, resolution and audit history.
- In-app notifications, optional SMTP email and optional Slack webhook.
- Explicit remediation actions: open an incident, schedule retraining, recommend rollback.
- No automatic deployment or rollback is performed by an alert.

### Retraining
- Label-sufficiency checks, data validation, candidate training through the normal pipeline, baseline comparison and a written recommendation.
- Candidate versions remain pending approval; comparison is advisory only.
- Deduplicated active jobs, retry support, job logs and audit records.

### Operations
- Prometheus metrics, JSON structured logs, request/correlation IDs, health and readiness endpoints.
- Database and storage readiness checks; MLflow degradation is reported without blocking prediction serving.
- Grafana datasource and dashboard provisioning.
- Dockerfiles for backend and frontend, Compose stack, GitHub Actions CI, Alembic migrations.
- Demo mode with seeded projects, sample data, baseline and shifted drift datasets, and opt-in traffic simulation.

---

## Architecture

```text
┌────────────────────────────┐        ┌──────────────────────────────────────┐
│ Next.js 16 / React 19      │  HTTPS │ FastAPI                              │
│ Tailwind + Radix + Recharts│ ─────► │ JWT auth · workspace RBAC · limits   │
│ React Query                │        │                                      │
└────────────────────────────┘        │  ┌────────────┐  ┌────────────────┐  │
                                      │  │ Training   │  │ Monitoring     │  │
                                      │  │ Optuna     │  │ Drift          │  │
                                      │  │ sklearn/XGB│  │ Performance    │  │
                                      │  └─────┬──────┘  │ Explainability │  │
                                      │        │         └───────┬────────┘  │
                                      │        ▼                 ▼           │
                                      │  MLflow tracking   SQLAlchemy models │
                                      └───────┬─────────────────┬────────────┘
                                              │                 │
                        ┌─────────────────────┴───┐   ┌─────────┴────────────┐
                        │ MLflow (SQLite or       │   │ SQLite (local) or    │
                        │ Postgres) + artifacts   │   │ Postgres (Compose)   │
                        │ local FS or S3/MinIO    │   └──────────────────────┘
                        └─────────────────────────┘
                                              │
                              ┌───────────────┴───────────────┐
                              │ Thread runner (local) or      │
                              │ Celery + Redis (Compose)      │
                              └───────────────────────────────┘
```

### Request and job flow

1. A user registers; the first account becomes the system administrator and owns its workspace.
2. A dataset version is uploaded or generated from a sample definition.
3. Training queues a pipeline job. The worker performs preprocessing, Optuna HPO, final fit, held-out evaluation, MLflow logging and model-version registration.
4. A workspace admin approves the version. Deployment requires an approved version and records the approval in the audit log.
5. Predictions write `PredictionEvent` rows. Monitoring aggregates these rows; raw feature payloads are stored separately only when sample capture is enabled.
6. Drift jobs compare a reference distribution with captured production features or a selected dataset version. Alerts are evaluated from observed metrics.
7. Ground-truth labels unlock performance metrics and concept-drift suspicion. Retraining creates a candidate that still needs approval.

### Repository layout

```text
backend/
  app/
    routers/        FastAPI route modules
    services/       training, prediction, drift, monitoring, alerts, retraining, storage, MLflow
    workers/        Celery app and tasks
    models.py       SQLAlchemy models
    schemas.py      Pydantic contracts
    observability.py Prometheus metrics, JSON logs, request IDs
  alembic/          Initial schema migration
  tests/            Unit, API, auth, drift, policy and full integration journey
frontend/
  src/app/          Ten dashboard pages plus login/register
  src/components/   App shell, charts, dialogs and feature panels
  src/lib/          Typed API client, React Query hooks, utilities
  e2e/              Playwright main journey
infra/
  mlflow/ postgres/ minio/ prometheus/ grafana/
docker-compose.yml
.github/workflows/ci.yml
docs/
  deployment.md     Compose and low-cost deployment guide
  metrics.md        Metric definitions, Prometheus names, drift/alert semantics
```

---

## Local quick start (verified path)

### Prerequisites

- Python **3.12+**
- Node.js **24+** and npm
- No Docker required for the local path
- Optional: Git, for recording commit metadata in training runs

### 1. Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:PYTHONPATH="."
$env:MLFLOW_DISABLE_AGENT_HINT="1"
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

macOS/Linux:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export PYTHONPATH=.
export MLFLOW_DISABLE_AGENT_HINT=1
python -m uvicorn app.main:app --reload --port 8000
```

On first start the backend creates:

- `backend/data/mlops.db` — application database (SQLite by default)
- `backend/data/mlflow.db` — MLflow tracking/registry store
- `backend/data/mlflow-artifacts/` — MLflow artifact root
- `backend/data/artifacts/` — application artifact storage

Check it:

```bash
curl http://localhost:8000/health
curl http://localhost:8000/api/health/ready
```

API documentation: <http://localhost:8000/api/docs>

### 2. Frontend

```powershell
cd frontend
npm ci
npm run dev
```

Open <http://localhost:3000>. The default API URL is `http://localhost:8000/api`; override it with `NEXT_PUBLIC_API_URL` if needed.

### 3. First login

Register the first account. It becomes the system administrator and the owner of its workspace. Later registrations create their own workspaces; a workspace admin can add an existing account to their workspace from **Settings → Members**.

### 4. Smallest end-to-end path

1. **Projects → New project** — choose classification or regression and set the target column.
2. Open the project → **Datasets → Sample data** — create `Customer Churn` or `House Prices`.
3. **Training** — start a run and wait for completion.
4. **Model Registry** — open the new version, review the model card, add an approval note and approve it.
5. **Deployments → New deployment** — select the project, the approved model and version.
6. Open the deployment → **Playground → Send request**.
7. **Monitoring** — verify the request, latency, confidence and prediction distribution.
8. **Pipelines** — run a drift analysis, or use **Deployments → Drift**.
9. Submit ground-truth labels from the deployment's predictions tab to unlock performance metrics.
10. **Alerts & Incidents** — inspect, acknowledge and resolve alerts; open incidents or schedule retraining.

### Demo mode

Demo mode is enabled by default (`DEMO_MODE=true`). It provides:

- The two sample datasets above.
- Admin-only demo seeding that creates real projects, baseline and shifted dataset versions, alert rules and queued training jobs.
- An explicit **traffic simulation** action on a deployment. Simulation never starts automatically and every generated event is marked `simulated`.
- Synthetic labels can optionally be supplied during simulation. They are marked as simulated and are excluded from the "real label" story where the UI distinguishes them.

The demo API is available at `GET /api/demo/status`, `POST /api/demo/seed` and `POST /api/demo/simulate`. Seeding and simulation require an authenticated workspace admin; simulation also requires an active deployment.

---

## Configuration

All settings are environment variables; see [`.env.example`](.env.example). The backend reads `.env` from the repository root or `backend/`.

Important groups:

| Group | Variables |
| --- | --- |
| Core | `ENVIRONMENT`, `SECRET_KEY`, `CORS_ORIGINS`, `ALLOWED_HOSTS`, `API_PREFIX` |
| Database | `DATABASE_URL`, `AUTO_CREATE_TABLES` |
| MLflow | `MLFLOW_ENABLED`, `MLFLOW_TRACKING_URI`, `MLFLOW_ARTIFACT_ROOT`, `MLFLOW_UI_URL` |
| Storage | `STORAGE_BACKEND`, `ARTIFACT_DIR`, `S3_ENDPOINT_URL`, `S3_BUCKET`, S3 credentials |
| Jobs | `JOB_RUNNER` (`thread`, `sync`, `celery`), Redis/Celery URLs |
| Limits | Upload size, dataset rows/columns, prediction body, batch size, rate limits |
| Monitoring | `MIN_DRIFT_SAMPLES`, `DRIFT_ALPHA`, PSI/share thresholds, label minimums |
| Privacy | `CAPTURE_MONITORING_SAMPLES`, `MONITORING_SAMPLE_RATE`, `LOG_RAW_PREDICTION_INPUT` |
| Notifications | SMTP and Slack settings |
| Demo | `DEMO_MODE` |

Generate a production secret with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Never commit `.env` or real credentials.

### Database migrations

Local development can create tables automatically. For a controlled deployment:

```bash
cd backend
export AUTO_CREATE_TABLES=false
alembic upgrade head
```

The Docker backend entrypoint applies `alembic upgrade head` unless `RUN_MIGRATIONS=false`.

---

## Tests and quality gates

### Backend

```powershell
cd backend
$env:PYTHONPATH="."
$env:MLFLOW_DISABLE_AGENT_HINT="1"
.venv\Scripts\python.exe -m pytest tests -q
.venv\Scripts\python.exe -m ruff check app tests
```

Coverage includes:

- Password hashing, JWT access/refresh rotation, revocation and auth failures.
- Workspace RBAC, member management and admin-only actions.
- Dataset validation and CSV safeguards.
- Preprocessing/evaluation unit tests.
- Drift statistics (PSI/KS/chi-square), FDR, low-sample handling.
- Prediction schema, batch limits and invalid input behavior.
- Retraining comparison and promotion policy.
- Alert deduplication, minimum samples, severity and unobserved metrics.
- A full integration journey: dataset → training → MLflow artifacts → approval gate → deployment → predictions → monitoring → labels → drift → alerts → retraining → promotion/rollback → artifact tamper detection → audit.

### Frontend

```bash
cd frontend
npm run lint
npm run typecheck
npm run test:run
npm run build
```

### End-to-end

```bash
cd frontend
npx playwright install chromium   # once
npm run test:e2e
```

Playwright starts its own backend on `127.0.0.1:8010` and frontend on `127.0.0.1:3100`, using an isolated `backend/data/e2e` directory that is deleted before each run. The test covers registration, project creation, sample data, real training, registry approval, deployment, playground prediction, monitoring telemetry and the final registry/deployments state.

### CI

`.github/workflows/ci.yml` runs:

- Backend: dependency install, `ruff`, `pytest`.
- Frontend: `npm ci`, lint, typecheck, unit tests, production build.
- On pushes to `main`: Compose configuration validation and Docker image builds.

The workflow file is committed; its remote execution has not been observed from this environment.

---

## Security model

- **Passwords:** scrypt hashing with per-user salts via the Python standard library.
- **Sessions:** short-lived JWT access tokens and rotating refresh tokens; refresh tokens are stored hashed and can be revoked. Logout and password changes revoke sessions.
- **Transport:** access tokens are accepted via Bearer header or HttpOnly access cookie. Refresh is cookie-only. Set `COOKIE_SECURE=true` behind TLS.
- **Authorization:** every project, dataset, run, model, deployment, drift report, alert and job query is workspace-scoped. Admin-only actions are enforced server-side, not only hidden in the UI.
- **Uploads:** extension/content checks, configurable size limits, row/column limits, safe CSV parsing (no formula execution), duplicate-column detection and target validation. Uploaded code is never executed.
- **Artifacts:** model artifacts are loaded only from registered storage paths and verified against a SHA-256 digest. The API never accepts an arbitrary artifact path or executable payload.
- **Prediction input:** JSON schema validation, body-size limits, batch limits and rate limits. Raw input logging is off by default.
- **Database:** SQLAlchemy parameterization; no string-built SQL from user input.
- **Headers/CORS:** explicit allowed origins and hosts, security headers, request IDs.
- **Audit:** security-relevant mutations are recorded with actor, action, entity and metadata.
- **Secrets:** environment-only; no secret values are returned by the settings API.

This is a reference platform, not a certified security product. Review the hardening checklist in [docs/deployment.md](docs/deployment.md) before exposing it to the internet.

---

## Metrics and observability

The platform exposes two complementary metric surfaces:

1. **Product monitoring** in the UI/API: request volume, latency percentiles, errors, invalid inputs, confidence, prediction distribution, version usage, resources, data quality, drift and label-gated performance.
2. **Operational Prometheus metrics** at `/metrics`, with JSON logs carrying request IDs.

See [docs/metrics.md](docs/metrics.md) for definitions, Prometheus metric names, Grafana setup, drift statistics and alert semantics.

---

## Deployment

The full stack is defined in [`docker-compose.yml`](docker-compose.yml):

- FastAPI backend + Celery worker
- Next.js frontend
- PostgreSQL (application and MLflow databases)
- Redis (Celery broker/result backend)
- MinIO (MLflow and application artifacts)
- MLflow tracking server
- Prometheus + Grafana with provisioned datasource and dashboard

```bash
cp .env.example .env
# set SECRET_KEY and change default database/MinIO/Grafana passwords
docker compose up --build -d
```

Endpoints:

| Service | URL |
| --- | --- |
| Frontend | <http://localhost:3000> |
| API | <http://localhost:8000/api> |
| API docs | <http://localhost:8000/api/docs> |
| MLflow | <http://localhost:5000> |
| MinIO console | <http://localhost:9001> |
| Prometheus | <http://localhost:9090> |
| Grafana | <http://localhost:3001> |

> **Important:** this Compose stack was not run in the authoring environment because Docker was unavailable. The configuration, Dockerfiles, health checks, migrations and CI validation are included, but treat the first Compose run as something to verify. [docs/deployment.md](docs/deployment.md) explains the topology, a low-cost single-VM setup, backup guidance and known limitations.

---

## Honest limitations

- **Local verified mode is single-process oriented.** SQLite plus the in-process thread runner is suitable for development and evaluation, not for multi-replica production. Use Postgres and Celery for that.
- **Thread job runner is not durable.** A process restart can lose queued or running local jobs. Celery is the durable option.
- **Rate limiting is in-process.** With multiple API replicas, each replica enforces its own counters. Use a shared Redis-backed limiter or an ingress limiter at scale.
- **MLflow model flavors.** Models are logged with MLflow's sklearn flavor. Loading relies on trusted, integrity-checked artifacts; do not point the platform at untrusted artifact stores.
- **Explainability is model-dependent.** SHAP support and performance vary by estimator and feature type; unsupported cases return explicit warnings rather than fabricated attributions.
- **Drift tests are statistical evidence, not proof.** Low-sample windows, multiple comparisons and missing features are surfaced explicitly. Concept drift requires labels.
- **Demo data is synthetic.** Real training and prediction code runs on it, but the data does not represent any real population.
- **Docker/Compose, Postgres, Redis, MinIO, MLflow server, Prometheus and Grafana were not executed locally.** Only the SQLite/local-filesystem/thread-runner path was verified end-to-end here.
- **No TLS termination is included.** Put the stack behind a reverse proxy or managed load balancer and set secure cookies/CORS/hosts accordingly.
- **No built-in backup automation.** Back up Postgres, MinIO and the application data volume as described in the deployment guide.

---

## Acceptance checklist

| Requirement | Where |
| --- | --- |
| Launch from documentation | This README, [docs/deployment.md](docs/deployment.md) |
| Register/login and create a project | `/register`, `/login`, `/projects` |
| Upload/inspect a dataset | Project → Datasets, or `/api/projects/{id}/datasets/upload` |
| Train a real model and view metrics | Project → Training, `/experiments` |
| Register and version a model | `/registry` |
| Deploy an approved model | `/deployments` |
| Predict via API and UI | Deployment → Playground, `POST /api/deployments/{id}/predict`, public slug endpoint |
| View real request/latency/error data | `/monitoring` |
| Generate a drift report | `/monitoring` or deployment drift panel, `POST /api/drift/analyze` |
| Evaluate performance with labels | Deployment → Predictions/Labels, `POST /api/deployments/{id}/performance/evaluate` |
| Trigger and acknowledge an alert | `/alerts` plus alert rules and simulated/real conditions |
| Run retraining comparison | Deployment → Retraining, `/pipelines` |
| Reproduce with tests | Backend pytest, frontend Vitest, Playwright E2E, CI workflow |

---

## Documentation index

- [Deployment guide](docs/deployment.md) — Compose topology, low-cost VM sizing, migrations, backups, hardening, troubleshooting.
- [Metrics and monitoring](docs/metrics.md) — product metrics, Prometheus metrics, drift statistics, performance labels, alert rules.
- API reference — generated at `/api/docs` and `/api/redoc`.

---

## License

Released under the [MIT License](LICENSE).
