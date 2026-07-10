#!/usr/bin/env python3
"""RunPod Qwen-Image-Edit-2511 adapter.

NOTE: CURRENTLY UNUSED. The app reverted image generation to OpenRouter FLUX.2
Klein (`call_klein` in nodeapp.py). This module is kept for reference / possible
future re-migration but is no longer imported by nodeapp.py.


Drop-in replacement for the old OpenRouter FLUX.2 Klein `call_klein`: same return
shape {image, cost, elapsed} so the rest of the app is unaffected. Contract was
verified live (see /tmp/qwen_verify.py, /tmp/multi_bench.py):

  POST https://api.runpod.ai/v2/qwen-image-edit-2511/run
    Authorization: Bearer $RUNPOD_API_KEY
    body: {"input": {prompt, images[<=3], size "W*H", seed -1,
                     output_format "jpeg", enable_base64_output true,
                     enable_sync_mode false}}
  then poll GET /status/{id} until status == COMPLETED.
  output.result = RAW base64 (no data: prefix); output.cost = 0.02.

Qwen accepts AT MOST 3 images; combine (person + up to 4 garments) is capped to
the first 3 and a warning is surfaced.
"""
import json
import os
import time
import urllib.error
import urllib.request

BASE = "https://api.runpod.ai/v2/qwen-image-edit-2511"
MAX_IMAGES = 3

ASPECT_SIZE = {
    "1:1": "1024*1024",
    "3:4": "768*1024",
    "4:3": "1024*768",
    "9:16": "576*1024",
    "16:9": "1024*576",
    "auto": "1024*1024",
}


def _key():
    k = os.environ.get("RUNPOD_API_KEY", "").strip()
    if not k:
        raise RuntimeError("RUNPOD_API_KEY 미설정")
    return k


def _post(path, body, timeout=60):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {_key()}",
                 "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _get(path, timeout=60):
    req = urllib.request.Request(BASE + path,
                                 headers={"Authorization": f"Bearer {_key()}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _find_image(o):
    """Locate the base64/data-URI/URL image anywhere in the output tree."""
    if isinstance(o, str) and (o.startswith("http") or o.startswith("data:") or len(o) > 500):
        return o
    if isinstance(o, dict):
        # prefer the canonical `result` field
        if isinstance(o.get("result"), str) and len(o["result"]) > 100:
            return o["result"]
        for v in o.values():
            r = _find_image(v)
            if r:
                return r
    if isinstance(o, list):
        for v in o:
            r = _find_image(v)
            if r:
                return r
    return None


def call_qwen_edit(prompt, images, aspect=None):
    """Generate/edit an image. Returns {image (dataURL), cost, elapsed[, warning]}.

    `images` are data URLs (or raw base64) — passed straight through to Qwen.
    """
    warning = None
    imgs = list(images or [])
    if len(imgs) > MAX_IMAGES:
        dropped = len(imgs) - MAX_IMAGES
        imgs = imgs[:MAX_IMAGES]
        warning = (f"Qwen은 최대 {MAX_IMAGES}장까지만 지원해서 앞의 {MAX_IMAGES}장만 "
                   f"적용했어 (옷 {dropped}개 제외됨).")

    size = ASPECT_SIZE.get(aspect or "auto", "1024*1024")
    body = {"input": {
        "prompt": prompt,
        "images": imgs,
        "size": size,
        "seed": -1,
        "output_format": "jpeg",
        "enable_base64_output": True,
        "enable_sync_mode": False,
    }}

    t0 = time.time()
    try:
        sub = _post("/run", body)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode()[:400]
        except Exception:
            pass
        raise RuntimeError(f"RunPod HTTP {e.code}: {e.reason} {detail}")

    jid = sub.get("id")
    if not jid:
        raise RuntimeError(f"RunPod: 잡 ID 없음 — {json.dumps(sub)[:300]}")

    status, st = sub.get("status"), sub
    while time.time() - t0 < 180:
        st = _get("/status/" + jid)
        status = st.get("status")
        if status in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"):
            break
        time.sleep(0.6)

    if status != "COMPLETED":
        out = st.get("output")
        err = None
        if isinstance(out, dict):
            err = out.get("error") or out.get("message")
        err = err or st.get("error") or status or "unknown"
        raise RuntimeError(f"RunPod 생성 실패({status}): {str(err)[:300]}")

    output = st.get("output") or {}
    img = _find_image(output)
    if not img:
        raise RuntimeError("모델이 이미지를 반환하지 않음")
    if not img.startswith("data:"):
        img = "data:image/jpeg;base64," + img.split(",", 1)[-1] if img.startswith("http") else \
              "data:image/jpeg;base64," + img
    cost = 0.0
    if isinstance(output, dict) and output.get("cost") is not None:
        try:
            cost = float(output["cost"])
        except Exception:
            cost = 0.0

    res = {"image": img, "cost": cost, "elapsed": round(time.time() - t0, 1)}
    if warning:
        res["warning"] = warning
    return res
