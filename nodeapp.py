#!/usr/bin/env python3
"""옷장 노드 에디터 — ComfyUI 스타일 노드 그래프 (OpenRouter FLUX.2 Klein 4B + Gemini VLM).

Phase 1 production backend:
  - Railway-ready: PORT/키는 전부 os.environ, 0.0.0.0 바인드, /health.
  - 이미지 생성 + VLM(묘사/스캔/검수) 모두 OpenRouter. 이미지는 FLUX.2 Klein 4B.
  - 저장소: Cloudflare R2 (storage.py). R2 미설정이면 로컬 FS로 graceful fallback.
  - 세션: 닉네임 로그인 + HMAC 토큰 (auth.py). 데이터 API는 토큰 필요.
  - 분석/피드백/그래프: Postgres imagegen_* 테이블 (db.py). DB 없으면 단일유저 로컬모드.
"""
import base64
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import auth
import chat
import db
import storage

API_KEY = os.environ.get("OPENROUTER_API_KEY", "").strip()  # image gen (Klein) + Gemini VLM
MODEL = os.environ.get("IMAGE_MODEL", "black-forest-labs/flux.2-klein-4b")  # image generation
VLM = os.environ.get("VLM_MODEL", "google/gemini-3.1-flash-lite")
VLM_VERIFY = os.environ.get("VLM_VERIFY_MODEL", "google/gemini-3.5-flash")
PORT = int(os.environ.get("PORT", 8401))
ADMIN_NICKNAME = os.environ.get("ADMIN_NICKNAME", "").strip()

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")      # legacy node-editor UI (kept at /editor)
WEBAPP = os.path.join(BASE, "webapp")      # consumer frontend (served at /)
ADMINAPP = os.path.join(BASE, "admin")     # admin dashboard (served at /admin)
WARDROBE = os.path.join(BASE, "wardrobe")
MODELS = os.path.join(BASE, "models")     # person/full photos (local FS fallback)
OUTDIR = os.path.join(BASE, "output")
os.makedirs(OUTDIR, exist_ok=True)
os.makedirs(WARDROBE, exist_ok=True)
os.makedirs(MODELS, exist_ok=True)

# Anonymous fallback identity when DB is off (single-user local dev).
ANON = {"user_id": None, "nickname": "_local", "is_admin": True}

# ── /relay : cross-device clipboard (unauthenticated, ephemeral) ─────────────
# Temporary text relay so a machine that can't copy-paste with another (e.g. an
# internal-network laptop) can pull commands by opening a URL and copying there.
RELAY_FILE = os.path.join(BASE, "_relay.txt")
RELAY_SEED = """# PIKL 복붙 중계기 ✅ 연결됨
# ── 윈도우 노트북에서 할 것 ──

# 1) PowerShell 새 창을 열고 확인:
claude --version

# 2) "찾을 수 없음" 뜨면 → PATH 등록 (아래 한 줄 그대로 복사):
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$env:USERPROFILE\\.local\\bin", "User")

# 3) PowerShell 껐다 다시 켜고:
claude --version
"""

