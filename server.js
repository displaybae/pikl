const fs = require("fs");
const path = require("path");
const http = require("http");
const { Pool } = require("pg");

const port = Number(process.env.PORT) || 3000;
const host = "0.0.0.0";
const envCandidates = [
  path.join(__dirname, ".env"),
  path.join(__dirname, "..", "project", ".env"),
];

function loadOpenAIKey() {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("OPENAI_API_KEY=")) continue;
      return trimmed.slice("OPENAI_API_KEY=".length).trim();
    }
  }
  return "";
}

const openAIKey = loadOpenAIKey();

// PostgreSQL
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  `);
  // 7일 지난 세션 자동 삭제
  const { rowCount } = await pool.query(
    "DELETE FROM messages WHERE created_at < NOW() - INTERVAL '7 days'"
  );
  if (rowCount > 0) console.log(`Cleaned up ${rowCount} old messages`);
  console.log("DB ready");
}

async function deleteSession(sessionId) {
  if (!pool) return;
  await pool.query("DELETE FROM messages WHERE session_id = $1", [sessionId]);
}

async function getHistory(sessionId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    "SELECT role, content FROM messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 40",
    [sessionId]
  );
  return rows;
}

async function saveMessage(sessionId, role, content) {
  if (!pool) return;
  await pool.query(
    "INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)",
    [sessionId, role, content]
  );
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleChat(req, res) {
  if (!openAIKey) {
    sendJson(res, 500, { error: "OPENAI_API_KEY not found." });
    return;
  }

  let message = "", sessionId = "";
  try {
    const body = await readJsonBody(req);
    message = String(body.message || "").trim();
    sessionId = String(body.sessionId || "").trim();
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  if (!message) {
    sendJson(res, 400, { error: "message is required." });
    return;
  }
  if (!sessionId) {
    sendJson(res, 400, { error: "sessionId is required." });
    return;
  }

  try {
    const history = await getHistory(sessionId);

    const input = [
      {
        role: "system",
        content: [{ type: "input_text", text: "You are a helpful assistant. Respond in the same language the user uses." }],
      },
      ...history.map((m) => ({
        role: m.role,
        content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
      })),
      {
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    ];

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAIKey}`,
      },
      body: JSON.stringify({ model: "gpt-5.4-nano", input }),
    });

    const data = await response.json();

    if (!response.ok) {
      const apiError = data?.error?.message || "OpenAI request failed.";
      sendJson(res, response.status, { error: apiError });
      return;
    }

    const reply = data.output?.[0]?.content?.[0]?.text || "No text returned.";

    await saveMessage(sessionId, "user", message);
    await saveMessage(sessionId, "assistant", reply);

    sendJson(res, 200, { reply });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown server error." });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, openaiConfigured: Boolean(openAIKey), db: Boolean(pool) });
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/session/delete") {
    try {
      const body = await readJsonBody(req);
      const sessionId = String(body.sessionId || "").trim();
      if (sessionId) await deleteSession(sessionId);
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 400, { error: "Invalid request." });
    }
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pikl chat</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: "Söhne", "ui-sans-serif", system-ui, -apple-system, sans-serif;
        background: #212121;
        color: #ececec;
        height: 100dvh;
        display: flex;
        flex-direction: column;
      }
      #chat-window {
        flex: 1;
        overflow-y: auto;
        padding: 24px 0;
        scroll-behavior: smooth;
      }
      #chat-window::-webkit-scrollbar { width: 6px; }
      #chat-window::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
      .msg-row {
        display: flex;
        justify-content: center;
        padding: 4px 16px;
      }
      .msg-inner {
        width: 100%;
        max-width: 720px;
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 600;
        margin-top: 2px;
      }
      .avatar.user { background: #19c37d; color: #fff; }
      .avatar.assistant { background: #444654; color: #fff; }
      .msg-content {
        flex: 1;
        font-size: 15px;
        line-height: 1.7;
        padding-top: 3px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .msg-content.user { color: #ececec; }
      .msg-content.assistant { color: #d1d5db; }
      .thinking {
        display: flex;
        gap: 4px;
        align-items: center;
        padding-top: 6px;
      }
      .thinking span {
        width: 7px; height: 7px;
        background: #888;
        border-radius: 50%;
        animation: blink 1.2s infinite;
      }
      .thinking span:nth-child(2) { animation-delay: 0.2s; }
      .thinking span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes blink {
        0%, 80%, 100% { opacity: 0.2; }
        40% { opacity: 1; }
      }
      #input-bar {
        padding: 12px 16px 20px;
        display: flex;
        justify-content: center;
        background: #212121;
      }
      #input-wrap {
        width: 100%;
        max-width: 720px;
        background: #2f2f2f;
        border-radius: 16px;
        display: flex;
        align-items: flex-end;
        padding: 10px 12px;
        gap: 8px;
        border: 1px solid #3f3f3f;
        transition: border-color 0.15s;
      }
      #input-wrap:focus-within { border-color: #666; }
      #message {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        color: #ececec;
        font: inherit;
        font-size: 15px;
        resize: none;
        max-height: 200px;
        line-height: 1.5;
        padding: 2px 0;
      }
      #message::placeholder { color: #666; }
      #send-btn {
        width: 34px;
        height: 34px;
        border-radius: 8px;
        border: none;
        background: #19c37d;
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.15s;
      }
      #send-btn:disabled { background: #3f3f3f; cursor: default; }
      #send-btn svg { width: 16px; height: 16px; }
      #empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        gap: 8px;
        color: #888;
      }
      #empty-state h2 { font-size: 22px; color: #ececec; font-weight: 600; }
      #empty-state p { font-size: 14px; }
      #new-chat-btn {
        position: fixed;
        top: 16px;
        right: 16px;
        background: #2f2f2f;
        border: 1px solid #3f3f3f;
        color: #ececec;
        border-radius: 8px;
        padding: 7px 14px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
        transition: background 0.15s;
      }
      #new-chat-btn:hover { background: #3f3f3f; }
    </style>
  </head>
  <body>
    <button id="new-chat-btn">새 대화</button>
    <div id="chat-window">
      <div id="empty-state">
        <h2>pikl chat</h2>
        <p>무엇이든 물어보세요.</p>
      </div>
    </div>
    <div id="input-bar">
      <div id="input-wrap">
        <textarea id="message" rows="1" placeholder="메시지 보내기"></textarea>
        <button id="send-btn" disabled>
          <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 1.5L8 14.5M8 1.5L3 6.5M8 1.5L13 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
    <script>
      const chatWindow = document.getElementById("chat-window");
      let emptyState = document.getElementById("empty-state");
      const textarea = document.getElementById("message");
      const sendBtn = document.getElementById("send-btn");

      // 세션 ID: 새로고침해도 유지, 브라우저마다 다름
      let sessionId = localStorage.getItem("pikl_session");
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        localStorage.setItem("pikl_session", sessionId);
      }

      textarea.addEventListener("input", () => {
        textarea.style.height = "auto";
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
        sendBtn.disabled = !textarea.value.trim();
      });

      textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (!sendBtn.disabled) sendMessage();
        }
      });

      sendBtn.addEventListener("click", sendMessage);

      document.getElementById("new-chat-btn").addEventListener("click", async () => {
        await fetch("/api/session/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        sessionId = crypto.randomUUID();
        localStorage.setItem("pikl_session", sessionId);
        chatWindow.innerHTML = '<div id="empty-state"><h2>pikl chat</h2><p>무엇이든 물어보세요.</p></div>';
        emptyState = document.getElementById("empty-state");
      });

      function renderText(text) {
        return text
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/\\*\\*(.+?)\\*\\*/g, '<strong style="color:#93c5fd">$1</strong>');
      }

      function addMessage(role, text) {
        if (emptyState) { emptyState.remove(); emptyState = null; }
        const row = document.createElement("div");
        row.className = "msg-row";
        row.innerHTML = \`
          <div class="msg-inner">
            <div class="avatar \${role}">\${role === "user" ? "나" : "AI"}</div>
            <div class="msg-content \${role}">\${renderText(text)}</div>
          </div>\`;
        chatWindow.appendChild(row);
        chatWindow.scrollTop = chatWindow.scrollHeight;
        return row.querySelector(".msg-content");
      }

      function addThinking() {
        if (emptyState) { emptyState.remove(); emptyState = null; }
        const row = document.createElement("div");
        row.className = "msg-row";
        row.innerHTML = \`
          <div class="msg-inner">
            <div class="avatar assistant">AI</div>
            <div class="thinking"><span></span><span></span><span></span></div>
          </div>\`;
        chatWindow.appendChild(row);
        chatWindow.scrollTop = chatWindow.scrollHeight;
        return row;
      }

      async function sendMessage() {
        const text = textarea.value.trim();
        if (!text) return;

        addMessage("user", text);
        textarea.value = "";
        textarea.style.height = "auto";
        sendBtn.disabled = true;

        const thinkingRow = addThinking();

        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, sessionId }),
          });
          const data = await response.json();
          thinkingRow.remove();
          addMessage("assistant", response.ok ? data.reply : "오류: " + data.error);
        } catch (err) {
          thinkingRow.remove();
          addMessage("assistant", "요청 실패: " + err.message);
        }

        sendBtn.disabled = false;
      }
    </script>
  </body>
</html>`);
});

initDb().then(() => {
  server.listen(port, host, () => {
    console.log(`pikl listening on http://${host}:${port}`);
  });
});
