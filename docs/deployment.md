# Deployment guide

This guide covers the included Docker Compose stack, a low-cost single-VM setup, configuration, backups and production hardening.

> **Verification status:** Docker was not available in the authoring environment. The Compose file, Dockerfiles, health checks, migrations and CI validation are committed, but the full container stack was **not executed locally**. The verified local path uses SQLite, local filesystem artifacts and the thread job runner (see the root [README](../README.md)). Treat your first `docker compose up` as a deployment to validate, not a proven result.

---

## 1. Compose topology

| Service | Purpose | Persistence |
| --- | --- | --- |
| `frontend` | Next.js standalone server | Image only |
| `backend` | FastAPI API, runs Alembic on start | `backend-data` volume |
| `worker` | Celery worker for training, drift, retraining and simulation jobs | `backend-data` volume |
| `postgres` | Application DB (`mlops`) and MLflow DB (`mlflow`) | `postgres-data` volume |
| `redis` | Celery broker and result backend | `redis-data` volume |
| `minio` | S3-compatible artifact store | `minio-data` volume |
| `minio-init` | Creates the `mlflow` and `mlops-artifacts` buckets, then exits | None |
| `mlflow` | MLflow tracking server with S3 artifact serving | Postgres + MinIO |
| `prometheus` | Scrapes `backend:8000/metrics` | `prometheus-data` volume |
| `grafana` | Provisioned Prometheus datasource and dashboard | `grafana-data` volume |

The backend container runs `alembic upgrade head` through `backend/docker-entrypoint.sh`. The worker sets `RUN_MIGRATIONS=false` so only one service migrates.

Postgres is initialised with `infra/postgres/init.sql`, which creates the separate `mlflow` database. That script runs **only on first initialisation** of an empty `postgres-data` volume.

---

## 2. Prerequisites

- Docker Engine 24+ with the Compose v2 plugin
- 4 GB RAM minimum; 8 GB recommended for training and the full observability stack
- 20–40 GB free disk, depending on dataset and artifact retention
- A hostname and TLS termination for anything beyond local evaluation

---

## 3. First run

### 3.1 Create the environment file

```bash
cp .env.example .env
```

Set at minimum:

```dotenv
SECRET_KEY=<output of: python -c "import secrets; print(secrets.token_urlsafe(48))">
POSTGRES_PASSWORD=<strong-password>
MINIO_ROOT_USER=<non-default-user>
MINIO_ROOT_PASSWORD=<strong-password>
GRAFANA_ADMIN_PASSWORD=<strong-password>
CORS_ORIGINS=http://localhost:3000
ALLOWED_HOSTS=localhost,127.0.0.1,backend
NEXT_PUBLIC_API_URL=http://localhost:8000/api
```

For a remote host, replace `localhost` with the public hostname and use HTTPS URLs:

```dotenv
CORS_ORIGINS=https://mlops.example.com
ALLOWED_HOSTS=mlops.example.com,backend
COOKIE_SECURE=true
NEXT_PUBLIC_API_URL=https://mlops.example.com/api
```

`NEXT_PUBLIC_API_URL` is a **build-time** value for Next.js. If you change it, rebuild the frontend image:

```bash
docker compose build frontend
docker compose up -d frontend
```

### 3.2 Start the stack

```bash
docker compose up --build -d
docker compose ps
```

First start can take several minutes: Python and Node dependencies are installed during the image builds, MLflow initialises its schema, and buckets are created.

### 3.3 Verify

```bash
curl http://localhost:8000/health
curl http://localhost:8000/api/health/ready
curl http://localhost:8000/metrics | head
```

Expected readiness checks:

- `database` — `ok`
- `storage` — `ok` (MinIO/S3)
- `mlflow` — `ok`, or a non-blocking degradation note if tracking is down
- `job_runner` — `celery`

Open:

| Service | URL |
| --- | --- |
| Frontend | <http://localhost:3000> |
| API docs | <http://localhost:8000/api/docs> |
| MLflow | <http://localhost:5000> |
| MinIO console | <http://localhost:9001> |
| Prometheus | <http://localhost:9090> |
| Grafana | <http://localhost:3001> |

Grafana uses the `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` values from `.env`. The Prometheus datasource and the Aperture overview dashboard are provisioned automatically from `infra/grafana/`.

### 3.4 Logs

```bash
docker compose logs -f backend
docker compose logs -f worker
docker compose logs -f mlflow
docker compose logs -f minio-init
```

Backend logs are JSON with `request_id`, `method`, `path`, `status` and `duration_ms` fields. Use the `X-Request-ID` response header to correlate a failed request.

---

## 4. Database migrations

The backend container applies migrations on startup. To run them manually:

```bash
docker compose exec backend alembic upgrade head
docker compose exec backend alembic current
```

To disable automatic migration in a controlled release process:

```dotenv
RUN_MIGRATIONS=false
```