def _relay_get():
    try:
        with open(RELAY_FILE, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return RELAY_SEED

def _relay_set(text):
    try:
        with open(RELAY_FILE, "w", encoding="utf-8") as f:
            f.write(text)
        return True
    except Exception:
        return False

RELAY_HTML = """<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>복붙 중계기</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0f1115;color:#e6e6e6;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:14px}
  h1{font-size:16px;margin:6px 0 10px;color:#9ecbff}
  .bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
  button{flex:1;min-width:120px;padding:12px;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
  .copy{background:#2ea043;color:#fff}
  .save{background:#1f6feb;color:#fff}
  .refresh{background:#30363d;color:#e6e6e6}
  textarea{width:100%;height:60vh;background:#0b0d12;color:#e6e6e6;border:1px solid #30363d;
    border-radius:10px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    font-size:14px;line-height:1.5;white-space:pre;overflow:auto}
  .hint{color:#8b949e;font-size:12px;margin-top:8px}
  .flash{color:#2ea043;font-size:12px;margin-left:6px}
</style></head><body><div class="wrap">
<h1>📋 복붙 중계기 <span id="flash" class="flash"></span></h1>
<div class="bar">
  <button class="copy" onclick="copyAll()">전체 복사</button>
  <button class="save" onclick="save()">저장(이 화면 → 서버)</button>
  <button class="refresh" onclick="pull(true)">새로고침</button>
</div>
<textarea id="t" spellcheck="false"></textarea>
<div class="hint">이 페이지를 양쪽 기기에서 열면 텍스트를 공유해요. 한쪽에서 <b>저장</b> → 다른 쪽에서 <b>새로고침</b>. 편집 중이 아니면 3초마다 자동으로 최신 내용을 불러와요.</div>
<script>
const t=document.getElementById('t'), flash=document.getElementById('flash');
let editing=false, lastServer="";
t.addEventListener('focus',()=>editing=true);
t.addEventListener('blur',()=>editing=false);
function say(m){flash.textContent=m;setTimeout(()=>flash.textContent="",1500)}
async function pull(force){
  try{
    const r=await fetch('/relay/data',{cache:'no-store'});
    const j=await r.json();
    if(force || (!editing && j.text!==lastServer)){ t.value=j.text; if(force) say('불러옴'); }
    lastServer=j.text;
  }catch(e){}
}
async function save(){
  try{
    await fetch('/relay/data',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:t.value})});
    lastServer=t.value; say('저장됨 ✓');
  }catch(e){ say('저장 실패'); }
}
function copyAll(){
  t.select();
  navigator.clipboard.writeText(t.value).then(()=>say('복사됨 ✓')).catch(()=>{
    document.execCommand('copy'); say('복사됨 ✓');
  });
}
pull(true); setInterval(pull, 3000);
</script></div></body></html>"""


# ── OpenRouter (Gemini VLM) ───────────────────────────────────────────────────
def openrouter(body, timeout=60, tries=3):
    """OpenRouter 호출 + 일시 장애(5xx/타임아웃) 자동 재시도."""
    if not API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY 미설정")
    data = json.dumps(body).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions", data=data,
                headers={"Authorization": f"Bearer {API_KEY}",
                         "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                d = json.loads(r.read())
            if "error" in d:
                raise RuntimeError(d["error"].get("message", str(d["error"])))
            return d
        except urllib.error.HTTPError as e:
            if e.code < 500 or i == tries - 1:
                raise RuntimeError(f"OpenRouter HTTP {e.code}: {e.reason}")
            time.sleep(1.5 * (i + 1))
        except (urllib.error.URLError, TimeoutError):
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


# ── image generation (OpenRouter FLUX.2 Klein 4B) ─────────────────────────────
def call_klein(prompt, images, aspect=None):
    """Generate/edit an image via OpenRouter FLUX.2 Klein. Returns {image, cost, elapsed}.

    `images` are dataURLs (or raw base64). Klein uses the chat/completions endpoint
    with modalities:["image"]; the image comes back as a dataURL in
    choices[0].message.images[0].image_url.url. `cost` is the REAL OpenRouter cost.
    """
    content = [{"type": "text", "text": prompt}]
    for img in images:
        content.append({"type": "image_url", "image_url": {"url": img}})
    body = {
        "model": MODEL,
        "modalities": ["image"],
        "messages": [{"role": "user", "content": content}],
    }
    if aspect and aspect != "auto":
        body["image_config"] = {"aspect_ratio": aspect}
    t0 = time.time()
    d = openrouter(body, timeout=300)
    imgs = d["choices"][0]["message"].get("images", [])
    if not imgs:
        raise RuntimeError("모델이 이미지를 반환하지 않음")
    return {
        "image": imgs[0]["image_url"]["url"],
        "cost": d.get("usage", {}).get("cost", 0),
        "elapsed": round(time.time() - t0, 1),
    }


# ── image references + storage (R2, with local fallback) ─────────────────────
# Defaults wardrobe: seeded into every NEW user's closet (owner's starter items).
DEFAULTS_WARDROBE_PREFIX = storage.KEY_PREFIX + "_defaults/wardrobe/"


def _keyspace(user):
    """R2 prefix for a user's objects. Keyed by the immutable user UUID in prod
    (so distinct-but-similar nicknames never collide/leak); falls back to a
    sanitized nickname only in local single-user mode (user_id=None).

    Accepts either a user dict ({user_id, nickname}) or a bare nickname string
    (legacy/local callers)."""
    if isinstance(user, dict):
        uid = user.get("user_id")
        if uid:
            return storage.KEY_PREFIX + str(uid)
        nickname = user.get("nickname")
    else:
        nickname = user
    safe = re.sub(r"[^\w가-힣.-]", "_", nickname or "_session")
    return storage.KEY_PREFIX + safe


def display_url(ref):
    """저장 참조(ref)를 브라우저 <img src>에 바로 넣을 수 있는 URL로 변환.
    - 'r2://<key>' → '/img/<url-encoded key>' (R2 passthrough)
    - '/output/..' / '/wardrobe/..' → 이미 서빙 가능한 로컬 경로 (그대로)
    - 그 외(dataURL 등) → 그대로."""
    if not isinstance(ref, str):
        return ref
    if ref.startswith("r2://"):
        return "/img/" + urllib.parse.quote(ref[len("r2://"):])
    return ref


def resolve_img(s):
    """참조 → dataURL. 지원: 'r2://key', '/output/..', '/wardrobe/..', 이미 dataURL이면 그대로."""
    if not isinstance(s, str):
        return s
    if s.startswith("r2://"):
        return storage.get_dataurl(s[len("r2://"):])
    if s.startswith("/img/"):
        return storage.get_dataurl(urllib.parse.unquote(s[len("/img/"):]))
    if s.startswith("/"):
        name = os.path.basename(urllib.parse.unquote(s))
        mime = "image/jpeg" if name.lower().endswith((".jpg", ".jpeg")) else "image/png"
        for d in (OUTDIR, WARDROBE, MODELS):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                with open(p, "rb") as f:
                    return f"data:{mime};base64," + base64.b64encode(f.read()).decode()
        raise RuntimeError("이미지 파일 없음: " + s)
    return s


def save_output(dataurl, user):
    """생성본 저장 → 안정적 참조 반환. R2면 'r2://key', 아니면 '/output/name'."""
    fname = f"{time.time_ns()}.jpg"
    raw = base64.b64decode(dataurl.split(",", 1)[1] if dataurl.startswith("data:") else dataurl)
    if storage.enabled:
        key = f"{_keyspace(user)}/output/{fname}"
        storage.put_bytes(key, raw, "image/jpeg")
        return "r2://" + key
    with open(os.path.join(OUTDIR, fname), "wb") as f:
        f.write(raw)
    return "/output/" + fname


def save_wardrobe(dataurl, name, user):
    """옷장 아이템 저장. 반환: (참조, 표시용 파일명).

    파일명에 time_ns + 짧은 uuid를 넣어 같은 초에 같은 이름으로 여러 번 저장해도
    키가 충돌하지 않게 한다(FIX 2: 데이터 유실 방지)."""
    name = re.sub(r"[^\w가-힣.-]", "_", name or "item")
    if not name.lower().endswith((".png", ".jpg", ".jpeg")):
        name += ".png"
    fname = f"{time.strftime('%Y%m%d_%H%M%S')}_{uuid4().hex[:6]}_{name}"
    raw = base64.b64decode(dataurl.split(",", 1)[1] if dataurl.startswith("data:") else dataurl)
    if storage.enabled:
        key = f"{_keyspace(user)}/wardrobe/{fname}"
        ct = "image/jpeg" if fname.lower().endswith((".jpg", ".jpeg")) else "image/png"
        storage.put_bytes(key, raw, ct)
        return "r2://" + key, fname
    with open(os.path.join(WARDROBE, fname), "wb") as f:
        f.write(raw)
    return "/wardrobe/" + urllib.parse.quote(fname), fname


def save_person(dataurl, name, user):
    """사람 사진(모델) 저장 — 착샷/전신 사진을 있는 그대로(추출 없이) 별도의
    `models/` 프리픽스에 담는다. 반환: (참조, 표시용 파일명).

    옷장(garment)과 완전히 분리된 keyspace(`<user_id>/models/`)라서, 입히기의
    옷 피커에는 절대 섞이지 않는다. save_wardrobe와 동일하게 time_ns + 짧은 uuid로
    충돌을 방지한다."""
    name = re.sub(r"[^\w가-힣.-]", "_", name or "model")
    if not name.lower().endswith((".png", ".jpg", ".jpeg")):
        name += ".jpg"
    fname = f"{time.strftime('%Y%m%d_%H%M%S')}_{uuid4().hex[:6]}_{name}"
    raw = base64.b64decode(dataurl.split(",", 1)[1] if dataurl.startswith("data:") else dataurl)
    if storage.enabled:
        key = f"{_keyspace(user)}/models/{fname}"
        ct = "image/jpeg" if fname.lower().endswith((".jpg", ".jpeg")) else "image/png"
        storage.put_bytes(key, raw, ct)
        return "r2://" + key, fname
    d = os.path.join(BASE, "models")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, fname), "wb") as f:
        f.write(raw)
    return "/models/" + urllib.parse.quote(fname), fname


_IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp")


def list_models(user):
    """사람 사진(모델) 목록: [{file, ref, url}] — /api/wardrobe와 동일한 shape.
    이미지 확장자만 + 최신순(reverse) 정렬(방금 담은 사진이 맨 위)."""
    if storage.enabled:
        prefix = f"{_keyspace(user)}/models/"
        out = []
        for key in storage.list_prefix(prefix):
            if not key.lower().endswith(_IMG_EXTS):
                continue
            ref = "r2://" + key
            out.append({"file": key[len(prefix):], "ref": ref, "url": display_url(ref)})
        out.sort(key=lambda x: x["file"], reverse=True)
        return out
    d = os.path.join(BASE, "models")
    if not os.path.isdir(d):
        return []
    files = sorted((f for f in os.listdir(d)
                    if f.lower().endswith(_IMG_EXTS)), reverse=True)
    out = []
    for f in files:
        ref = "/models/" + urllib.parse.quote(f)
        out.append({"file": f, "ref": ref, "url": ref})
    return out


def list_wardrobe(user):
    """옷장 목록: [{file (표시명), ref (참조), url (바로 로드 가능한 이미지 URL)}].

    FIX 3: 이미지 확장자만 포함(깨진 타일 방지) + 최신순(reverse) 정렬 —
    방금 담은 아이템이 옷장 맨 위에 뜨도록."""
    if storage.enabled:
        prefix = f"{_keyspace(user)}/wardrobe/"
        out = []
        for key in storage.list_prefix(prefix):
            if not key.lower().endswith(_IMG_EXTS):
                continue
            ref = "r2://" + key
            out.append({"file": key[len(prefix):], "ref": ref, "url": display_url(ref)})
        # keys are prefixed with a sortable timestamp → newest first.
        out.sort(key=lambda x: x["file"], reverse=True)
        return out
    files = sorted((f for f in os.listdir(WARDROBE)
                    if f.lower().endswith(_IMG_EXTS)), reverse=True)
    out = []
    for f in files:
        ref = "/wardrobe/" + urllib.parse.quote(f)
        out.append({"file": f, "ref": ref, "url": ref})
    return out


def seed_default_wardrobe(user):
    """NEW user에게 owner의 기본 옷장 19벌을 복사(best-effort, 로그인 절대 안 막음).
    R2 server-side copy로 `_defaults/wardrobe/*` → `<user_id>/wardrobe/*`."""
    if not storage.enabled:
        return
    try:
        dst_prefix = f"{_keyspace(user)}/wardrobe/"
        n = 0
        for src in storage.list_prefix(DEFAULTS_WARDROBE_PREFIX):
            if not src.lower().endswith(_IMG_EXTS):
                continue
            name = src[len(DEFAULTS_WARDROBE_PREFIX):]
            try:
                storage.copy(src, dst_prefix + name)
                n += 1
            except Exception as e:
                print("[seed] copy failed:", name, str(e)[:120])
        print(f"[seed] seeded {n} default items → {dst_prefix}")
    except Exception as e:  # never block login
        print("[seed] seeding failed (non-fatal):", str(e)[:200])


# ── VLM helpers (unchanged behavior; OpenRouter Gemini) ──────────────────────
def describe_item(image, garment):
    body = {"model": VLM, "max_tokens": 120, "messages": [{"role": "user", "content": [
        {"type": "text", "text": (
            f"Look at the person's outfit in the photo. Describe ONLY the {garment} they are "
            "wearing, in one precise sentence for a fashion catalog: exact color, material, "
            "cut/silhouette, and notable details. If that item is not present, reply exactly NONE. "
            "Reply with the sentence only.")},
        {"type": "image_url", "image_url": {"url": image}},
    ]}]}
    d = openrouter(body)
    return d["choices"][0]["message"]["content"].strip(), d.get("usage", {}).get("cost", 0)


def verify_extract(original, extracted, garment):
    body = {"model": VLM, "max_tokens": 150, "messages": [{"role": "user", "content": [
        {"type": "text", "text": (
            f"The first photo shows a person. The second image is supposed to be an e-commerce "
            f"product shot of ONLY the {garment} from the first photo: the item unworn and empty, "
            "centered on a pure white background, with no person, no body parts (feet, legs, "
            "hands, neck, torso), no mannequin, and no other clothing or accessories included, "
            "while keeping the original item's exact color and details. "
            "If the second image satisfies ALL of this, reply exactly OK. Otherwise reply on one "
            "line: FIX: <one corrective sentence for the image generator describing how the item "
            "should be presented instead>.")},
        {"type": "image_url", "image_url": {"url": original}},
        {"type": "image_url", "image_url": {"url": extracted}},
    ]}]}
    d = openrouter(body)
    text = d["choices"][0]["message"]["content"].strip()
    cost = d.get("usage", {}).get("cost", 0)
    if text.upper().startswith("OK"):
        return None, cost
    return re.sub(r"^FIX:\s*", "", text, flags=re.I).strip() or None, cost


