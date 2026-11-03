from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import UnauthorizedError
from app.models import RefreshToken, User

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 64


def hash_password(password: str) -> str:
    if not password or len(password.encode("utf-8")) > 512:
        raise ValueError("Invalid password length")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, digest_b64 = encoded.split("$")
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def _now() -> datetime:
    return datetime.now(UTC)


def create_access_token(user: User) -> tuple[str, int]:
    expires_in = settings.access_token_minutes * 60
    payload = {
        "sub": user.id,
        "type": "access",
        "role": user.role,
        "jti": secrets.token_urlsafe(16),
        "iat": _now(),
        "exp": _now() + timedelta(seconds=expires_in),
    }
    token = jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)
    return token, expires_in


def create_refresh_token(db: Session, user: User) -> str:
    expires_at = _now() + timedelta(days=settings.refresh_token_days)
    jti = secrets.token_urlsafe(24)
    payload = {
        "sub": user.id,
        "type": "refresh",
        "jti": jti,
        "iat": _now(),
        "exp": expires_at,
    }
    token = jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)
    db.add(
        RefreshToken(
            user_id=user.id,
            jti=jti,
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            expires_at=expires_at,
        )
    )
    db.commit()
    return token


def decode_token(token: str, expected_type: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(
            token,
            settings.secret_key,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "sub", "type"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise UnauthorizedError("Your session has expired. Please sign in again.") from exc
    except jwt.PyJWTError as exc:
        raise UnauthorizedError("Invalid authentication token.") from exc
    if payload.get("type") != expected_type:
        raise UnauthorizedError("Invalid token type.")
    return payload


def validate_refresh_token(db: Session, token: str, expected_jti: str) -> tuple[RefreshToken, User]:
    record = db.scalar(
        select(RefreshToken).where(
            RefreshToken.jti == expected_jti,
            RefreshToken.revoked_at.is_(None),
        )
    )
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    if not record or not hmac.compare_digest(record.token_hash, token_hash):
        raise UnauthorizedError("Refresh token has been revoked.")
    if record.expires_at.replace(tzinfo=UTC) <= _now():
        raise UnauthorizedError("Refresh token has expired.")
    user = db.get(User, record.user_id)
    if not user or not user.is_active:
        raise UnauthorizedError("User is inactive.")
    return record, user


def revoke_refresh_token(db: Session, jti: str) -> None:
    record = db.scalar(select(RefreshToken).where(RefreshToken.jti == jti))
    if record and record.revoked_at is None:
        record.revoked_at = _now()
        db.commit()


def generate_api_key() -> tuple[str, str, str]:
    """Returns (plaintext_key, prefix, sha256_hash). Only the hash is persisted."""
    prefix = "mlp_" + secrets.token_hex(4)
    secret = secrets.token_urlsafe(32)
    key = f"{prefix}_{secret}"
    return key, prefix, hashlib.sha256(key.encode()).hexdigest()


def verify_api_key(provided: str, expected_hash: str | None) -> bool:
    if not provided or not expected_hash:
        return False
    return hmac.compare_digest(hashlib.sha256(provided.encode()).hexdigest(), expected_hash)


def access_cookie_kwargs() -> dict[str, Any]:
    return {
        "key": settings.access_cookie_name,
        "httponly": True,
        "secure": settings.cookie_secure,
        "samesite": settings.cookie_samesite,
        "max_age": settings.access_token_minutes * 60,
        "path": "/",
    }


def refresh_cookie_kwargs() -> dict[str, Any]:
    return {
        "key": settings.refresh_cookie_name,
        "httponly": True,
        "secure": settings.cookie_secure,
        "samesite": settings.cookie_samesite,
        "max_age": settings.refresh_token_days * 24 * 3600,
        "path": "/",
    }
