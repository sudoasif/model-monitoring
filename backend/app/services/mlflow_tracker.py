from __future__ import annotations

import json
import logging
import tempfile
from pathlib import Path
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Experiment, Project

logger = logging.getLogger(__name__)


class MLflowTracker:
    """Thin, failure-tolerant wrapper around MLflow tracking and model registry.

    MLflow is the experiment-tracking/registry backend. The application database
    keeps denormalized read models and links to MLflow run/version identifiers so
    the UI can stay fast without inventing tracking data. If MLflow is
    unavailable, training remains usable, the run records that fact explicitly,
    and the UI reports which backend was used.
    """

    def __init__(self) -> None:
        self.enabled = settings.mlflow_enabled
        self.last_error: str | None = None
        self._configured = False
        self._client: Any | None = None

    @property
    def configured_tracking_uri(self) -> str:
        return settings.mlflow_tracking_uri

    def _configure(self) -> None:
        if not self.enabled or self._configured:
            return
        import mlflow
        from mlflow.tracking import MlflowClient

        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        self._client = MlflowClient()
        self._configured = True

    @property
    def client(self) -> Any:
        self._configure()
        if self._client is None:
            raise RuntimeError("MLflow is disabled")
        return self._client

    def health(self) -> dict[str, Any]:
        if not self.enabled:
            return {"status": "disabled", "tracking_uri": settings.mlflow_tracking_uri}
        try:
            self.client.search_experiments(max_results=1)
            return {
                "status": "ok",
                "tracking_uri": settings.mlflow_tracking_uri,
                "ui_url": settings.mlflow_ui_url or None,
            }
        except Exception as exc:
            self.last_error = str(exc)[:300]
            return {
                "status": "error",
                "tracking_uri": settings.mlflow_tracking_uri,
                "error": self.last_error,
            }

    def _artifact_location(self) -> str | None:
        if settings.mlflow_tracking_uri.startswith(("sqlite:", "file:")):
            return settings.mlflow_artifact_root
        return None

    def ensure_experiment(self, db: Session, project: Project) -> Experiment:
        experiment = db.scalar(
            select(Experiment).where(Experiment.project_id == project.id).order_by(Experiment.created_at)
        )
        if experiment is None:
            experiment = Experiment(
                project_id=project.id,
                name="Default",
                description=f"Experiments for {project.name}",
            )
            db.add(experiment)
            db.flush()
        if experiment.mlflow_experiment_id or not self.enabled:
            db.commit()
            return experiment
        try:
            name = self.mlflow_experiment_name(project)
            existing = self.client.get_experiment_by_name(name)
            if existing:
                experiment.mlflow_experiment_id = existing.experiment_id
            else:
                experiment.mlflow_experiment_id = self.client.create_experiment(
                    name, artifact_location=self._artifact_location()
                )
            db.commit()
        except Exception as exc:
            self.last_error = str(exc)[:300]
            logger.warning("mlflow_ensure_experiment_failed", exc_info=True)
            db.rollback()
            experiment = db.scalar(select(Experiment).where(Experiment.project_id == project.id))
        return experiment

    @staticmethod
    def mlflow_experiment_name(project: Project) -> str:
        return f"{project.slug}-{project.id[:8]}"

    @staticmethod
    def mlflow_model_name(project: Project) -> str:
        return f"{project.slug}-{project.id[:8]}"

    def create_run(
        self, experiment_id: str | None, run_name: str, tags: dict[str, Any] | None = None
    ) -> str | None:
        if not self.enabled or not experiment_id:
            return None
        try:
            run = self.client.create_run(
                experiment_id,
                run_name=run_name[:250],
                tags={key: str(value)[:5000] for key, value in (tags or {}).items()},
            )
            return run.info.run_id
        except Exception as exc:
            self.last_error = str(exc)[:300]
            logger.warning("mlflow_create_run_failed", exc_info=True)
            return None

    def log_params(self, run_id: str | None, params: dict[str, Any]) -> None:
        if not run_id or not self.enabled:
            return
        for key, value in params.items():
            if value is None:
                continue
            try:
                if isinstance(value, (dict, list, tuple)):
                    value = json.dumps(value, default=str)[:5000]
                self.client.log_param(run_id, str(key)[:250], str(value)[:5000])
            except Exception:
                logger.warning("mlflow_log_param_failed", extra={"extra_fields": {"param": key}})
                continue

    def log_metrics(self, run_id: str | None, metrics: dict[str, Any]) -> None:
        if not run_id or not self.enabled:
            return
        clean: dict[str, float] = {}
        for key, value in metrics.items():
            try:
                if isinstance(value, bool) or (isinstance(value, (int, float)) and value == value):
                    clean[str(key)] = float(value)
            except (TypeError, ValueError):
                continue
        if clean:
            try:
                for key, value in clean.items():
                    self.client.log_metric(run_id, key, value)
            except Exception:
                logger.warning("mlflow_log_metrics_failed", exc_info=True)

    def log_tags(self, run_id: str | None, tags: dict[str, Any]) -> None:
        if not run_id or not self.enabled:
            return
        try:
            for key, value in tags.items():
                self.client.set_tag(run_id, str(key)[:250], str(value)[:5000])
        except Exception:
            logger.warning("mlflow_log_tags_failed", exc_info=True)

    def log_json(self, run_id: str | None, name: str, payload: Any, artifact_path: str | None = None) -> None:
        if not run_id or not self.enabled:
            return
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / name
                path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
                self.client.log_artifact(run_id, str(path), artifact_path=artifact_path)
        except Exception:
            logger.warning("mlflow_log_artifact_failed", exc_info=True)

    def log_artifact(self, run_id: str | None, local_path: str, artifact_path: str | None = None) -> None:
        if not run_id or not self.enabled:
            return
        try:
            self.client.log_artifact(run_id, local_path, artifact_path=artifact_path)
        except Exception:
            logger.warning("mlflow_log_file_failed", exc_info=True)

    def log_model(
        self,
        run_id: str | None,
        pipeline: Any,
        sample: pd.DataFrame,
    ) -> str | None:
        if not run_id or not self.enabled:
            return None
        try:
            import mlflow
            import mlflow.sklearn
            from mlflow.models import infer_signature

            signature = infer_signature(sample, pipeline.predict(sample.head(5)))
            with mlflow.start_run(run_id=run_id):
                info = mlflow.sklearn.log_model(
                    pipeline,
                    name="model",
                    serialization_format="cloudpickle",
                    signature=signature,
                    input_example=sample.head(3),
                )
            return info.model_uri
        except Exception as exc:
            self.last_error = str(exc)[:300]
            logger.warning("mlflow_log_model_failed", exc_info=True)
            return None

    def register_model(
        self,
        *,
        project: Project,
        local_version: int,
        run_id: str | None,
        description: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> tuple[str | None, int | None]:
        if not run_id or not self.enabled or not settings.mlflow_registry_enabled:
            return None, None
        model_name = self.mlflow_model_name(project)
        source = f"runs:/{run_id}/model"
        try:
            try:
                self.client.get_registered_model(model_name)
            except Exception:
                self.client.create_registered_model(
                    model_name,
                    tags={"project_id": project.id, "local_name": project.name},
                    description=f"Registered model for {project.name}",
                )
            version = self.client.create_model_version(
                name=model_name,
                source=source,
                run_id=run_id,
                tags={"local_version": str(local_version), "project_id": project.id},
                description=description[:4000],
            )
            self.client.set_registered_model_alias(model_name, "candidate", version.version)
            if metadata:
                for key, value in metadata.items():
                    try:
                        self.client.set_model_version_tag(model_name, version.version, key, str(value)[:5000])
                    except Exception:
                        continue
            return f"models:/{model_name}/{version.version}", int(version.version)
        except Exception as exc:
            self.last_error = str(exc)[:300]
            logger.warning("mlflow_register_model_failed", exc_info=True)
            return None, None

    def set_alias(self, project: Project, mlflow_version: int | None, alias: str) -> None:
        if not self.enabled or not mlflow_version:
            return
        model_name = self.mlflow_model_name(project)
        try:
            self.client.set_registered_model_alias(model_name, alias, str(mlflow_version))
        except Exception:
            logger.warning("mlflow_set_alias_failed", extra={"extra_fields": {"alias": alias}})

    def remove_alias(self, project: Project, alias: str) -> None:
        if not self.enabled:
            return
        try:
            self.client.delete_registered_model_alias(self.mlflow_model_name(project), alias)
        except Exception:
            pass

    def end_run(self, run_id: str | None, status: str = "FINISHED") -> None:
        if not run_id or not self.enabled:
            return
        try:
            self.client.set_terminated(run_id, status=status)
        except Exception:
            logger.warning("mlflow_end_run_failed", exc_info=True)

    def run_link(self, run_id: str | None) -> str | None:
        if not run_id or not settings.mlflow_ui_url:
            return None
        return f"{settings.mlflow_ui_url.rstrip('/')}/#/experiments/_/runs/{run_id}"


tracker = MLflowTracker()