def scan_outfit(image):
    body = {"model": VLM, "max_tokens": 600, "messages": [{"role": "user", "content": [
        {"type": "text", "text": (
            "List EVERY clothing item and accessory the person in the photo is wearing or carrying. "
            'Reply as a JSON array only, no other text: [{"category": one of '
            '"상의"|"아우터"|"하의"|"원피스"|"신발"|"모자"|"가방"|"액세서리", '
            '"name": short Korean name for the item, '
            '"description": one precise English sentence describing exact color, material, cut and details}]')},
        {"type": "image_url", "image_url": {"url": image}},
    ]}]}
    d = openrouter(body)
    text = d["choices"][0]["message"]["content"].strip()
    m = re.search(r"\[.*\]", text, re.S)
    return json.loads(m.group(0) if m else text), d.get("usage", {}).get("cost", 0)


def refine_edit(image, request):
    body = {"model": VLM, "max_tokens": 200, "messages": [{"role": "user", "content": [
        {"type": "text", "text": (
            "Look at the image. The user wants this modification (the request may be in Korean): "
            f"\"{request}\". Write ONE precise English instruction for an image editing model: "
            "describe exactly what to change, referring to the specific parts of this image, and "
            "end by stating that everything else in the image must remain exactly the same. "
            "Reply with the instruction only.")},
        {"type": "image_url", "image_url": {"url": image}},
    ]}]}
    d = openrouter(body)
    return d["choices"][0]["message"]["content"].strip(), d.get("usage", {}).get("cost", 0)


def describe_combine(images):
    n = len(images) - 1
    content = [{"type": "text", "text": (
        f"The first image shows a person wearing an outfit. After it come {n} clothing item "
        "image(s). Write one instruction for an image editor that does ALL of the following: "
        f"for EACH of the {n} provided item(s) — every single one MUST be used — write one clause "
        "'Replace the person's <garment they currently wear in that category> with the <exact "
        "item description: color, type, length>'. "
        "CRITICAL: if the person is wearing an OUTER LAYER (blazer, jacket, coat, cardigan) that "
        "covers the torso or arms and would HIDE a replaced top or conflict with its sleeve length "
        "(e.g. a long-sleeved blazer over a new short-sleeve top), you MUST add a clause: 'Remove "
        "the person's <that outer layer> completely so the new top is fully visible with its own "
        "exact sleeve length and shape.' — do NOT keep an outer layer that covers or conflicts with "
        "a replaced garment. (Exception: do not remove it if one of the provided items IS that outer "
        "layer.) Then end with one clause: 'Keep the person's <every remaining visible garment and "
        "accessory that is NOT being replaced and does NOT cover a replaced item, each with its "
        "color> exactly as they are, completely unchanged.' "
        "If any item image shows a model WEARING the item, add one more clause: 'Take only the "
        "<item> from that image and ignore its model entirely — do not copy their body shape, "
        "face, hair, skin, accessories (necklaces, bags, jewelry), other clothes, pose or camera "
        "framing.' Also state that the output must keep the first image's exact body build, crop "
        "and framing. Reply with the instruction only.")}]
    for img in images:
        content.append({"type": "image_url", "image_url": {"url": img}})
    d = openrouter({"model": VLM, "max_tokens": 200, "messages": [{"role": "user", "content": content}]})
    return d["choices"][0]["message"]["content"].strip(), d.get("usage", {}).get("cost", 0)


def verify_combine(images, result):
    n = len(images) - 1
    content = [{"type": "text", "text": (
        f"The first image shows a person. The next {n} image(s) are clothing items they should "
        "now be wearing. The LAST image is the edited result. Check strictly: (1) in the result "
        f"the person wears EVERY one of the {n} provided item(s), each with the correct garment "
        "type, length, and color as shown in its item image; (2) every other original garment and "
        "accessory is unchanged; (3) the person's identity and pose are unchanged; (4) the "
        "person's body build, proportions, and the photo's crop/framing match the FIRST image — "
        "not the item image's model; (5) NOTHING was copied from the item image's model: no "
        "necklaces, bags, jewelry, other garments or body parts that appear only there. "
        "Items merely hidden or occluded by the new clothing (e.g. socks covered by a long skirt) "
        "are NOT a problem. BUT (6) each newly-applied item MUST be fully visible with its correct "
        "sleeve length and shape — if a KEPT outer layer (blazer, jacket, coat, cardigan) covers or "
        "hides a newly-applied top, or makes its sleeves look longer than the item actually is "
        "(e.g. a long-sleeved blazer left on over a new short-sleeve top), that IS a violation: the "
        "covering outer layer should have been removed. "
        "Only report clear violations. If everything is correct reply exactly "
        "OK. Otherwise reply on one line: FIX: <one corrective sentence for the image generator "
        "stating precisely what must change>.")}]
    for img in images + [result]:
        content.append({"type": "image_url", "image_url": {"url": img}})
    d = openrouter({"model": VLM_VERIFY, "max_tokens": 150,
                    "messages": [{"role": "user", "content": content}]})
    text = d["choices"][0]["message"]["content"].strip()
    cost = d.get("usage", {}).get("cost", 0)
    if text.upper().startswith("OK"):
        return None, cost
    return re.sub(r"^FIX:\s*", "", text, flags=re.I).strip() or None, cost


EXTRACT_TMPL = ("Extract only the {g} worn by the person in the image and render it as e-commerce "
    "product photography: the item isolated completely by itself, centered on a pure white "
    "background. The output must contain exactly ONE item — the {g} — and absolutely nothing "
    "else: no other clothing, no bags, no shoes, no accessories, no person, no body parts. "
    "Reproduce the exact color, fabric, cut and details of the original.")

