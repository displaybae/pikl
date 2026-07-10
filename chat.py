#!/usr/bin/env python3
"""픽클(Pikl) 도움말 챗봇 — OpenRouter Gemini 3.1 Flash Lite + 툴 콜링.

지원 상담원처럼, 유저가 문제(추출/입히기/옷장)에 부딪혔을 때 유저의 실제 상태를
'툴(function calling)'로 들여다보고 구체적으로 도와준다. 툴은 전부 읽기 전용이며,
유일한 쓰기 툴은 `submit_feedback`(피드백 접수) 하나뿐 — 파괴적 동작 없음.

house style: nodeapp.py의 `openrouter()`(SDK 없는 raw chat/completions)를 그대로 쓰고,
chara-backend agent.js의 tool-call 루프 형태를 따른다 (messages+tools → tool_calls면
서버에서 실행 → role:"tool" 결과 append → 다시 호출 → 최대 N회 → 최종 assistant 텍스트).

nodeapp.py는 이 모듈을 import 하므로, 순환참조를 피하려고 nodeapp의 헬퍼(openrouter/
list_wardrobe)와 db는 함수 안에서 지연 import 한다.
"""
import json
import os

CHAT_MODEL = os.environ.get("CHAT_MODEL", "google/gemini-3.1-flash-lite")
MAX_ITERS = 4  # tool-call 왕복 상한 (무한루프 방지)

SYSTEM_PROMPT = (
    "너는 '픽클(Pikl)'이라는 옷장/가상 피팅 앱의 친절하고 간결한 도우미야. "
    "픽클은 이렇게 동작해: 사진을 올리면(업로드) → 스캔/추출로 옷을 제품컷으로 만들어 옷장에 담고 "
    "→ 옷장의 옷을 사람 사진에 입혀보는(입히기/가상 피팅) 앱이야. 입히기는 사람 사진 1장 + 옷장 옷 "
    "최대 4벌까지 한 번에 넣을 수 있어.\n\n"
    "행동 지침:\n"
    "- 추측하기 전에 툴로 유저의 '진짜' 상태를 먼저 확인해. 옷장 얘기가 나오면 get_wardrobe, "
    "'방금/직전에 왜 안 됐어' 같은 문제 제보엔 get_recent_activity로 실제 실패 원인을 확인하고 "
    "설명해. 기능 사용법 질문은 get_feature_help로 정확한 안내를 가져와.\n"
    "- 답변은 짧고 명확하게 한국어로. 앱에 없는 기능을 지어내지 마. 모르면 모른다고 솔직히 말해.\n"
    "- 실제 버그로 보이거나 유저가 기능 요청/불만을 강하게 말하면, submit_feedback으로 남겨줄지 "
    "제안하고, 동의하면 접수해. 접수는 유저가 원할 때만.\n"
    "- 유저의 개인 데이터(옷장/활동)는 도와주는 목적으로만 쓰고, 불필요하게 나열하지 마."
)

# ── canned 기능 도움말 (앱 실제 동작에 맞춰 직접 작성) ─────────────────────────────
_FEATURE_HELP = {
    "추출": (
        "옷 추출/스캔: 옷 사진(착샷도 OK)을 올리면 픽클이 그 옷만 흰 배경 제품컷으로 뽑아내 옷장에 담아요. "
        "사람이 입고 있는 사진이면 자동으로 옷만 분리하고, 이미 제품컷이면 그대로 담겨요. "
        "한 사진에 여러 옷이 있으면 스캔이 상의/하의/신발 등으로 항목을 나눠줘요. "
        "잘 안 되면 옷이 잘 보이고 배경이 단순한 사진으로 다시 시도해 보세요."
    ),
    "입히기": (
        "입히기(가상 피팅): 사람 사진 1장을 고르고, 옷장에서 입혀볼 옷을 최대 4벌까지 골라 실행하면 "
        "그 사람이 그 옷들을 입은 모습을 만들어줘요. 사람 정면·전신이 잘 보이는 사진일수록 결과가 좋고, "
        "결과가 어색하면 다시 실행하거나 옷/사진을 바꿔보세요. 결과가 마음에 들면 저장할 수 있어요."
    ),
    "옷장": (
        "옷장: 추출/스캔으로 담은 옷들이 모이는 곳이에요. 여기 있는 옷을 입히기에 골라 쓰고, "
        "필요 없는 옷은 삭제할 수 있어요. 옷은 카테고리(상의/하의/아우터/신발 등)로 담겨요."
    ),
    "피드백": (
        "피드백: 버그 제보나 기능 요청은 언제든 남길 수 있어요. 원하시면 제가 지금 대화 내용으로 "
        "대신 접수해 드릴게요 — 남기실 내용만 알려주세요."
    ),
    "전반": (
        "픽클 기본 흐름: (1) 사진 업로드 → (2) 스캔/추출로 옷을 제품컷으로 만들어 옷장에 담기 → "
        "(3) 옷장에서 옷을 골라 사람 사진에 입혀보기. 입히기는 사람 1장 + 옷 최대 4벌이에요. "
        "막히는 단계를 알려주시면 그 부분을 콕 집어 도와드릴게요."
    ),
}

