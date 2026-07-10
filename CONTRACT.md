# imagegen backend — HTTP CONTRACT (Phase 1)

This is the source of truth for the Phase-2 frontend. The backend is Python stdlib
`ThreadingHTTPServer` (`nodeapp.py`) + `db.py` (Postgres), `storage.py` (R2),
`auth.py` (HMAC tokens). Binds `0.0.0.0:$PORT` (default 8401).

Image generation uses **OpenRouter FLUX.2 Klein 4B** (`black-forest-labs/flux.2-klein-4b`,
overridable via `IMAGE_MODEL`) via `call_klein` in `nodeapp.py` — the same OpenRouter
chat/completions endpoint as the VLM, with `modalities:["image"]`. `qwen.py` (RunPod
Qwen-Image-Edit-2511) is kept in the repo but is **currently unused** (from a prior
Phase-1 migration that was reverted).

## Runtime modes (graceful degradation)
- **DATABASE_URL set** → full analytics + per-user graphs + real login. Unset →
  single-user anonymous local mode (`nickname="_local"`, is_admin=true), graphs
  fall back to local JSON files, no analytics.
- **R2_* set** → images stored in Cloudflare R2 (refs are `r2://<key>`). Unset →
  local `./output` + `./wardrobe` (refs are `/output/...` / `/wardrobe/...`).
- **OPENROUTER_API_KEY** powers BOTH image generation (FLUX.2 Klein) and the Gemini
  VLM enrichment (describe/scan/verify). If unset, `/api/generate` cannot produce an
  image. If the key is merely out of credits, VLM-enriched steps degrade gracefully
  (see per-endpoint notes) but the image call itself will also fail without credit.

## Auth / token flow
1. `POST /api/login {nickname}` → `{token, nickname, is_admin}`.
   - New nickname → row inserted into `imagegen_users`, `signup` event logged.
   - Existing → `last_seen_at` touched, `login` event logged.
   - If `nickname == $ADMIN_NICKNAME` → `is_admin=true` set on the row.
2. `token` is a stateless HMAC: `base64url(payload).base64url(hmac_sha256(payload))`,
   signed with `$SESSION_SECRET`. Payload: `{user_id, nickname, is_admin, iat, exp}`
   (30-day TTL). Send on every `/api/*` call as `Authorization: Bearer <token>`.
3. Invalid/expired/missing token on a protected route → **401** `{"error":"unauthorized"}`.
4. Admin routes with a non-admin token → **403** `{"error":"forbidden"}`.

## Image reference format
Endpoints deal in two related image values, never inline base64 on the wire (keeps
graphs small):
- **`ref`** — the stable storage reference used as an *input* (`image`/`images[]`)
  and for save/delete. R2 mode: `"r2://imagegen/<nickname>/output/<ts>.jpg"` (or
  `/wardrobe/<file>`). Local mode: `"/output/<ts>.jpg"` or `"/wardrobe/<file>"`.
- **`url`** — a **directly loadable** URL for `<img src>` (the frontend never has to
  transform a ref itself). The backend derives it: `r2://<key>` → `/img/<url-encoded key>`
  (the `/img/` passthrough serves the bytes); local refs (`/output/..`, `/wardrobe/..`)
  are already servable so `url == ref`.

Rule of thumb: **display `url`, chain `ref`.** Any response carrying an image returns
both. When sending an image back to the server as input, pass the **`ref`** as-is —
`resolve_img()` accepts `r2://`, `/img/<key>`, `/output/..`, `/wardrobe/..`, and dataURLs.

---

## Endpoints

### `GET /health`  (no auth)
→ `200 {"ok": true}`

### Static frontends (no auth to fetch the files; data APIs still gated)
- `GET /`, `GET /index.html` → serves the **consumer app** `webapp/index.html`.
  Its relative assets are served at root: `GET /app.js`, `GET /style.css`, `GET /assets/…`.
