const fs = require("fs");
const path = require("path");
const http = require("http");

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
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      if (!trimmed.startsWith("OPENAI_API_KEY=")) {
        continue;
      }
      return trimmed.slice("OPENAI_API_KEY=".length).trim();
    }
  }

  return "";
}

const openAIKey = loadOpenAIKey();

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleChat(req, res) {
  if (!openAIKey) {
    sendJson(res, 500, {
      error: "OPENAI_API_KEY not found. Put it in pikl/.env or ../project/.env.",
    });
    return;
  }

  let message = "";

  try {
    const body = await readJsonBody(req);
    message = String(body.message || "").trim();
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  if (!message) {
    sendJson(res, 400, { error: "message is required." });
    return;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAIKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: "You are a concise assistant for a beginner web demo.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: message,
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const apiError =
        data && data.error && data.error.message
          ? data.error.message
          : "OpenAI request failed.";
      sendJson(res, response.status, { error: apiError });
      return;
    }

    sendJson(res, 200, {
      reply: data.output?.[0]?.content?.[0]?.text || "No text returned.",
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unknown server error.",
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, openaiConfigured: Boolean(openAIKey) });
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pikl nano chat</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f1eadf;
        --ink: #1c1a18;
        --card: #fff9f2;
        --line: #dbc9b5;
        --accent: #145f4a;
        --soft: #efe4d5;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        background:
          radial-gradient(circle at top left, #fff6dc 0, transparent 30%),
          linear-gradient(180deg, #f5efe6 0%, #efe4d6 100%);
        color: var(--ink);
      }
      main {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      section {
        width: min(720px, 100%);
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 32px;
        box-shadow: 0 20px 60px rgba(64, 45, 24, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: clamp(2rem, 8vw, 4rem);
        line-height: 0.95;
      }
      p {
        margin: 0 0 12px;
        font-size: 1.05rem;
        line-height: 1.6;
      }
      form {
        display: grid;
        gap: 12px;
        margin-top: 24px;
      }
      textarea {
        width: 100%;
        min-height: 120px;
        resize: vertical;
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 16px;
        font: inherit;
        background: #fffdf9;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 14px 18px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        color: white;
        background: var(--accent);
      }
      .bubble {
        margin-top: 18px;
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: var(--soft);
        white-space: pre-wrap;
      }
      .muted {
        color: #6a6258;
        font-size: 0.95rem;
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <p>OpenAI nano demo</p>
        <h1>pikl chat</h1>
        <p>브라우저에서 바로 질문을 보내는 최소 예시입니다.</p>
        <p class="muted">서버는 OPENAI_API_KEY만 사용합니다. 키 값은 화면에 표시하지 않습니다.</p>
        <form id="chat-form">
          <textarea id="message" placeholder="예: 안녕, 오늘 할 일 정리해줘"></textarea>
          <button type="submit">보내기</button>
        </form>
        <div id="status" class="bubble">준비됨. 포트 ${port}에서 실행 중입니다.</div>
      </section>
    </main>
    <script>
      const form = document.getElementById("chat-form");
      const message = document.getElementById("message");
      const status = document.getElementById("status");

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = message.value.trim();

        if (!text) {
          status.textContent = "먼저 질문을 입력하세요.";
          return;
        }

        status.textContent = "응답 생성 중...";

        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text }),
          });

          const data = await response.json();
          status.textContent = response.ok ? data.reply : "오류: " + data.error;
        } catch (error) {
          status.textContent = "요청 실패: " + error.message;
        }
      });
    </script>
  </body>
</html>`);
});

server.listen(port, host, () => {
  console.log(`pikl listening on http://${host}:${port}`);
});
