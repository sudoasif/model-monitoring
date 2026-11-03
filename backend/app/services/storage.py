from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from app.config import settings
from app.errors import AppError

logger = logging.getLogger(__name__)


class StorageService:
    """Artifact storage abstraction: local filesystem or S3-compatible (MinIO)."""

    def __init__(self) -> None:
        self.backend = settings.storage_backend.lower()
        self.root = Path(settings.artifact_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._s3 = None
        if self.backend == "s3":
            self._init_s3()

    def _init_s3(self) -> None:
        import boto3
        from botocore.config import Config

        self._s3 = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url or None,
            aws_access_key_id=settings.s3_access_key_id or None,
            aws_secret_access_key=settings.s3_secret_access_key or None,
            region_name=settings.s3_region,
            config=Config(signature_version="s3v4", connect_timeout=3, retries={"max_attempts": 2}),
        )

    def _safe_key(self, key: str) -> str:
        cleaned = key.replace("\\", "/").lstrip("/")
        if ".." in cleaned.split("/") or not cleaned or any(part == "" for part in cleaned.split("/")):
            raise AppError(400, "invalid_storage_key", "Invalid artifact key.")
        return cleaned

    def _local_path(self, key: str) -> Path:
        cleaned = self._safe_key(key)
        target = (self.root / cleaned).resolve()
        if not str(target).startswith(str(self.root)):
            raise AppError(400, "invalid_storage_key", "Invalid artifact key.")
        return target

    def save_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        cleaned = self._safe_key(key)
        if self.backend == "s3":
            assert self._s3 is not None
            self._s3.put_object(
                Bucket=settings.s3_bucket, Key=cleaned, Body=data, ContentType=content_type
            )
            return cleaned
        target = self._local_path(cleaned)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_path = tempfile.mkstemp(dir=str(target.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, target)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        return cleaned

    def save_file(self, key: str, source: Path, content_type: str = "application/octet-stream") -> str:
        with open(source, "rb") as handle:
            return self.save_bytes(key, handle.read(), content_type)

    def read_bytes(self, key: str) -> bytes:
        cleaned = self._safe_key(key)
        if self.backend == "s3":
            assert self._s3 is not None
            response = self._s3.get_object(Bucket=settings.s3_bucket, Key=cleaned)
            return response["Body"].read()
        path = self._local_path(cleaned)
        if not path.exists():
            raise AppError(404, "artifact_missing", "The requested artifact is not available.")
        return path.read_bytes()

    def materialize(self, key: str) -> Path:
        """Return a local path for an artifact. S3 objects are cached locally."""
        cleaned = self._safe_key(key)
        if self.backend == "local":
            path = self._local_path(cleaned)
            if not path.exists():
                raise AppError(404, "artifact_missing", "The requested artifact is not available.")
            return path
        cache_dir = settings.data_dir / "cache" / "artifacts"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = cache_dir / cleaned.replace("/", "__")
        if not cache_path.exists():
            data = self.read_bytes(cleaned)
            cache_path.write_bytes(data)
        return cache_path

    def delete(self, key: str) -> None:
        cleaned = self._safe_key(key)
        if self.backend == "s3":
            assert self._s3 is not None
            self._s3.delete_object(Bucket=settings.s3_bucket, Key=cleaned)
            return
        path = self._local_path(cleaned)
        if path.exists():
            path.unlink()

    def exists(self, key: str) -> bool:
        try:
            cleaned = self._safe_key(key)
            if self.backend == "s3":
                assert self._s3 is not None
                self._s3.head_object(Bucket=settings.s3_bucket, Key=cleaned)
                return True
            return self._local_path(cleaned).exists()
        except Exception:
            return False

    def check_health(self) -> dict[str, Any]:
        try:
            if self.backend == "s3":
                assert self._s3 is not None
                self._s3.head_bucket(Bucket=settings.s3_bucket)
                return {"status": "ok", "backend": "s3", "bucket": settings.s3_bucket}
            test_key = ".health/probe.txt"
            payload = f"ok-{os.getpid()}".encode()
            self.save_bytes(test_key, payload)
            valid = self.read_bytes(test_key) == payload
            self.delete(test_key)
            return {"status": "ok" if valid else "degraded", "backend": "local", "path": str(self.root)}
        except Exception as exc:
            logger.warning("storage_health_check_failed", exc_info=True)
            return {"status": "error", "backend": self.backend, "error": str(exc)[:200]}

    def save_upload_stream(self, key: str, stream: Any, max_bytes: int) -> tuple[str, int, str]:
        """Persist a stream while enforcing an absolute byte limit."""
        import hashlib

        cleaned = self._safe_key(key)
        target = self._local_path(cleaned)
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        total = 0
        fd, temp_path = tempfile.mkstemp(dir=str(target.parent), suffix=".upload")
        try:
            with os.fdopen(fd, "wb") as handle:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise AppError(
                            413,
                            "file_too_large",
                            f"File exceeds the {max_bytes // (1024 * 1024)} MB upload limit.",
                        )
                    digest.update(chunk)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            if self.backend == "s3":
                assert self._s3 is not None
                with open(temp_path, "rb") as handle:
                    self._s3.put_object(
                        Bucket=settings.s3_bucket,
                        Key=cleaned,
                        Body=handle,
                        ContentType="text/csv",
                    )
                os.unlink(temp_path)
            else:
                os.replace(temp_path, target)
            return cleaned, total, digest.hexdigest()
        finally:
            if os.path.exists(temp_path):
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass


storage = StorageService()