# ── OpenAI function schema (툴 정의) ───────────────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_wardrobe",
            "description": "지금 로그인한 유저의 옷장에 저장된 옷 목록(개수와 항목 이름)을 가져온다. "
                           "옷장에 뭐가 있는지/비었는지 확인할 때 사용.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_recent_activity",
            "description": "지금 로그인한 유저의 최근 활동(최근 생성/입히기/추출 이력, 성공·실패 여부와 "
                           "실패 사유, 재시도, 총 사용 비용)을 가져온다. '방금/직전에 왜 안 됐는지' 같은 "
                           "문제를 설명할 때 사용.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_feature_help",
            "description": "특정 기능의 정확한 한국어 사용 안내를 가져온다. 앱 실제 동작 기준.",
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "enum": ["추출", "입히기", "옷장", "피드백", "전반"],
                        "description": "안내가 필요한 주제.",
                    }
                },
                "required": ["topic"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_feedback",
            "description": "유저의 버그 제보나 기능 요청을 운영자에게 피드백으로 접수한다. "
                           "유저가 남기길 원할 때만 호출. 접수할 내용을 message에 담는다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "접수할 피드백 본문(유저의 제보/요청 내용).",
                    }
                },
                "required": ["message"],
                "additionalProperties": False,
            },
        },
    },
]


# ── 툴 실행기 (각 툴은 현재 user에 대해 실제 데이터로 동작; 피드백 외엔 읽기 전용) ────
def _tool_get_wardrobe(user):
    import nodeapp
    items = nodeapp.list_wardrobe(user)  # keyed by user_id (falls back to nickname locally)
    names = [it["file"] for it in items]
    return {"count": len(items), "items": names[:60]}


def _tool_get_recent_activity(user):
    import db
    uid = user.get("user_id")
    if not uid or not db.enabled:
        return {"available": False,
                "note": "활동 기록을 지금은 조회할 수 없어요(로컬 모드이거나 기록이 없어요)."}
    snap = db.recent_activity(uid, limit=12)
    if not snap:
        return {"available": False, "note": "아직 활동 기록이 없어요."}
    snap["available"] = True
    return snap


def _tool_get_feature_help(topic):
    text = _FEATURE_HELP.get(topic)
    if not text:
        return {"topic": topic, "help": _FEATURE_HELP["전반"]}
    return {"topic": topic, "help": text}


def _tool_submit_feedback(user, message):
    import db
    msg = (message or "").strip()[:4000]
    if not msg:
        return {"ok": False, "note": "빈 메시지는 접수할 수 없어요."}
    try:
        db.add_feedback(user.get("user_id"), user.get("nickname"), msg)
        db.log_event(user.get("user_id"), "feedback_submit", {"len": len(msg), "via": "chat"})
        return {"ok": True, "note": "피드백을 접수했어요."}
    except Exception as e:  # pragma: no cover - best-effort
        print("[chat] submit_feedback failed:", str(e)[:160])
        return {"ok": False, "note": "접수 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요."}


