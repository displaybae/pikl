#!/usr/bin/env python3
"""Postgres layer for the imagegen wardrobe app.

Mirrors chara-backend/src/lib/db.js house style: raw psycopg2, a small connection
pool, idempotent CREATE TABLE IF NOT EXISTS init(), and GRACEFUL DEGRADATION —
if DATABASE_URL is not set, `enabled` is False and every helper is a no-op so the
app still runs as a single-user local tool (graphs fall back to local JSON files,
no analytics).

All tables are namespaced `imagegen_*` and are fully isolated from the shared
railway DB's existing accounts / events / usage_log / feedback tables.
"""
import json
import os
import threading

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2.pool import ThreadedConnectionPool
    _HAVE_PG = True
except Exception:  # pragma: no cover - psycopg2 not installed
    _HAVE_PG = False

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
enabled = bool(DATABASE_URL) and _HAVE_PG

_pool = None
_pool_lock = threading.Lock()


def _ssl_kwargs():
    # Railway's private network (*.railway.internal) needs no TLS; the public
    # proxy does — but it presents its own cert, so we relax verification there.
    if "railway.internal" in DATABASE_URL:
        return {"sslmode": "disable"}
    return {"sslmode": "require"}


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = ThreadedConnectionPool(
                    1, 8, dsn=DATABASE_URL, connect_timeout=15, **_ssl_kwargs()
                )
    return _pool


class _Conn:
    """Context manager that borrows a pooled connection and returns it."""

    def __enter__(self):
        self.conn = _get_pool().getconn()
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.conn.commit()
            else:
                self.conn.rollback()
        finally:
            _get_pool().putconn(self.conn)


def _query(sql, params=None, fetch=None):
    """Run a statement. fetch: None | 'one' | 'all'. Returns rows as dicts."""
    with _Conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params or ())
            if fetch == "one":
                return cur.fetchone()
            if fetch == "all":
                return cur.fetchall()
            return None


# ── schema ───────────────────────────────────────────────────────────────────
def init():
    if not enabled:
        print("[db] DATABASE_URL not set (or psycopg2 missing) — analytics OFF, "
              "graphs fall back to local JSON files.")
        return
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS imagegen_users (
                  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                  nickname     TEXT UNIQUE NOT NULL,
                  is_admin     BOOLEAN NOT NULL DEFAULT FALSE,
                  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )""")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS imagegen_events (
                  id         BIGSERIAL PRIMARY KEY,
                  user_id    UUID REFERENCES imagegen_users(id) ON DELETE CASCADE,
                  type       TEXT,
                  meta       JSONB,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_imagegen_events_user "
                        "ON imagegen_events(user_id, created_at DESC)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_imagegen_events_type "
                        "ON imagegen_events(type, created_at DESC)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS imagegen_usage (
                  id         BIGSERIAL PRIMARY KEY,
                  user_id    UUID REFERENCES imagegen_users(id) ON DELETE CASCADE,
                  op         TEXT,
                  cost_micro BIGINT,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_imagegen_usage_user "
                        "ON imagegen_usage(user_id, created_at DESC)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS imagegen_feedback (
                  id         BIGSERIAL PRIMARY KEY,
                  user_id    UUID REFERENCES imagegen_users(id) ON DELETE SET NULL,
                  nickname   TEXT,
                  message    TEXT NOT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )""")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS imagegen_images (
                  id         BIGSERIAL PRIMARY KEY,
                  user_id    UUID REFERENCES imagegen_users(id) ON DELETE CASCADE,
                  r2_key     TEXT,
                  op         TEXT,
                  prompt     TEXT,
                  cost_micro BIGINT,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )""")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_imagegen_images_user "
                        "ON imagegen_images(user_id, created_at DESC)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS imagegen_graphs (
                  user_id    UUID REFERENCES imagegen_users(id) ON DELETE CASCADE,
                  name       TEXT,
                  data       JSONB,
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                  PRIMARY KEY (user_id, name)
                )""")
    print("[db] imagegen_* schema ready.")


def ping():
    if not enabled:
        return {"ok": False, "code": "no_database_url"}
    try:
        _query("SELECT 1", fetch="one")
        return {"ok": True}
    except Exception as e:  # pragma: no cover
        return {"ok": False, "code": "error", "msg": str(e)[:160]}


