from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from typing import Any

from app.config import settings
from app.errors import RateLimitError

logger = logging.getLogger(__name__)


class RateLimiter:
    """Fixed-window rate limiter.

    Uses Redis when configured (multi-instance deployments); otherwise falls
    back to process-local memory. Redis failures fail open so prediction
    availability is preserved, and the event is logged for operators.
    """

    def __init__(self) -> None:
        self._memory: dict[str, tuple[int, float]] = defaultdict(lambda: (0, 0.0))
        self._lock = threading.Lock()
        self._redis: Any | None = None
        if settings.redis_url:
            try:
                import redis

                self._redis = redis.Redis.from_url(
                    settings.redis_url, socket_timeout=0.4, socket_connect_timeout=0.4, decode_responses=True
                )
                self._redis.ping()
                logger.info("rate_limiter_redis_connected")
            except Exception:
                logger.warning("rate_limiter_redis_unavailable_fallback_memory", exc_info=True)
                self._redis = None

    def hit(self, key: str, limit: int, window_seconds: int = 60) -> dict[str, int]:
        if limit <= 0:
            return {"remaining": limit, "retry_after": 0}
        if self._redis is not None:
            try:
                redis_key = f"mlops:rl:{key}:{int(time.time() // window_seconds)}"
                count = int(self._redis.incr(redis_key))
                if count == 1:
                    self._redis.expire(redis_key, window_seconds + 1)
                if count > limit:
                    raise RateLimitError(window_seconds)
                return {"remaining": limit - count, "retry_after": 0}
            except RateLimitError:
                raise
            except Exception:
                logger.warning("rate_limiter_redis_error_fail_open", exc_info=True)

        now = time.monotonic()
        with self._lock:
            count, reset_at = self._memory[key]
            if reset_at < now:
                count, reset_at = 1, now + window_seconds
                self._memory[key] = (count, reset_at)
            else:
                count += 1
                self._memory[key] = (count, reset_at)
            if count > limit:
                retry = max(1, int(reset_at - now))
                raise RateLimitError(retry)
            return {"remaining": limit - count, "retry_after": 0}

    def reset(self) -> None:
        with self._lock:
            self._memory.clear()


limiter = RateLimiter()