Then run `alembic upgrade head` as a separate deployment step before starting the new backend revision.

The initial migration is `backend/alembic/versions/5751e23cd398_initial_schema.py`. It was verified to upgrade and downgrade on a fresh SQLite database locally; the same migration is used by Compose against Postgres.

---

## 5. Low-cost deployment options

### Option A — single VM with Docker Compose (simplest)

A reasonable low-cost reference topology:

- 2 vCPU / 4 GB RAM with 2–4 GB swap for light demo use
- 4 vCPU / 8 GB RAM recommended if you train regularly or keep Prometheus/Grafana running
- 40 GB SSD
- Ubuntu 24.04 LTS or equivalent
- Docker Engine + Compose plugin
- Caddy, Nginx or Traefik in front for TLS

Sizing is guidance, not a benchmark: training memory depends on dataset size, algorithm, Optuna trials and XGBoost thread usage. Monitor `mlops_active_deployments`, container memory and host disk. Artifact growth is usually the first disk pressure source.

Minimal host steps:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER"
# log out and back in
git clone <your-repository-url> aperture-mlops
cd aperture-mlops
cp .env.example .env
# edit .env with production values
docker compose up --build -d
```

Put a reverse proxy in front and forward:

- `/` → `127.0.0.1:3000`
- `/api/` → `127.0.0.1:8000/api/`
- optionally `/mlflow/` → `127.0.0.1:5000/` (protect it; MLflow has no built-in multi-tenant auth here)

Do not expose Postgres, Redis, MinIO, Prometheus or Grafana directly to the public internet. The Compose file publishes their ports for local convenience; remove or bind them to `127.0.0.1` in a production override.

### Option B — managed data services + containers

For a more durable small deployment, use:

- Managed PostgreSQL for both the application and MLflow databases (or two databases on one instance).
- Managed Redis for Celery.
- S3-compatible object storage for MLflow and application artifacts.
- One container host for `backend`, `worker`, `frontend` and optionally `mlflow`.

Set the corresponding environment variables and omit the local `postgres`, `redis`, `minio` and `minio-init` services with a Compose override. Example override skeleton:

```yaml
services:
  backend:
    environment:
      DATABASE_URL: postgresql+psycopg2://USER:PASSWORD@DB_HOST:5432/mlops
      CELERY_BROKER_URL: rediss://...
      CELERY_RESULT_BACKEND: rediss://...
      STORAGE_BACKEND: s3
      S3_ENDPOINT_URL: https://s3.example.com
      S3_BUCKET: mlops-artifacts
      S3_ACCESS_KEY_ID: ...
      S3_SECRET_ACCESS_KEY: ...
      MLFLOW_TRACKING_URI: http://mlflow:5000
  worker:
    environment:
      DATABASE_URL: postgresql+psycopg2://USER:PASSWORD@DB_HOST:5432/mlops
      CELERY_BROKER_URL: rediss://...
      CELERY_RESULT_BACKEND: rediss://...
      STORAGE_BACKEND: s3
      S3_ENDPOINT_URL: https://s3.example.com
      S3_BUCKET: mlops-artifacts
      S3_ACCESS_KEY_ID: ...
      S3_SECRET_ACCESS_KEY: ...
  postgres: { profiles: ["local-only"] }
  redis: { profiles: ["local-only"] }
  minio: { profiles: ["local-only"] }
  minio-init: { profiles: ["local-only"] }
```

This skeleton is illustrative; validate the override against your provider and Compose version before relying on it. Managed services were not exercised from this repository.

### Option C — split frontend and backend

The frontend is a standard Next.js standalone build and can be hosted on any Node host or a frontend platform. The API, worker and MLflow need a persistent container environment plus the data services above. Because `NEXT_PUBLIC_API_URL` is baked at build time, set it to the public API URL for each environment and rebuild.

Serverless-only hosting is a poor fit for the current worker model: training and drift jobs are long-running and write local caches/artifacts in addition to MLflow and the database.

---

## 6. Backups and restore

### Postgres

```bash
docker compose exec -T postgres pg_dump -U mlops mlops > mlops-backup.sql
docker compose exec -T postgres pg_dump -U mlops mlflow > mlflow-backup.sql
```

Restore into a fresh database:

```bash
cat mlops-backup.sql | docker compose exec -T postgres psql -U mlops -d mlops
cat mlflow-backup.sql | docker compose exec -T postgres psql -U mlops -d mlflow
```

### Application data volume

```bash
docker compose exec -T backend tar -czf - -C /app data > backend-data.tar.gz
```

Restore:

```bash
cat backend-data.tar.gz | docker compose exec -T backend tar -xzf - -C /app
```

### MinIO artifacts

Use the MinIO client against the running service:

```bash
docker run --rm --network aperture-mlops_default \
  -e MC_HOST_local=http://MINIO_USER:MINIO_PASSWORD@minio:9000 \
  minio/mc mirror local/mlflow /backup/mlflow
