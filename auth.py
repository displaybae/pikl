#!/usr/bin/env python3
"""Stateless HMAC bearer tokens, mirroring chara-backend/src/auth.js.

A token is `<base64url(payload)>.<base64url(hmac-sha256(payload))>` signed with
SESSION_SECRET. Payload carries {user_id, nickname, is_admin, iat, exp}. If
SESSION_SECRET is unset we generate a per-boot secret (tokens invalidate on
restart — acceptable for local dev).
"""
import base64
import hashlib
import hmac
import json
import os
import time

SESSION_SECRET = os.environ.get("SESSION_SECRET") or os.urandom(32).hex()
TOKEN_TTL_SEC = 30 * 24 * 3600  # 30 days


def _b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64u_decode(s):
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def make_token(user_id, nickname, is_admin, now_sec=None):
    now_sec = int(now_sec if now_sec is not None else time.time())
    payload_obj = {
        "user_id": user_id,
        "nickname": nickname,
        "is_admin": bool(is_admin),
        "iat": now_sec,
        "exp": now_sec + TOKEN_TTL_SEC,
    }
    payload = _b64u(json.dumps(payload_obj, separators=(",", ":")).encode())
    sig = _b64u(hmac.new(SESSION_SECRET.encode(), payload.encode(),
                         hashlib.sha256).digest())
    return f"{payload}.{sig}"


def verify_token(token, now_sec=None):
    """Return the payload dict if valid, else None."""
    if not isinstance(token, str) or "." not in token:
        return None
    now_sec = int(now_sec if now_sec is not None else time.time())
    payload, _, sig = token.partition(".")
    expect = _b64u(hmac.new(SESSION_SECRET.encode(), payload.encode(),
                            hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expect):
        return None
    try:
        data = json.loads(_b64u_decode(payload).decode())
    except Exception:
        return None
    if not data.get("exp") or data["exp"] < now_sec:
        return None
    return data


def bearer(headers):
    raw = headers.get("Authorization") or headers.get("authorization") or ""
    return raw[7:].strip() if raw[:7].lower() == "bearer " else raw.strip()