# ── users / auth ──────────────────────────────────────────────────────────────
def upsert_user(nickname, is_admin=False):
    """Create-or-touch a user. Returns (row_dict, is_new)."""
    if not enabled:
        return None, False
    existing = _query("SELECT * FROM imagegen_users WHERE nickname=%s",
                      (nickname,), fetch="one")
    if existing:
        row = _query(
            "UPDATE imagegen_users SET last_seen_at=now(), "
            "is_admin = is_admin OR %s WHERE nickname=%s RETURNING *",
            (is_admin, nickname), fetch="one")
        return row, False
    row = _query(
        "INSERT INTO imagegen_users (nickname, is_admin) VALUES (%s, %s) "
        "RETURNING *", (nickname, is_admin), fetch="one")
    return row, True


def get_user(user_id):
    if not enabled or not user_id:
        return None
    return _query("SELECT * FROM imagegen_users WHERE id=%s", (user_id,), fetch="one")


def touch_last_seen(user_id):
    if not enabled or not user_id:
        return
    try:
        _query("UPDATE imagegen_users SET last_seen_at=now() WHERE id=%s", (user_id,))
    except Exception as e:  # pragma: no cover
        print("[db] touch_last_seen failed:", e)


# ── best-effort logging (never throws to caller) ──────────────────────────────
def log_event(user_id, type_, meta=None):
    if not enabled or not user_id or not type_:
        return
    try:
        _query("INSERT INTO imagegen_events (user_id, type, meta) VALUES (%s, %s, %s)",
               (user_id, str(type_)[:60],
                json.dumps(meta)[:4000] if meta is not None else None))
    except Exception as e:
        print("[db] log_event failed:", e)


def add_usage(user_id, op, usd):
    if not enabled or not user_id:
        return
    try:
        micro = int(round(float(usd or 0) * 1_000_000))
        _query("INSERT INTO imagegen_usage (user_id, op, cost_micro) VALUES (%s, %s, %s)",
               (user_id, str(op)[:60], micro))
    except Exception as e:
        print("[db] add_usage failed:", e)


def log_image(user_id, r2_key, op, prompt, usd):
    if not enabled or not user_id:
        return
    try:
        micro = int(round(float(usd or 0) * 1_000_000))
        _query("INSERT INTO imagegen_images (user_id, r2_key, op, prompt, cost_micro) "
               "VALUES (%s, %s, %s, %s, %s)",
               (user_id, r2_key, str(op)[:60],
                (prompt or "")[:2000], micro))
    except Exception as e:
        print("[db] log_image failed:", e)


def add_feedback(user_id, nickname, message):
    if not enabled:
        return None
    return _query(
        "INSERT INTO imagegen_feedback (user_id, nickname, message) "
        "VALUES (%s, %s, %s) RETURNING id",
        (user_id, nickname, message), fetch="one")


# ── help chatbot: per-user recent activity (read-only) ────────────────────────
def recent_activity(user_id, limit=12):
    """A compact snapshot of one user's recent activity, for the help chatbot's
    `get_recent_activity` tool. Read-only. Returns {} if DB is off or no user.

    - `events`: the last `limit` imagegen_events (type, meta, when) — includes
      generate / generate_fail (with error) / generate_retry / scan / etc. so the
      bot can explain "직전 입히기가 왜 실패했는지".
    - `totals`: lifetime generate / fail / retry counts + total spend (USD).
    - `last_failure`: the most recent generate_fail (op + error text), if any.
    """
    if not enabled or not user_id:
        return {}
    events = _query("""
        SELECT type, meta, created_at FROM imagegen_events
        WHERE user_id=%s ORDER BY created_at DESC LIMIT %s
    """, (user_id, limit), fetch="all") or []
    totals = _query("""
        SELECT
          COALESCE((SELECT COUNT(*) FROM imagegen_events
             WHERE user_id=%(u)s AND type='generate'),0)::int AS generations,
          COALESCE((SELECT COUNT(*) FROM imagegen_events
             WHERE user_id=%(u)s AND type='generate_fail'),0)::int AS fails,
          COALESCE((SELECT COUNT(*) FROM imagegen_events
             WHERE user_id=%(u)s AND type='generate_retry'),0)::int AS retries,
          COALESCE((SELECT SUM(cost_micro) FROM imagegen_usage
             WHERE user_id=%(u)s),0)::bigint AS spend_micro
    """, {"u": user_id}, fetch="one") or {}
    last_fail = _query("""
        SELECT meta, created_at FROM imagegen_events
        WHERE user_id=%s AND type='generate_fail'
        ORDER BY created_at DESC LIMIT 1
    """, (user_id,), fetch="one")
    return {
        "events": [{
            "type": e["type"],
            "meta": e["meta"],
            "when": e["created_at"].isoformat() if e["created_at"] else None,
        } for e in events],
        "totals": {
            "generations": totals.get("generations", 0),
            "fails": totals.get("fails", 0),
            "retries": totals.get("retries", 0),
            "total_spend_usd": round((totals.get("spend_micro") or 0) / 1_000_000, 6),
        },
        "last_failure": ({
            "op": (last_fail["meta"] or {}).get("op"),
            "error": (last_fail["meta"] or {}).get("error"),
            "when": last_fail["created_at"].isoformat() if last_fail["created_at"] else None,
        } if last_fail else None),
    }