# Korean scan categories → English extract target (mirrors the legacy node editor's
# GARMENTS map). /api/scan returns these Korean categories in each item's `category`.
GARMENTS = {
    "상의": "top / shirt",
    "아우터": "outer layer (jacket, coat, cardigan)",
    "하의": "bottoms (pants, skirt)",
    "원피스": "dress",
    "신발": "shoes",
    "모자": "hat / cap",
    "가방": "bag",
    "액세서리": "accessories (jewelry, watch, glasses)",
}
# Positive form hints so the re-draw doesn't inherit the "worn" shape (verified live).
FORM_HINTS = {
    "신발": (" Present the shoes as a brand-new, completely empty pair straight out of the box: "
             "the shoe openings are hollow and open, with nothing inside them, standing side by "
             "side on the white surface."),
}
DEFAULT_GARMENT = "most prominent clothing item"


def ingest_item(img, garment=None, description=None):
    """옷장 입구 검문: 착샷이면 제품샷으로 추출.
    반환: (최종 dataURL, 추출여부, 비용, warning|None).

    `garment` (한국어 카테고리, e.g. "상의"/"하의"/"신발")와 `description`(스캔이 준
    영어 묘사)이 주어지면 THAT specific 아이템을 추출한다. 없으면 가장 두드러진 옷을
    추출(레거시 동작)한다.

    VLM(착샷 판별/묘사)이 실패(OpenRouter 다운 등)하면 하드페일하지 않고 이미지를
    있는 그대로 저장한다 — 사전 분류 없이 graceful degrade."""
    cost = 0
    # Resolve the extract target from the picked category (fallback: most prominent).
    g = GARMENTS.get(garment) if garment else None
    picked = bool(g)
    if not g:
        g = DEFAULT_GARMENT
    try:
        d0 = openrouter({"model": VLM, "max_tokens": 10, "messages": [{"role": "user", "content": [
            {"type": "text", "text": (
                "Is this image a clean product-only shot of a single clothing item on a plain "
                "background (reply PRODUCT), or is the clothing worn by / shown on a person or "
                "mannequin (reply WORN)? Reply with one word only.")},
            {"type": "image_url", "image_url": {"url": img}}]}]})
        kind = d0["choices"][0]["message"]["content"].strip().upper()
        cost += d0.get("usage", {}).get("cost", 0)
    except Exception as e:
        # VLM unavailable → skip pre-classification, store the image as-is.
        print("[ingest] VLM classify failed, storing as-is:", str(e)[:160])
        return img, False, cost, "자동 착샷 판별을 지금은 쓸 수 없어 사진을 그대로 담았어요."
    if not kind.startswith("WORN"):
        return img, False, cost, None
    # Description: prefer the per-item one from /api/scan; else ask the VLM for THIS garment.
    desc = (description or "").strip() or None
    if not desc:
        try:
            desc, c2 = describe_item(img, g)
            cost += c2
        except Exception as e:
            print("[ingest] VLM describe failed, extracting without hint:", str(e)[:160])
            desc = None
    p = EXTRACT_TMPL.format(g=g)
    if desc and desc.upper() != "NONE":
        p += f" The exact item to extract: {desc}"
    if picked and garment in FORM_HINTS:
        p += FORM_HINTS[garment]
    res = call_klein(p, [img], "1:1")
    cost += res["cost"]
    try:
        fix, vc = verify_extract(img, res["image"], g)
        cost += vc
        if fix:
            res = call_klein(p + " " + fix, [img], "1:1")
            cost += res["cost"]
    except Exception:
        pass
    return res["image"], True, cost, None


