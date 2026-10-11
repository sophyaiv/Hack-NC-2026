// Kind Tides 🫧 — an iMessage agent that answers rough days with a gentle "tide report"
// and opens the treasure chest on the website every time someone texts the reef.
//
// Run:  npm start            (real iMessage line, needs .env with your Photon + Gemini keys)
//       npm run test-chat    (chat with the reef in this terminal, no phone needed)

import http from "node:http";
import { readFile } from "node:fs/promises";
import { Spectrum } from "spectrum-ts";

const TEST_MODE = process.argv.includes("--terminal");
const PORT = Number(process.env.PORT || 3000);
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

// ---------- the reef's personality ----------
const REEF_PROMPT = `You are "the reef", a gentle underwater friend people text through iMessage
when they feel stressed, stuck, sad or tired. Reply like a calm, warm friend, never like a therapist or a bot.

Rules:
- 1 to 3 short sentences, under 45 words total. Plain text, at most one emoji.
- Speak in soft ocean and weather imagery ("tides", "currents", "forecast", "calm waters").
- Always include ONE small, doable nature nudge: step outside for a few minutes, look at the sky,
  refill a water bottle instead of buying one, notice a tree, open a window, take a short walk.
- Be encouraging about trying again. Never lecture, never diagnose, never give medical advice.
- If they mention wanting to hurt themselves or not wanting to be alive, gently say you care, and that they
  deserve real support right now: in the US they can call or text 988 (Suicide & Crisis Lifeline).`;

const FALLBACKS = [
  "Tides go out so they can come back in. Today is a good day to try again. Step outside for a minute and look at the sky 🌊",
  "Calm waters ahead, with a 90% chance you're doing better than you think. Refill a water bottle and take a slow breath.",
  "Foggy morning, clearing by afternoon. Rest is allowed. Open a window and let some fresh air in 🫧",
  "The reef is glad you texted. Small currents still move the ocean. Take a short walk if you can.",
];

const CRISIS = /(kill myself|suicid|end my life|don'?t want to (be alive|live)|hurt myself|self[- ]harm)/i;
const CRISIS_REPLY =
  "I'm really glad you told me, and I care about you. You deserve real support right now: in the US you can call or text 988 to reach someone any time, day or night. 💙";

// short memory per person so the reef can follow the conversation
const memory = new Map(); // senderId -> [{role, text}]
function remember(id, role, text) {
  const list = memory.get(id) || [];
  list.push({ role, text });
  memory.set(id, list.slice(-8));
}

async function reefReply(senderId, text) {
  if (CRISIS.test(text)) return CRISIS_REPLY;
  remember(senderId, "user", text);
  let reply;
  try {
    if (!GEMINI_KEY) throw new Error("no GEMINI_API_KEY in .env");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: REEF_PROMPT }] },
          contents: (memory.get(senderId) || []).map((m) => ({
            role: m.role === "user" ? "user" : "model",
            parts: [{ text: m.text }],
          })),
          generationConfig: { temperature: 0.9, maxOutputTokens: 2048 },
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || res.statusText);
    // newer Gemini models "think" first: keep only the final answer, never the thinking parts
    const parts = data?.candidates?.[0]?.content?.parts || [];
    reply = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("").trim();
    reply = reply.replace(/^\s*(drafting|draft|thinking|response)[^\n]*:\s*/i, "").replace(/^[\s*•-]+/, "").trim();
    if (reply.length < 15 || /drafting response/i.test(reply)) throw new Error("reply was cut off: " + JSON.stringify(reply).slice(0, 80));
  } catch (err) {
    console.warn("⚠️  Gemini didn't answer, using a backup message:", err.message);
    reply = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
  }
  remember(senderId, "model", reply);
  return reply;
}

// ---------- website: serves the tank + a feed the treasure chest listens to ----------
const feed = []; // newest last
let nextId = 1;
function addToFeed(them, reef) {
  feed.push({ id: nextId++, them: them.slice(0, 140), reef, at: Date.now() });
  if (feed.length > 50) feed.shift();
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/feed") {
      const after = Number(url.searchParams.get("after") || 0);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify(feed.filter((m) => m.id > after)));
    }
    try {
      const html = await readFile(new URL("./public/index.html", import.meta.url));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404).end("index.html not found in the public folder");
    }
  })
  .listen(PORT, () => console.log(`🐠 Reef website: http://localhost:${PORT}`));

// ---------- connect to iMessage (or the terminal for testing) ----------
let providers;
if (TEST_MODE) {
  const { terminal } = await import("spectrum-ts/providers/terminal");
  providers = [terminal.config()];
} else {
  const { imessage } = await import("spectrum-ts/providers/imessage");
  providers = [imessage.config()];
  if (!process.env.SPECTRUM_PROJECT_ID || !process.env.SPECTRUM_PROJECT_SECRET) {
    console.error("❌ Missing SPECTRUM_PROJECT_ID or SPECTRUM_PROJECT_SECRET in your .env file.");
    process.exit(1);
  }
}

const app = await Spectrum({
  ...(TEST_MODE
    ? {}
    : { projectId: process.env.SPECTRUM_PROJECT_ID, projectSecret: process.env.SPECTRUM_PROJECT_SECRET }),
  providers,
});
console.log(TEST_MODE ? "🫧 Test mode: type a message to the reef below." : "🫧 Kind Tides is live on iMessage. Text your Photon number!");

for await (const [space, message] of app.messages) {
  if (message.content?.type !== "text") continue;
  const text = message.content.text;
  const sender = message.sender?.id ?? "someone";
  console.log(`💬 ${sender}: ${text}`);
  try {
    let reply;
    await space.responding(async () => {
      reply = await reefReply(sender, text);
      await space.send(reply);
    });
    console.log(`🐚 reef: ${reply}`);
    addToFeed(text, reply); // opens the chest on the website (sender's number is never shown)
  } catch (err) {
    console.error("Couldn't reply:", err.message);
  }
}