```

Back up both `mlflow` and `mlops-artifacts` buckets. A database backup without matching artifacts leaves model versions that cannot be loaded.

### Retention

- `RETENTION_DAYS` (default 90) controls prediction-event retention.
- `FEATURE_SAMPLE_RETENTION_DAYS` (default 30) controls captured feature samples used by drift and data quality.
- Prometheus retains 15 days in the included configuration.
- Plan artifact retention separately; model versions are immutable and deliberately cannot be deleted through the API.

---

## 7. Production hardening checklist

- [ ] Generate a unique `SECRET_KEY`; never use the development default.
- [ ] Change `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` and `GRAFANA_ADMIN_PASSWORD`.
- [ ] Terminate TLS at a reverse proxy or load balancer; set `COOKIE_SECURE=true`.
- [ ] Restrict `CORS_ORIGINS` and `ALLOWED_HOSTS` to real hostnames.
- [ ] Set `ENVIRONMENT=production`, `DEBUG=false`, `AUTO_CREATE_TABLES=false`.
- [ ] Run `alembic upgrade head` as a release step.
- [ ] Use Postgres, Redis and S3/MinIO; do not run SQLite or the thread runner in production.
- [ ] Keep `LOG_RAW_PREDICTION_INPUT=false` unless you have a reviewed need and a lawful basis.
- [ ] Set `DEMO_MODE=false` for a real deployment.
- [ ] Configure SMTP/Slack if you want external alert delivery; test via Settings.
- [ ] Protect MLflow and Grafana behind authentication; neither is exposed with per-user RBAC by this application.
- [ ] Bind internal service ports to `127.0.0.1` or remove their `ports:` mappings in production.
- [ ] Pin container image tags instead of `latest` for MinIO, `mc`, Prometheus and Grafana.
- [ ] Configure backups for Postgres and object storage, and test a restore.
- [ ] Monitor disk usage for artifacts and Prometheus.
- [ ] Put rate limiting at the ingress if you run more than one API replica; the built-in limiter is per process.
- [ ] Rotate deployment API keys and workspace credentials on a schedule.
- [ ] Review audit events after administrative changes.

---

## 8. Scaling notes

- **API replicas:** safe with Postgres, but rate limits and model caches are per process. Use an ingress/shared limiter for global limits.
- **Workers:** increase Celery concurrency or run more worker containers. Keep `RUN_MIGRATIONS=false` on workers.
- **MLflow:** the included server uses Postgres metadata and S3 artifacts. For heavy use, give MLflow its own managed database and object store, and consider a dedicated MLflow deployment.
- **Artifacts:** S3/MinIO scales better than a shared filesystem. The local backend uses `ARTIFACT_DIR`.
- **Prometheus/Grafana:** the included stack is a single instance. For long retention or HA, use managed observability.
- **Training memory:** Optuna trials and XGBoost can consume substantial RAM. Limit worker concurrency before increasing host size blindly.

---

## 9. Troubleshooting

### `Set SECRET_KEY in .env`

Compose uses `${SECRET_KEY:? ...}`. Copy `.env.example` to `.env` and set a real value.

### MLflow database missing

`infra/postgres/init.sql` only runs on the first initialisation of an empty Postgres volume. If the volume predates the script:

```bash
docker compose exec postgres psql -U mlops -d mlops -c "CREATE DATABASE mlflow OWNER mlops;"
docker compose restart mlflow
```

Or recreate the volume (destroys data):

```bash
docker compose down -v
docker compose up --build -d
```

### Backend not ready because storage is down

Check `docker compose logs minio minio-init`. Both buckets must exist and the credentials in `.env` must match the backend and MLflow environments.

### Frontend calls the wrong API URL

`NEXT_PUBLIC_API_URL` is embedded at build time. Update `.env`, rebuild the frontend image and recreate the container. Browser calls must also pass `CORS_ORIGINS`.

### Login works but requests return 401/403

- Confirm cookies are enabled and `COOKIE_SECURE` matches the scheme (HTTPS vs HTTP).
- Confirm the browser origin is listed in `CORS_ORIGINS`.
- Confirm the user is a member of the selected workspace.
- Clear stale cookies and log in again.

### Jobs stay queued

Check `docker compose logs worker`. Verify Redis is healthy and the worker uses the same `CELERY_BROKER_URL` as the backend. In local mode, `JOB_RUNNER=thread` requires the API process to stay alive.

### MLflow is degraded but predictions work

MLflow is intentionally non-critical for serving. Readiness reports the degradation without marking the API unready. Training runs will record the condition; fix the MLflow service before starting new training jobs.

### `docker compose config` fails

Set `SECRET_KEY` in the environment or `.env` first. CI does this explicitly when validating the Compose file.
