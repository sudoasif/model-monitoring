from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.database import SessionLocal
from app.models import PipelineJob
from app.observability import BACKGROUND_JOBS_IN_PROGRESS
from app.utils import utcnow

logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mlops-job")


def execute_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(PipelineJob, job_id)
        if not job:
            logger.error("pipeline_job_missing", extra={"extra_fields": {"job_id": job_id}})
            return
        job_type = job.job_type
    finally:
        db.close()
    BACKGROUND_JOBS_IN_PROGRESS.inc()
    try:
        if job_type in {"training", "retraining"}:
            from app.services.retraining import run_retraining_job

            if job_type == "retraining":
                run_retraining_job(job_id)
            else:
                from app.services.training import run_training_job

                run_training_job(job_id)
        elif job_type == "drift_analysis":
            from app.services.drift import run_drift_job

            run_drift_job(job_id)
        elif job_type == "simulation":
            from app.services.demo import run_simulation_job

            run_simulation_job(job_id)
        else:
            raise RuntimeError(f"Unknown job type: {job_type}")
    except Exception:
        logger.exception("background_job_unhandled_error", extra={"extra_fields": {"job_id": job_id}})
        db = SessionLocal()
        try:
            job = db.get(PipelineJob, job_id)
            if job and job.status not in {"succeeded", "failed", "cancelled"}:
                job.status = "failed"
                job.stage = "failed"
                job.error = "The background job crashed before completing. Check server logs."
                job.finished_at = utcnow()
                db.commit()
        finally:
            db.close()
    finally:
        BACKGROUND_JOBS_IN_PROGRESS.dec()


def dispatch_job(job_id: str) -> None:
    """Dispatch to Celery when configured, with a local thread fallback.

    Local development intentionally defaults to in-process threads so the
    platform works without Redis. Docker Compose uses a Celery worker.
    """
    mode = settings.job_runner.lower()
    if mode == "sync":
        execute_job(job_id)
        return
    if mode == "celery":
        try:
            from app.workers.celery_app import celery_app

            result = celery_app.send_task("app.workers.tasks.run_pipeline_job", args=[job_id])
            db = SessionLocal()
            try:
                job = db.get(PipelineJob, job_id)
                if job:
                    job.celery_task_id = result.id
                    db.commit()
            finally:
                db.close()
            return
        except Exception:
            logger.exception("celery_dispatch_failed_falling_back_to_thread")
            db = SessionLocal()
            try:
                job = db.get(PipelineJob, job_id)
                if job:
                    job.logs = (job.logs + "[dispatch] Celery unavailable; fell back to a local worker thread.\n")[-120000:]
                    db.commit()
            finally:
                db.close()
    _executor.submit(execute_job, job_id)