def _execute_tool(name, args, user):
    """툴 이름+인자 → JSON 직렬화 가능한 결과 dict. 알 수 없는 툴/오류는 구조화 에러로."""
    try:
        if name == "get_wardrobe":
            return _tool_get_wardrobe(user)
        if name == "get_recent_activity":
            return _tool_get_recent_activity(user)
        if name == "get_feature_help":
            return _tool_get_feature_help(args.get("topic", "전반"))
        if name == "submit_feedback":
            return _tool_submit_feedback(user, args.get("message", ""))
        return {"error": f"알 수 없는 툴: {name}"}
    except Exception as e:
        print(f"[chat] tool {name} failed:", str(e)[:200])
        return {"error": "툴 실행 중 문제가 생겼어요."}


# ── 대화 (툴 콜링 루프) ────────────────────────────────────────────────────────
def _sanitize_history(messages):
    """클라이언트가 보낸 running conversation을 정제. user/assistant 텍스트만 신뢰하고
    system 역할은 절대 받지 않는다(서버가 붙임). 각 content는 문자열로 강제."""
    out = []
    for m in (messages or [])[-30:]:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        out.append({"role": role, "content": content if isinstance(content, str) else ""})
    # 첫 메시지는 user여야 자연스러움 — 앞쪽 assistant는 정리
    while out and out[0]["role"] != "user":
        out.pop(0)
    return out


def chat(messages, user):
    """한 번의 챗 요청 처리. `messages`는 클라이언트의 대화 이력(system 제외),
    `user`는 {user_id, nickname, is_admin}. OpenAI식 tool-calling 루프를 돌려
    최종 assistant 텍스트를 만든다.

    반환: {"reply": <str>, "cost": <usd float>, "tools_used": [<name>...]}.
    OpenRouter 장애 시엔 예외를 던지므로(호출부에서 graceful fallback), 여기선
    루프/툴만 책임진다.
    """
    import nodeapp  # 지연 import (순환참조 회피): openrouter() 헬퍼 재사용

    convo = [{"role": "system", "content": SYSTEM_PROMPT}] + _sanitize_history(messages)
    total_cost = 0.0
    tools_used = []
    reply = ""

    for _ in range(MAX_ITERS):
        d = nodeapp.openrouter({
            "model": CHAT_MODEL,
            "messages": convo,
            "tools": TOOLS,
            "tool_choice": "auto",
        }, timeout=60)
        total_cost += d.get("usage", {}).get("cost", 0) or 0
        msg = d["choices"][0]["message"]
        tool_calls = msg.get("tool_calls") or []

        # assistant 메시지를 대화에 그대로 append (tool_calls 포함해야 provider가 받아줌)
        assistant_msg = {"role": "assistant", "content": msg.get("content") or ""}
        if tool_calls:
            assistant_msg["tool_calls"] = tool_calls
        convo.append(assistant_msg)

        if not tool_calls:
            reply = (msg.get("content") or "").strip()
            break

        # 각 tool_call 실행 → role:"tool" 결과 append
        for tc in tool_calls:
            fn = tc.get("function", {})
            name = fn.get("name", "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except Exception:
                args = {}
            result = _execute_tool(name, args, user)
            tools_used.append(name)
            convo.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": json.dumps(result, ensure_ascii=False),
            })
        # 다음 iteration에서 툴 결과를 반영한 응답을 다시 받음
    else:
        # MAX_ITERS를 다 썼는데도 계속 툴만 부름 — 마지막으로 텍스트만 유도
        try:
            d = nodeapp.openrouter({
                "model": CHAT_MODEL,
                "messages": convo + [{"role": "user", "content":
                                      "지금까지 확인한 내용으로 짧게 한국어로 정리해서 답해줘."}],
            }, timeout=60)
            total_cost += d.get("usage", {}).get("cost", 0) or 0
            reply = (d["choices"][0]["message"].get("content") or "").strip()
        except Exception:
            reply = ""

    if not reply:
        reply = "죄송해요, 방금 답변을 정리하지 못했어요. 다시 한 번 물어봐 주시겠어요?"
    return {"reply": reply, "cost": round(total_cost, 6), "tools_used": tools_used}
