#!/usr/bin/env python3
"""Cloudflare R2 storage via the S3 API (boto3), mirroring chara-backend r2.js.

Railway's filesystem is ephemeral, so generated images / wardrobe items live in
R2. Keyspace: `imagegen/<nickname_or_session>/<filename>`.

GRACEFUL DEGRADATION: if the R2_* env vars are not all present (local dev without
R2), `enabled` is False and callers fall back to the local ./output and ./wardrobe
directories (handled in nodeapp.py).

Public reference format used throughout the app: `r2://<key>`. resolve_img() turns
that back into bytes / a data URL for feeding to the model, and the `/img/<key>`
passthrough route (or a presigned GET) serves it to the browser.
"""
import base64
import os

try:
    import boto3
    from botocore.config import Config
    _HAVE_BOTO = True
except Exception:  # pragma: no cover
    _HAVE_BOTO = False

R2_ENDPOINT = os.environ.get("R2_ENDPOINT", "").strip()
R2_BUCKET = os.environ.get("R2_BUCKET", "").strip()
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()

KEY_PREFIX = "imagegen/"

enabled = bool(
    _HAVE_BOTO and R2_ENDPOINT and R2_BUCKET
    and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
)

_client = None


def _c():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            region_name="auto",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            config=Config(retries={"max_attempts": 3, "mode": "standard"},
                          signature_version="s3v4"),
        )
    return _client


def _assert_safe(key):
    if not isinstance(key, str) or not key.startswith(KEY_PREFIX):
        raise ValueError(f'R2 key must start with "{KEY_PREFIX}"')
    if ".." in key or "\0" in key:
        raise ValueError("R2 key contains illegal characters")
    if len(key) > 512:
        raise ValueError("R2 key too long")


def _content_type(key):
    k = key.lower()
    if k.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if k.endswith(".png"):
        return "image/png"
    if k.endswith(".webp"):
        return "image/webp"
    return "application/octet-stream"


def put_bytes(key, data, content_type=None):
    _assert_safe(key)
    _c().put_object(
        Bucket=R2_BUCKET, Key=key, Body=data,
        ContentType=content_type or _content_type(key),
    )
    return key


def put_dataurl(key, dataurl):
    """Decode a data URL / raw base64 and upload. Returns the R2 key."""
    b64 = dataurl.split(",", 1)[1] if dataurl.startswith("data:") else dataurl
    return put_bytes(key, base64.b64decode(b64))


def get_bytes(key):
    _assert_safe(key)
    obj = _c().get_object(Bucket=R2_BUCKET, Key=key)
    return obj["Body"].read()


def get_dataurl(key):
    data = get_bytes(key)
    return f"data:{_content_type(key)};base64," + base64.b64encode(data).decode()


def exists(key):
    _assert_safe(key)
    try:
        _c().head_object(Bucket=R2_BUCKET, Key=key)
        return True
    except Exception:
        return False


def delete(key):
    _assert_safe(key)
    _c().delete_object(Bucket=R2_BUCKET, Key=key)


def copy(src_key, dst_key):
    """Server-side copy within the bucket (no download/upload round-trip)."""
    _assert_safe(src_key)
    _assert_safe(dst_key)
    _c().copy_object(
        Bucket=R2_BUCKET,
        Key=dst_key,
        CopySource={"Bucket": R2_BUCKET, "Key": src_key},
    )
    return dst_key


def list_prefix(prefix):
    """Return R2 keys under a prefix (paginated)."""
    _assert_safe(prefix)
    keys = []
    token = None
    while True:
        kw = {"Bucket": R2_BUCKET, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = _c().list_objects_v2(**kw)
        for o in resp.get("Contents", []):
            keys.append(o["Key"])
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    return keys


def presign_get(key, expires_sec=1800):
    _assert_safe(key)
    return _c().generate_presigned_url(
        "get_object",
        Params={"Bucket": R2_BUCKET, "Key": key},
        ExpiresIn=expires_sec,
    )