# ── graph persistence (Postgres, keyed by user) ───────────────────────────────
def save_graph(user_id, name, data):
    if not enabled or not user_id:
        return False
    _query(
        "INSERT INTO imagegen_graphs (user_id, name, data, updated_at) "
        "VALUES (%s, %s, %s, now()) "
        "ON CONFLICT (user_id, name) DO UPDATE SET data=EXCLUDED.data, updated_at=now()",
        (user_id, name, json.dumps(data, ensure_ascii=False)))
    return True


def get_graph(user_id, name):
    if not enabled or not user_id:
        return None
    row = _query("SELECT data FROM imagegen_graphs WHERE user_id=%s AND name=%s",
                 (user_id, name), fetch="one")
    return row["data"] if row else None


def list_graphs(user_id):
    if not enabled or not user_id:
        return []
    rows = _query("SELECT name FROM imagegen_graphs WHERE user_id=%s ORDER BY name",
                  (user_id,), fetch="all")
    return [r["name"] for r in rows]


def delete_graph(user_id, name):
    if not enabled or not user_id:
        return
    _query("DELETE FROM imagegen_graphs WHERE user_id=%s AND name=%s", (user_id, name))


# ── admin dashboard queries ───────────────────────────────────────────────────
def admin_overview():
    """Retention/activity/spend summary. Admin users excluded from user stats."""
    if not enabled:
        return None
    summary = _query("""
        SELECT
          (SELECT COUNT(*) FROM imagegen_users WHERE NOT is_admin)::int AS total_users,
          (SELECT COUNT(*) FROM imagegen_users WHERE NOT is_admin
             AND created_at >= now()-interval '1 day')::int AS new_1d,
          (SELECT COUNT(*) FROM imagegen_users u WHERE NOT u.is_admin AND (
             u.last_seen_at >= now()-interval '1 day'
             OR EXISTS (SELECT 1 FROM imagegen_events e WHERE e.user_id=u.id
                        AND e.created_at >= now()-interval '1 day')))::int AS active_1d,
          (SELECT COUNT(*) FROM imagegen_users u WHERE NOT u.is_admin AND (
             u.last_seen_at >= now()-interval '7 day'
             OR EXISTS (SELECT 1 FROM imagegen_events e WHERE e.user_id=u.id
                        AND e.created_at >= now()-interval '7 day')))::int AS active_7d,
          (SELECT COUNT(*) FROM imagegen_users u WHERE NOT u.is_admin AND (
             u.last_seen_at >= now()-interval '30 day'
             OR EXISTS (SELECT 1 FROM imagegen_events e WHERE e.user_id=u.id
                        AND e.created_at >= now()-interval '30 day')))::int AS active_30d
    """, fetch="one")

    gens = _query("""
        SELECT
          (SELECT COUNT(*) FROM imagegen_events e JOIN imagegen_users u ON u.id=e.user_id
             WHERE NOT u.is_admin AND e.type='generate')::int AS total_generations,
          (SELECT COUNT(*) FROM imagegen_events e JOIN imagegen_users u ON u.id=e.user_id
             WHERE NOT u.is_admin AND e.type='generate_fail')::int AS total_failures,
          (SELECT COUNT(*) FROM imagegen_events e JOIN imagegen_users u ON u.id=e.user_id
             WHERE NOT u.is_admin AND e.type='generate_retry')::int AS total_retries,
          (SELECT COALESCE(SUM(x.cost_micro),0)::bigint FROM imagegen_usage x
             JOIN imagegen_users u ON u.id=x.user_id WHERE NOT u.is_admin) AS spend_micro,
          (SELECT COALESCE(SUM(x.cost_micro),0)::bigint FROM imagegen_usage x
             JOIN imagegen_users u ON u.id=x.user_id
             WHERE NOT u.is_admin AND x.created_at >= now()-interval '1 day')
             AS spend_today_micro
    """, fetch="one")

    # retention cohorts by signup week (mirror getStats)
    sizes = _query("""
        SELECT date_trunc('week', created_at) AS cohort, COUNT(*)::int AS size
        FROM imagegen_users WHERE NOT is_admin GROUP BY cohort ORDER BY cohort
    """, fetch="all")
    active = _query("""
        WITH signup AS (
          SELECT id, date_trunc('week', created_at) AS cohort
          FROM imagegen_users WHERE NOT is_admin
        ), activity AS (
          SELECT DISTINCT user_id, date_trunc('week', created_at) AS wk
          FROM imagegen_events
        )
        SELECT s.cohort,
               FLOOR(EXTRACT(EPOCH FROM (a.wk - s.cohort)) / 604800)::int AS offset_w,
               COUNT(DISTINCT s.id)::int AS active
        FROM signup s JOIN activity a ON a.user_id = s.id AND a.wk >= s.cohort
        GROUP BY s.cohort, offset_w
    """, fetch="all")

    by_cohort = {}
    for r in sizes:
        key = r["cohort"].date().isoformat()
        by_cohort[key] = {"cohort": key, "size": r["size"], "retention": {}}
    for r in active:
        key = r["cohort"].date().isoformat()
        if key in by_cohort:
            by_cohort[key]["retention"][str(r["offset_w"])] = r["active"]
    cohorts = sorted(by_cohort.values(), key=lambda c: c["cohort"])

    total_gen = gens["total_generations"]
    total_fail = gens["total_failures"]
    fail_rate = round(total_fail / (total_gen + total_fail), 4) if (total_gen + total_fail) else 0.0
    return {
        "total_users": summary["total_users"],
        "new_users_today": summary["new_1d"],
        "dau": summary["active_1d"],
        "wau": summary["active_7d"],
        "mau": summary["active_30d"],
        "total_generations": total_gen,
        "total_failures": total_fail,
        "total_retries": gens["total_retries"],
        "fail_rate": fail_rate,
        "total_spend_usd": round((gens["spend_micro"] or 0) / 1_000_000, 6),
        "spend_today_usd": round((gens["spend_today_micro"] or 0) / 1_000_000, 6),
        "cohorts": cohorts,
    }


