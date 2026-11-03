from __future__ import annotations

from celery import Celery

from app.config import settings

celery_app = Celery(
    "aperture_mlops",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=["app.workers.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_reject_on_worker_lost=True,
    broker_connection_retry_on_startup=True,
    task_track_started=True,
    task_time_limit=60 * 60,
    task_soft_time_limit=60 * 55,
    result_expires=60 * 60 * 24,
)