# ── routing helpers ───────────────────────────────────────────────────────────
def _op_from_req(req):
    if req.get("analyze"):
        return "combine"
    if req.get("verify") or req.get("describe"):
        return "extract"
    if req.get("refine"):
        return "edit"
    return "generate"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    # -- responses --
    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, data, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    _CTYPES = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml", ".json": "application/json",
        ".ico": "image/x-icon", ".webp": "image/webp",
    }

    def _serve_file(self, root, rel):
        """Serve a static file under `root`, guarding against path traversal.
        Always sends a response (file bytes or 404)."""
        root = os.path.realpath(root)
        rel = urllib.parse.unquote(rel).lstrip("/")
        fp = os.path.realpath(os.path.join(root, rel))
        if fp != root and not fp.startswith(root + os.sep):
            return self.send_error(404)  # escaped the root
        if not os.path.isfile(fp):
            return self.send_error(404)
        ext = os.path.splitext(fp)[1].lower()
        with open(fp, "rb") as f:
            self._bytes(f.read(), self._CTYPES.get(ext, "application/octet-stream"))

    # -- auth --
    def _identify(self):
        """Return the user dict {user_id, nickname, is_admin} or None (401)."""
        if not db.enabled:
            return dict(ANON)
        tok = auth.bearer(self.headers)
        payload = auth.verify_token(tok) if tok else None
        if not payload:
            return None
        db.touch_last_seen(payload.get("user_id"))
        return {"user_id": payload["user_id"], "nickname": payload["nickname"],
                "is_admin": payload.get("is_admin", False)}

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            return self._json(200, {"ok": True})

        # ── /relay : cross-device clipboard (no auth) ──────────────────────────
        if path == "/relay":
            return self._bytes(RELAY_HTML.encode("utf-8"), "text/html; charset=utf-8")
        if path == "/relay/data":
            return self._json(200, {"text": _relay_get()})

        # ── consumer frontend (webapp/) served at "/" ──────────────────────────
        if path in ("/", "/index.html"):
            return self._serve_file(WEBAPP, "index.html")
        # webapp static assets (relative URLs from index.html: app.js, style.css, assets/…)
        if path in ("/app.js", "/style.css") or path.startswith("/assets/"):
            return self._serve_file(WEBAPP, path)

        # ── admin dashboard (admin/) served at "/admin" ────────────────────────
        # admin.html uses relative asset URLs; with no trailing slash on /admin they
        # resolve to root (/admin.css, /admin.js, /mock-data.js) — serve them there.
        if path in ("/admin", "/admin/"):
            return self._serve_file(ADMINAPP, "admin.html")
        if path in ("/admin.html", "/admin.css", "/admin.js", "/mock-data.js"):
            return self._serve_file(ADMINAPP, os.path.basename(path))

        # ── legacy node-editor UI (optional) at "/editor" ──────────────────────
        if path in ("/editor", "/editor/"):
            return self._serve_file(STATIC, "index.html")

        # R2 passthrough (image serving)
        if path.startswith("/img/"):
            key = urllib.parse.unquote(path[len("/img/"):])
            try:
                data = storage.get_bytes(key)
            except Exception:
                return self.send_error(404)
            ct = "image/jpeg" if key.lower().endswith((".jpg", ".jpeg")) else "image/png"
            return self._bytes(data, ct)

        # local FS image serving (fallback when R2 disabled)
        if (path.startswith("/wardrobe/") or path.startswith("/output/")
                or path.startswith("/models/")):
            folder = (WARDROBE if path.startswith("/wardrobe/")
                      else MODELS if path.startswith("/models/") else OUTDIR)
            name = os.path.basename(urllib.parse.unquote(path.split("/", 2)[2]))
            fp = os.path.join(folder, name)
            if not os.path.isfile(fp):
                return self.send_error(404)
            with open(fp, "rb") as f:
                data = f.read()
            ct = "image/jpeg" if name.lower().endswith((".jpg", ".jpeg")) else "image/png"
            return self._bytes(data, ct)

        # everything below requires auth
        user = self._identify()
        if user is None:
            return self._json(401, {"error": "unauthorized"})

        if path == "/api/me":
            return self._json(200, {"nickname": user["nickname"], "is_admin": user["is_admin"]})

        if path == "/api/spend":
            # legacy UI hook — Klein cost is per-op; expose session spend as 0 stub.
            return self._json(200, {"usage": 0, "credits": 0})

        if path == "/api/graphs":
            if db.enabled and user["user_id"]:
                names = db.list_graphs(user["user_id"])
                if "main" not in names:
                    names = ["main"] + names
                return self._json(200, {"tabs": names})
            names = ["main"] + sorted(f[6:-5] for f in os.listdir(BASE)
                                      if f.startswith("graph_") and f.endswith(".json"))
            return self._json(200, {"tabs": names})

        if path == "/api/graph":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name = re.sub(r"[^\w가-힣-]", "_", q.get("name", ["main"])[0] or "main")
            if db.enabled and user["user_id"]:
                data = db.get_graph(user["user_id"], name)
                return self._json(200, data or {})
            fp = os.path.join(BASE, "graph.json" if name == "main" else f"graph_{name}.json")
            if os.path.isfile(fp):
                with open(fp, "rb") as f:
                    return self._bytes(f.read(), "application/json")
            return self._json(200, {})

        if path == "/api/wardrobe":
            return self._json(200, {"items": list_wardrobe(user)})

        if path == "/api/models":
            return self._json(200, {"items": list_models(user)})

        # admin
        if path == "/api/admin/overview":
            if not user["is_admin"]:
                return self._json(403, {"error": "forbidden"})
            return self._json(200, db.admin_overview() or {})
        if path == "/api/admin/users":
            if not user["is_admin"]:
                return self._json(403, {"error": "forbidden"})
            return self._json(200, {"users": db.admin_users()})
        if path == "/api/admin/feedback":
            if not user["is_admin"]:
                return self._json(403, {"error": "forbidden"})
            return self._json(200, {"feedback": db.admin_feedback()})

        return self.send_error(404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length)) if length else {}
        except Exception as e:
            return self._json(400, {"error": f"bad request: {e}"})

        # ── /relay : cross-device clipboard save (no auth) ─────────────────────
        if path == "/relay/data":
            txt = req.get("text", "")
            if not isinstance(txt, str):
                txt = str(txt)
            _relay_set(txt[:100000])
            return self._json(200, {"ok": True})

        # login is the only unauthenticated data route
        if path == "/api/login":
            return self._login(req)

        user = self._identify()
        if user is None:
            return self._json(401, {"error": "unauthorized"})
        uid = user["user_id"]

        try:
            if path == "/api/generate":
                return self._generate(req, user)
            if path == "/api/verify_fix":
                return self._verify_fix(req, user)

            if path == "/api/scan":
                if not req.get("image"):
                    return self._json(400, {"error": "이미지가 없음"})
                try:
                    items, cost = scan_outfit(resolve_img(req["image"]))
                except Exception as e:
                    # VLM(자동 분해)이 없으면 스캔은 성립하지 않음 → 개발용 500이 아니라
                    # 프론트가 친절하게 안내할 수 있는 구조화된 에러로 응답.
                    print("[scan] VLM unavailable:", str(e)[:160])
                    db.log_event(uid, "scan", {"error": "analysis_unavailable"})
                    return self._json(200, {"items": [], "cost": 0,
                                            "error": "analysis_unavailable"})
                db.add_usage(uid, "scan", cost)
                db.log_event(uid, "scan", {"count": len(items)})
                return self._json(200, {"items": items, "cost": cost})

            if path == "/api/ingest":
                if not req.get("image"):
                    return self._json(400, {"error": "이미지가 없음"})
                img, extracted, cost, warning = ingest_item(
                    resolve_img(req["image"]),
                    garment=req.get("garment"),
                    description=req.get("description"))
                ref, fname = save_wardrobe(img, req.get("name") or "item", user)
                db.add_usage(uid, "ingest", cost)
                db.log_event(uid, "wardrobe_save",
                             {"file": fname, "extracted": extracted, "via": "ingest",
                              "garment": req.get("garment")})
                resp = {"file": fname, "ref": ref, "url": display_url(ref),
                        "extracted": extracted, "cost": cost}
                if warning:
                    resp["warning"] = warning
                return self._json(200, resp)

            if path == "/api/save":
                if not req.get("image"):
                    return self._json(400, {"error": "이미지가 없음"})
                ref, fname = save_wardrobe(resolve_img(req["image"]),
                                           req.get("name") or "item", user)
                db.log_event(uid, "wardrobe_save", {"file": fname, "via": "save"})
                return self._json(200, {"file": fname, "ref": ref, "url": display_url(ref)})

            if path == "/api/save_person":
                # 사람 사진(모델)을 추출 없이 그대로 별도 keyspace(models/)에 저장.
                if not req.get("image"):
                    return self._json(400, {"error": "이미지가 없음"})
                ref, fname = save_person(resolve_img(req["image"]),
                                         req.get("name") or "model", user)
                db.log_event(uid, "model_save", {"file": fname})
                return self._json(200, {"file": fname, "ref": ref, "url": display_url(ref)})

            if path == "/api/persist":
                name = re.sub(r"[^\w가-힣-]", "_", req.pop("name", "main") or "main")
                if db.enabled and uid:
                    db.save_graph(uid, name, req)
                    db.log_event(uid, "graph_save", {"name": name,
                                                     "nodes": len(req.get("nodes", []))})
                    return self._json(200, {"ok": True})
                # local fallback
                fp = os.path.join(BASE, "graph.json" if name == "main" else f"graph_{name}.json")
                tmp = fp + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(req, f, ensure_ascii=False)
                os.replace(tmp, fp)
                return self._json(200, {"ok": True})

            if path == "/api/graph_delete":
                name = re.sub(r"[^\w가-힣-]", "_", req.get("name") or "")
                if name and name != "main":
                    if db.enabled and uid:
                        db.delete_graph(uid, name)
                    else:
                        fp = os.path.join(BASE, f"graph_{name}.json")
                        if os.path.isfile(fp):
                            os.remove(fp)
                return self._json(200, {"ok": True})

            if path == "/api/rename":
                # R2 has no rename; local FS supports it. Wardrobe rename is a UI nicety.
                if storage.enabled:
                    return self._json(400, {"error": "이름 변경은 로컬 모드에서만 지원돼"})
                old = os.path.basename(req.get("file", ""))
                src = os.path.join(WARDROBE, old)
                if not os.path.isfile(src):
                    return self._json(404, {"error": "파일 없음"})
                name = re.sub(r"[^\w가-힣.-]", "_", req.get("name") or "").strip("_")
                if not name:
                    return self._json(400, {"error": "이름이 비어있음"})
                if not name.lower().endswith(".png"):
                    name += ".png"
                m = re.match(r"^(\d{8}_\d{6}_)", old)
                fname = (m.group(1) if m else time.strftime("%Y%m%d_%H%M%S_")) + name
                if fname != old:
                    dst = os.path.join(WARDROBE, fname)
                    if os.path.exists(dst):
                        return self._json(400, {"error": "같은 이름이 이미 있음"})
                    os.rename(src, dst)
                return self._json(200, {"file": fname})

            if path == "/api/delete":
                # Deletes any of the CURRENT user's own objects (wardrobe OR models),
                # keyed by its R2 key / local path. Guards against deleting another
                # user's key: an r2:// key must live under this user's keyspace.
                ref = req.get("ref") or req.get("file", "")
                if isinstance(ref, str) and ref.startswith("r2://"):
                    key = ref[len("r2://"):]
                    own_prefix = _keyspace(user) + "/"
                    if not key.startswith(own_prefix):
                        return self._json(403, {"error": "본인 소유의 항목만 삭제할 수 있어요"})
                    try:
                        storage.delete(key)
                    except Exception:
                        pass
                else:
                    # local FS fallback: search the user's wardrobe + models folders.
                    base = os.path.basename(ref)
                    for d in (WARDROBE, MODELS):
                        src = os.path.join(d, base)
                        if os.path.isfile(src):
                            os.remove(src)
                            break
                db.log_event(uid, "delete", {"ref": str(ref)[:200]})
                return self._json(200, {"ok": True})

            if path == "/api/feedback":
                msg = (req.get("message") or "").strip()
                if not msg:
                    return self._json(400, {"error": "메시지가 비어있음"})
                db.add_feedback(uid, user["nickname"], msg[:4000])
                db.log_event(uid, "feedback_submit", {"len": len(msg)})
                return self._json(200, {"ok": True})

            if path == "/api/chat":
                return self._chat(req, user)

            return self.send_error(404)
        except Exception as e:
            return self._json(500, {"error": str(e)})

    # -- login --
    def _login(self, req):
        nickname = (req.get("nickname") or "").strip()[:40]
        if not nickname:
            return self._json(400, {"error": "닉네임이 비어있음"})
        is_admin_req = bool(ADMIN_NICKNAME) and nickname == ADMIN_NICKNAME
        if db.enabled:
            row, is_new = db.upsert_user(nickname, is_admin=is_admin_req)
            uid = str(row["id"])
            is_admin = bool(row["is_admin"])
            db.log_event(uid, "signup" if is_new else "login", {"nickname": nickname})
            # NEW user → optionally seed the owner's default wardrobe (best-effort, non-blocking).
            # Disabled by default so new users start with an EMPTY closet (privacy — they must not
            # see the owner's personal items). Re-enable by setting env SEED_DEFAULTS=1.
            if is_new and os.environ.get("SEED_DEFAULTS", "").lower() in ("1", "true", "yes"):
                seed_default_wardrobe({"user_id": uid, "nickname": nickname})
            token = auth.make_token(uid, nickname, is_admin)
            return self._json(200, {"token": token, "nickname": nickname, "is_admin": is_admin})
        # local anonymous mode: still issue a token so the UI flow works
        is_admin = True  # single-user local dev is its own admin
        token = auth.make_token(None, nickname, is_admin)
        return self._json(200, {"token": token, "nickname": nickname, "is_admin": is_admin})

    # -- generate (the heavy route) --
    def _generate(self, req, user):
        uid = user["user_id"]
        prompt = (req.get("prompt") or "").strip()
        if not prompt:
            return self._json(400, {"error": "프롬프트가 비어있음"})
        op = _op_from_req(req)
        try:
            images = [resolve_img(x) for x in req.get("images", [])[:6]]
            desc = None
            vlm_cost = 0
            rcost = 0
            acost = 0

            if req.get("refine_text") and prompt:
                try:
                    d0 = openrouter({"model": VLM, "max_tokens": 150, "messages": [{
                        "role": "user", "content": (
                            "Rewrite the user's image request as ONE precise English prompt "
                            "for an image generation model, adding helpful specifics implied "
                            "by the request. If it is a clothing item, make it a clean "
                            "e-commerce product photo on a pure white background, garment "
                            f"only, no person. User request: \"{prompt}\". "
                            "Reply with the prompt only.")}]})
                    t = d0["choices"][0]["message"]["content"].strip()
                    if t:
                        prompt = t
                        desc = t
                        rcost += d0.get("usage", {}).get("cost", 0)
                except Exception:
                    pass
            if req.get("refine") and images:
                try:
                    inst, rcost = refine_edit(images[0], prompt)
                    if inst:
                        prompt = inst
                        desc = inst
                except Exception:
                    pass
            if req.get("analyze") and len(images) >= 2:
                try:
                    inst, acost = describe_combine(images)
                    if inst:
                        prompt += " " + inst
                except Exception:
                    acost = 0
            gen_warning = None
            if req.get("describe") and images:
                try:
                    desc, vlm_cost = describe_item(images[0], req["describe"])
                    if desc and desc.upper() != "NONE":
                        prompt += f" The exact item to extract: {desc}"
                    else:
                        desc = None
                except Exception as e:
                    # VLM (사전분석) 다운 → 묘사 없이 그대로 Klein 추출 진행.
                    print("[generate] describe VLM failed, degrading:", str(e)[:160])
                    desc, vlm_cost = None, 0
                    gen_warning = "자동 분석을 지금은 쓸 수 없어 사진만으로 처리했어요."

            res = call_klein(prompt, images, req.get("aspect"))
            gen_cost = res["cost"]
            res["cost"] += acost + rcost
            if desc is not None:
                res["cost"] += vlm_cost
                res["desc"] = desc
            if gen_warning and not res.get("warning"):
                res["warning"] = gen_warning

            ref = save_output(res["image"], user)
            res["image"] = ref                 # storage ref (r2://.. / /output/..)
            res["ref"] = ref                   # explicit: pass back to /api/save to chain
            res["url"] = display_url(ref)       # directly loadable in <img src>

            # analytics (best-effort)
            db.add_usage(uid, op, gen_cost)
            db.log_image(uid, ref, op, prompt, gen_cost)
            meta = {"op": op, "cost": gen_cost, "n_images": len(images)}
            if res.get("warning"):
                meta["warning"] = res["warning"]
            db.log_event(uid, "generate", meta)
            db.log_event(uid, op, {"cost": gen_cost})
            return self._json(200, res)
        except Exception as e:
            db.log_event(uid, "generate_fail", {"op": op, "error": str(e)[:400]})
            return self._json(500, {"error": str(e)})

    # -- background verify + corrective rerun --
    def _verify_fix(self, req, user):
        uid = user["user_id"]
        try:
            images = [resolve_img(x) for x in req.get("images", [])[:6]]
            result = resolve_img(req.get("result"))
            prompt = req.get("prompt", "")
            fix, vcost = None, 0
            if req.get("verify") and images:
                fix, vcost = verify_extract(images[0], result, req["verify"])
            elif req.get("analyze") and len(images) >= 2:
                fix, vcost = verify_combine(images, result)
            if not fix:
                return self._json(200, {"ok": True, "cost": vcost})
            res2 = call_klein(prompt + " " + fix, images, req.get("aspect"))
            gen_cost = res2["cost"]
            res2["cost"] += vcost
            res2["retry"] = fix
            ref = save_output(res2["image"], user)
            res2["image"] = ref
            res2["ref"] = ref
            res2["url"] = display_url(ref)
            op = _op_from_req(req)
            db.add_usage(uid, op, gen_cost)
            db.log_image(uid, ref, op + "_retry", prompt + " " + fix, gen_cost)
            db.log_event(uid, "generate_retry", {"op": op, "fix": fix[:300]})
            return self._json(200, res2)
        except Exception as e:
            db.log_event(uid, "generate_fail", {"op": "verify_fix", "error": str(e)[:400]})
            return self._json(500, {"error": str(e)})

    # -- help chatbot (tool-calling, OpenRouter Gemini) --
    def _chat(self, req, user):
        """POST /api/chat — 도움말 챗봇 한 턴. OpenRouter가 죽어도 500 대신 친절한
        폴백을 돌려준다(graceful degrade). 이벤트 로깅은 best-effort."""
        uid = user["user_id"]
        messages = req.get("messages")
        if not isinstance(messages, list) or not messages:
            return self._json(400, {"error": "messages가 비어있음"})
        try:
            res = chat.chat(messages, user)
        except Exception as e:
            # OpenRouter 장애/키 문제 등 → 친절한 폴백(500 금지)
            print("[chat] failed, degrading:", str(e)[:200])
            db.log_event(uid, "chat", {"error": "chat_unavailable", "n_msg": len(messages)})
            return self._json(200, {
                "reply": "지금은 도우미 응답을 불러오지 못했어요. 잠시 후 다시 시도해 주세요. "
                         "급한 문제라면 피드백으로 남겨주시면 확인할게요.",
                "cost": 0, "tools_used": [], "degraded": True})
        db.add_usage(uid, "chat", res.get("cost", 0))
        db.log_event(uid, "chat", {"n_msg": len(messages),
                                   "tools": res.get("tools_used", []),
                                   "cost": res.get("cost", 0)})
        return self._json(200, {
            "reply": res["reply"],
            "cost": res.get("cost", 0),
            "tools_used": res.get("tools_used", []),
        })


if __name__ == "__main__":
    db.init()
    mode = []
    mode.append("DB=" + ("on" if db.enabled else "off(local json)"))
    mode.append("R2=" + ("on" if storage.enabled else "off(local fs)"))
    mode.append("OpenRouter=" + ("on" if API_KEY else "MISSING"))
    print(f"imagegen backend :{PORT}  [" + ", ".join(mode) + "]")
    print(f"  http://0.0.0.0:{PORT}   admin_nickname={'set' if ADMIN_NICKNAME else 'unset'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
