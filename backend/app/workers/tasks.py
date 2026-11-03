from __future__ import annotations

import logging

from app.workers.celery_app import celery_app

logger = logging.getLogger(__name__)


@celery_app.task(
    name="app.workers.tasks.run_pipeline_job",
    bind=True,
    max_retries=1,
    acks_late=True,
)
def run_pipeline_job(self, job_id: str) -> str:
    """Execute a durable pipeline job inside the Celery worker.

    Retries are deliberately handled at the pipeline level as well, because a
    retry must reuse the same audit trail and job record rather than create a
    second history entry.
    """
    from app.services.jobs import execute_job

    logger.info("celery_pipeline_job_started", extra={"extra_fields": {"job_id": job_id}})
    execute_job(job_id)
    logger.info("celery_pipeline_job_finished", extra={"extra_fields": {"job_id": job_id}})
    return job_id