def admin_users():
    if not enabled:
        return []
    rows = _query("""
        SELECT u.nickname, u.is_admin, u.created_at AS first_seen, u.last_seen_at AS last_seen,
          COALESCE((SELECT COUNT(*) FROM imagegen_events e
             WHERE e.user_id=u.id AND e.type='generate'),0)::int AS generations,
          COALESCE((SELECT COUNT(*) FROM imagegen_events e
             WHERE e.user_id=u.id AND e.type='generate_fail'),0)::int AS fails,
          COALESCE((SELECT COUNT(*) FROM imagegen_events e
             WHERE e.user_id=u.id AND e.type='generate_retry'),0)::int AS retries,
          COALESCE((SELECT SUM(x.cost_micro) FROM imagegen_usage x
             WHERE x.user_id=u.id),0)::bigint AS spend_micro,
          COALESCE((SELECT COUNT(DISTINCT date_trunc('day', e.created_at))
             FROM imagegen_events e WHERE e.user_id=u.id),0)::int AS days_active
        FROM imagegen_users u
        ORDER BY u.last_seen_at DESC
    """, fetch="all")
    out = []
    for r in rows:
        out.append({
            "nickname": r["nickname"],
            "is_admin": r["is_admin"],
            "generations": r["generations"],
            "fails": r["fails"],
            "retries": r["retries"],
            "total_spend_usd": round((r["spend_micro"] or 0) / 1_000_000, 6),
            "first_seen": r["first_seen"].isoformat() if r["first_seen"] else None,
            "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None,
            "days_active": r["days_active"],
        })
    return out


def admin_feedback(limit=200):
    if not enabled:
        return []
    rows = _query("""
        SELECT nickname, message, created_at FROM imagegen_feedback
        ORDER BY created_at DESC LIMIT %s
    """, (limit,), fetch="all")
    return [{"nickname": r["nickname"], "message": r["message"],
             "created_at": r["created_at"].isoformat()} for r in rows]