- `GET /admin` (and `/admin/`) → serves the **admin dashboard** `admin/admin.html`.
  Its assets are served at root: `GET /admin.css`, `/admin.js`, `/mock-data.js`
  (relative URLs from `/admin` resolve to root since there's no trailing-slash dir).
  Serving the HTML is public; all `/api/admin/*` data is still admin-gated (403 otherwise).
- `GET /editor` → the legacy node-editor UI (`static/index.html`), kept reachable but unused.

### `POST /api/login`  (no auth)
Req: `{"nickname": "<1-40 chars>"}`
→ `200 {"token": "<hmac>", "nickname": "...", "is_admin": bool}`
→ `400 {"error":"닉네임이 비어있음"}` if empty.

### `GET /api/me`  (auth)
→ `200 {"nickname": "...", "is_admin": bool}` — used by the client to resume a
saved token; 401 if the token is invalid so the UI can re-show the gate.

### `POST /api/generate`  (auth)  — the heavy image route (FLUX.2 Klein)
Req (all optional except `prompt`):
```
{
  "prompt": "<str, required>",
  "images": ["<ref or dataURL>", ...],   // resolved server-side; sliced to first 6
  "aspect": "auto|1:1|3:4|4:3|9:16|16:9", // -> image_config.aspect_ratio for Klein
  "refine_text": true,   // VLM: rewrite a freeform request into a clean prompt (generate node)
  "refine": true,        // VLM: turn a Korean edit request into a precise instruction (edit node)
  "analyze": <int>,      // VLM: combine pre-analysis (# of garments); triggers op="combine"
  "describe": "<garment>"// VLM: describe the exact item to extract; triggers op="extract"
}
```
→ `200 {"image": "<ref>", "ref": "<ref>", "url": "<loadable url>",
        "cost": <usd float>, "elapsed": <sec>,
        "desc"?: "<vlm text>", "warning"?: "<str>"}`
  - `image` and `ref` are the same storage ref (kept both for back-compat); `url` is the
    directly-loadable display URL. **Display `url`; pass `ref` to `/api/save` to chain.**
  - `cost` = the REAL Klein image cost (from OpenRouter `usage.cost`) + any VLM costs
    incurred. Combine accepts person + up to 4 garments (no 3-image cap).
  - `warning` is present when a VLM enrichment step (`describe`) degraded gracefully
    because OpenRouter was unavailable — the image is still returned, just without the
    auto-analysis.
→ `400` if `prompt` empty. → `500 {"error": "..."}` only on **image** generation failure
  (logs a `generate_fail` event). VLM enrichment failures never 500 — they degrade.
Side effects on success: `imagegen_usage` (op, cost_micro), `imagegen_images`
(provenance), events `generate` + op-specific (`generate`/`extract`/`combine`/`edit`).

### `POST /api/verify_fix`  (auth)  — background verify + corrective rerun
Req: `{prompt, images[], aspect, verify?: "<garment>", analyze?: <int>, result: "<ref>"}`
→ `200 {"ok": true, "cost": <usd>}` if the result passes verification (no rerun), OR
→ `200 {"image": "<ref>", "ref": "<ref>", "url": "<loadable url>", "cost": <usd>,
        "elapsed": <sec>, "retry": "<fix text>"}` if it re-generated a corrected image.
   Logs `generate_retry`.

### `POST /api/scan`  (auth)  — VLM outfit breakdown
Req: `{"image": "<ref or dataURL>"}`
→ `200 {"items": [{"category","name","description"}, ...], "cost": <usd>}`
  `category` is Korean (`상의|아우터|하의|원피스|신발|모자|가방|액세서리`). Logs `scan` + usage.
→ `200 {"items": [], "cost": 0, "error": "analysis_unavailable"}` when the VLM is
  unavailable (scan *requires* the VLM). **This is a graceful, non-500 degrade** — the
  frontend shows a friendly "지금은 자동 분해를 쓸 수 없어요" notice, not a dev error.

### `POST /api/ingest`  (auth)  — add to wardrobe (auto-extract if worn)
Req: `{"image": "<ref or dataURL>", "name": "<str>"}`
→ `200 {"file": "<display name>", "ref": "<ref>", "url": "<loadable url>",
        "extracted": bool, "cost": <usd>, "warning"?: "<str>"}`
  If the image is a worn shot, it's converted to a product shot via Klein first.
  If the VLM worn/product classifier is unavailable, it **degrades**: stores the image
  as-is (`extracted:false`) and returns a `warning` instead of 500. Logs `wardrobe_save`.

### `POST /api/save`  (auth)  — save an image to the wardrobe as-is
Req: `{"image": "<ref or dataURL>", "name": "<str>"}`
→ `200 {"file": "<display name>", "ref": "<ref>", "url": "<loadable url>"}`. Logs `wardrobe_save`.

### `GET /api/wardrobe`  (auth)
→ `200 {"items": [{"file": "<display name>", "ref": "<ref>", "url": "<loadable url>"}, ...]}`
  (per-nickname). Display each item with `url`; use `ref` for delete / try-on input.

### `POST /api/rename`  (auth)  — local mode only
Req: `{"file": "<current display name>", "name": "<new name>"}`
→ `200 {"file": "<new display name>"}` or `400 {"error":"이름 변경은 로컬 모드에서만 지원돼"}` in R2 mode.

### `POST /api/delete`  (auth)
Req: `{"ref": "<ref>"}` (or legacy `{"file": "..."}`)
→ `200 {"ok": true}`. Logs `delete`.

### `GET /api/graphs`  (auth)  — node-graph tab names (per-nickname)
→ `200 {"tabs": ["main", ...]}`

### `GET /api/graph?name=<tab>`  (auth)
→ `200 <graph JSON>` (`{name, ts, nextId, nodes, edges}`) or `{}` if none.

### `POST /api/persist`  (auth)  — save a node graph
Req: `{name, ts, nextId, nodes, edges}` (the full graph payload; `name` defaults "main")
→ `200 {"ok": true}`. Stored in `imagegen_graphs` (DB) or `graph*.json` (local). Logs `graph_save`.

### `POST /api/graph_delete`  (auth)
Req: `{"name": "<tab>"}` (cannot delete "main") → `200 {"ok": true}`.

### `GET /img/<r2-key>`  (no auth — see deviations)
R2 passthrough: serves the object bytes as image/jpeg|png. 404 if missing.

### `GET /output/<name>` , `GET /wardrobe/<name>`  (no auth)
Local-FS image serving (used only in R2-disabled mode).

### `POST /api/feedback`  (auth)
Req: `{"message": "<str>"}` → `200 {"ok": true}`. Inserts `imagegen_feedback` +
logs `feedback_submit`. → `400` if empty.

### `GET /api/spend`  (auth)  — legacy stub
→ `200 {"usage": 0, "credits": 0}` (kept so the old UI's spend widget doesn't error;
image cost is per-op via `/api/generate` responses).

### `POST /api/chat`  (auth)  — in-app help chatbot (tool-calling)
A support-agent-style assistant (`chat.py`) that helps users when they hit problems
(추출/입히기/옷장). It uses **OpenRouter Gemini 3.1 Flash Lite** (`CHAT_MODEL`, default
`google/gemini-3.1-flash-lite`) with **OpenAI-style function calling**: the server sends
the conversation + tool schemas, executes any returned `tool_calls` against the *current
authenticated user's real data* (read-only, except feedback), feeds the results back, and
loops (cap 4 rounds) until the model returns a final text reply. The system prompt (Korean)
is added **server-side** — the client only sends the running conversation.

Req:
```
{ "messages": [ {"role":"user"|"assistant", "content":"<str>"}, ... ] }
```
- `messages` is the running conversation (no `system` — the server prepends it and rejects
  any client-sent `system` role). Sliced to the last 30 turns; leading non-user turns are trimmed.
→ `200 { "reply": "<assistant text>", "cost": <usd float>, "tools_used": ["<tool>", ...] }`
  - `cost` is the REAL OpenRouter `usage.cost` summed across all tool-loop round-trips.
  - `tools_used` (debug aid) lists the tools the model invoked this turn.
→ `400 {"error":"messages가 비어있음"}` if `messages` is missing/empty.
→ **Graceful degrade (never 500):** if OpenRouter is down/unfunded, returns
  `200 {"reply":"<친절한 폴백>", "cost":0, "tools_used":[], "degraded":true}`.
Side effects (best-effort): `imagegen_usage` (op `chat`, cost_micro) + a `chat` event
(`meta:{n_msg, tools, cost}`). Non-streaming.

**Tools** (each runs against the authenticated user; all read-only except `submit_feedback`):
| tool | args | returns |
|------|------|---------|
| `get_wardrobe` | — | `{count, items:[<display name>...]}` — the user's saved garments (same source as `GET /api/wardrobe`, `list_wardrobe` by nickname). |
| `get_recent_activity` | — | `{available, events:[{type,meta,when}], totals:{generations,fails,retries,total_spend_usd}, last_failure:{op,error,when}\|null}` — recent generate/generate_fail/generate_retry/scan/… so the bot can explain *why the last try-on failed* (from `imagegen_events` / `imagegen_usage`, via `db.recent_activity`). `{available:false}` in local/no-DB mode. |
| `get_feature_help` | `{topic: "추출"\|"입히기"\|"옷장"\|"피드백"\|"전반"}` | `{topic, help:"<canned Korean guidance>"}` — accurate to the real flow (upload→scan/extract→closet→try-on; try-on = 1 person photo + up to 4 garments). |
| `submit_feedback` | `{message:"<str>"}` | files feedback (same path as `/api/feedback`: inserts `imagegen_feedback` + logs `feedback_submit` with `via:"chat"`). Offered when the user reports a bug or wants a feature; only run on user consent. |

---

## Admin endpoints (require admin token; 403 otherwise). Admin users are excluded from user-facing stats.

Responses are **snake_case** and lists are wrapped (`{"users":[…]}`, `{"feedback":[…]}`).
The admin dashboard adapts these to its internal camelCase in `admin.js` (`adaptOverview`/
`adaptUsers`/`adaptFeedback`); it also converts each cohort's `retention` **count dict**
(`{"<week-offset>": active_count}`) into a **ratio array** (`active/size`) for the heatmap.

### `GET /api/admin/overview`
```
{
  "total_users": int,          // non-admin users
  "new_users_today": int,
  "dau": int, "wau": int, "mau": int,   // active = last_seen or any event in 1/7/30d
  "total_generations": int,    // 'generate' events (non-admin)
  "total_failures": int,       // 'generate_fail' events
  "total_retries": int,        // 'generate_retry' events
  "fail_rate": float,          // failures / (generations + failures)
  "total_spend_usd": float,    // sum(cost_micro)/1e6
  "spend_today_usd": float,
  "cohorts": [ {"cohort":"YYYY-MM-DD", "size":int, "retention": {"<week_offset>": int}} ]
}
```

### `GET /api/admin/users`
```
{"users": [ {
  "nickname": str, "is_admin": bool,
  "generations": int, "fails": int, "retries": int,
  "total_spend_usd": float,
  "first_seen": "<iso8601>", "last_seen": "<iso8601>",
  "days_active": int        // distinct days with any event
}, ... ]}   // sorted by last_seen desc
```

### `GET /api/admin/feedback`
```
{"feedback": [ {"nickname": str, "message": str, "created_at": "<iso8601>"}, ... ]}  // newest first
```

---

## Event types (imagegen_events.type)
`signup`, `login`, `generate`, `extract`, `combine`, `edit`, `generate_fail`,
`generate_retry`, `scan`, `wardrobe_save`, `delete`, `graph_save`, `feedback_submit`,
`chat`. `meta` is JSONB with op-specific details. Logging is best-effort (never blocks/throws).
The help chatbot logs a `chat` event per turn (`meta:{n_msg, tools, cost}`) and a `chat`
usage row (its OpenRouter cost); `submit_feedback` from within chat logs `feedback_submit`
with `meta.via="chat"`.

## Cost units
`imagegen_usage.cost_micro` and `imagegen_images.cost_micro` = `round(usd * 1_000_000)`.
The image cost is the REAL OpenRouter `usage.cost` for FLUX.2 Klein (billed by image
tokens ~ output resolution). Observed live: a 1:1 / 9:16 generation ≈ $0.021 → **~21000**
micro (dynamic per call — no hardcoded assumption). VLM steps (describe/scan/verify) add
their own sub-cent `usage.cost` on top of the response `cost` field, but the DB `add_usage`
/ `log_image` rows record only the image-gen cost for the op.
