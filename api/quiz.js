// Notes2Quiz — quiz generation API (Vercel Function)
// © 2026 P Om Shiva. All rights reserved. See LICENSE.
//
// Turns a student's notes (text or a photo) into multiple-choice questions.
// The AI call runs on the server, so no API key ever reaches the browser.
// On Vercel it authenticates to Vercel AI Gateway with the project's OIDC token;
// AI_GATEWAY_API_KEY or GEMINI_API_KEY can be set instead.

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODELS = (process.env.QUIZ_MODELS ||
  "google/gemini-3.1-flash-lite,google/gemini-2.5-flash,openai/gpt-5-mini")
  .split(",").map((m) => m.trim()).filter(Boolean);

const MAX_TEXT = 24000;          // characters of notes we read
const MIN_TEXT = 200;            // shorter than this is not enough to quiz on
const MAX_IMAGE_BYTES = 3_000_000;
const LEVELS = {
  easy: "Easy: test recall of definitions, facts and key terms stated in the notes.",
  medium: "Medium: mix recall with understanding — why something happens, how two ideas differ.",
  hard: "Hard: test understanding and application — scenarios, comparisons, 'which is NOT true', cause and effect. Never just repeat a definition.",
};

export const SAMPLE_NOTES = `Computer Networks — Unit 1 notes

A computer network connects devices so they can share data and resources. Networks are grouped by size: a LAN covers a small area like a lab or a home, a MAN covers a city, and a WAN covers countries. The Internet is the largest WAN.

The OSI model has seven layers: Physical, Data Link, Network, Transport, Session, Presentation and Application. The TCP/IP model is the practical model used on the Internet and has four layers.

The Physical layer sends raw bits over cables or radio. The Data Link layer uses MAC addresses to move frames inside one network; a switch works at this layer. The Network layer uses IP addresses to route packets between different networks; a router works at this layer.

TCP is connection-oriented and reliable: it starts with a three-way handshake (SYN, SYN-ACK, ACK), numbers every segment and resends lost ones. UDP is connectionless and faster but does not guarantee delivery, so it suits live video, online games and DNS lookups.

An IPv4 address is 32 bits long, written as four numbers such as 192.168.1.10. IPv6 addresses are 128 bits long; IPv6 was created because IPv4 addresses were running out.

DNS works like the phonebook of the Internet: it turns a name such as example.com into an IP address. HTTP is used to load web pages. HTTPS is HTTP with TLS encryption and uses port 443, while plain HTTP uses port 80.

A firewall filters traffic using rules and blocks unwanted connections. Bandwidth is the maximum data rate of a link, and latency is the delay for data to travel from source to destination.`;

// Best-effort limit per server instance, so one visitor can't drain the free credits.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 15;
}

function systemPrompt(count, level) {
  return [
    "You are a careful exam setter for college students.",
    `Write exactly ${count} multiple-choice questions using ONLY facts found in the student's notes.`,
    "Never use outside knowledge. Never invent facts, numbers or names that are not in the notes.",
    `Difficulty — ${LEVELS[level]}`,
    "Each question has exactly 4 options, exactly one correct. Wrong options must be believable, similar in length, and clearly wrong according to the notes.",
    "Do not use 'All of the above' or 'None of the above'. Cover different parts of the notes; no two questions test the same fact.",
    "explanation: one short sentence saying why the answer is right, based on the notes.",
    "topic: the 2-4 word sub-topic of the notes this question tests (used for a 'revise these topics' list).",
    'If the notes are too short or not study material, return {"error":"not_enough_notes"}.',
    "Reply with JSON only, no markdown, in this shape:",
    '{"title":"short name of the notes topic","questions":[{"question":"...","options":["...","...","...","..."],"answer":0,"explanation":"...","topic":"..."}]}',
  ].join("\n");
}

function parseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Keep only well-formed questions; shuffle options so the answer isn't always "A".
function clean(data, count) {
  if (!data || !Array.isArray(data.questions)) return null;
  const seen = new Set();
  const out = [];
  for (const q of data.questions) {
    if (!q || typeof q.question !== "string" || !Array.isArray(q.options)) continue;
    const options = q.options.map((o) => String(o ?? "").trim()).filter(Boolean);
    const answer = Number(q.answer);
    if (options.length !== 4 || !(answer >= 0 && answer <= 3)) continue;
    if (new Set(options.map((o) => o.toLowerCase())).size !== 4) continue;
    const key = q.question.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const order = shuffle([0, 1, 2, 3]);
    out.push({
      question: q.question.trim(),
      options: order.map((i) => options[i]),
      answer: order.indexOf(answer),
      explanation: String(q.explanation || "").trim(),
      topic: String(q.topic || "General").trim().slice(0, 40),
    });
    if (out.length === count) break;
  }
  return out.length >= Math.min(3, count)
    ? { title: String(data.title || "Your notes").slice(0, 80), questions: out }
    : null;
}

async function callModel({ url, token, model, messages }) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages, temperature: 0.4 }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body?.error?.message || `AI service error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body?.choices?.[0]?.message?.content || "";
}

function authFor(req) {
  if (process.env.GEMINI_API_KEY) {
    return { url: GEMINI_URL, token: process.env.GEMINI_API_KEY,
      models: (process.env.GEMINI_MODELS || "gemini-3.8-flash,gemini-3.1-flash-lite,gemini-2.5-flash").split(",").map((m) => m.trim()) };
  }
  const token = process.env.AI_GATEWAY_API_KEY ||
    req.headers["x-vercel-oidc-token"] || process.env.VERCEL_OIDC_TOKEN;
  return token ? { url: GATEWAY_URL, token, models: MODELS } : null;
}

export async function makeQuiz(req, { text, image, level, count }) {
  const auth = authFor(req);
  if (!auth) {
    const e = new Error("The AI service isn't connected yet. Please try again later.");
    e.status = 503;
    throw e;
  }
  const userContent = [];
  const intro = `Difficulty: ${level}. Number of questions: ${count}.`;
  if (text) userContent.push({ type: "text", text: `${intro}\n\nSTUDENT NOTES:\n${text}` });
  if (image) {
    if (!text) userContent.push({ type: "text", text: `${intro}\n\nThe student's notes are in this photo. Read them carefully and quiz only on what is written.` });
    userContent.push({ type: "image_url", image_url: { url: image } });
  }
  const messages = [
    { role: "system", content: systemPrompt(count, level) },
    { role: "user", content: userContent },
  ];

  let lastError;
  for (const model of auth.models) {
    try {
      const content = await callModel({ url: auth.url, token: auth.token, model, messages });
      const data = parseJson(content);
      if (data?.error === "not_enough_notes") {
        const e = new Error("These notes are too short to make a good quiz. Add a page or two more.");
        e.status = 422;
        throw e;
      }
      const quiz = clean(data, count);
      if (quiz) return { ...quiz, model };
      lastError = new Error("The AI's answer couldn't be read. Please try again.");
    } catch (e) {
      if (e.status === 422) throw e;
      if (e.status === 401 || e.status === 403) {
        console.error("AI auth error:", e.message);
        const err = new Error("The AI service isn't connected yet. Please try again later.");
        err.status = 503;
        throw err;
      }
      lastError = e; // try the next model
    }
  }
  throw lastError || new Error("Couldn't make a quiz right now. Please try again.");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";

  try {
    if (req.method === "GET") {
      // Health check and a built-in demo: /api/quiz?sample=1
      if (req.query?.sample !== "1") {
        return res.status(200).json({ ok: true, ai: Boolean(authFor(req)) });
      }
      if (rateLimited(ip)) return res.status(429).json({ error: "Too many quizzes in a short time. Wait a few minutes." });
      const quiz = await makeQuiz(req, { text: SAMPLE_NOTES, level: "medium", count: 10 });
      return res.status(200).json(quiz);
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
    if (rateLimited(ip)) return res.status(429).json({ error: "Too many quizzes in a short time. Wait a few minutes." });

    let body;
    try {
      // Vercel parses JSON lazily and throws on bad JSON when req.body is read.
      const raw = req.body;
      body = typeof raw === "string" || Buffer.isBuffer(raw) ? JSON.parse(String(raw) || "{}") : (raw || {});
    } catch {
      return res.status(400).json({ error: "The request was not valid." });
    }
    const text = String(body.text || "").replace(/\s+\n/g, "\n").trim().slice(0, MAX_TEXT);
    const image = typeof body.image === "string" && body.image.startsWith("data:image/") ? body.image : "";
    const level = LEVELS[body.level] ? body.level : "medium";
    const count = [5, 10, 15].includes(Number(body.count)) ? Number(body.count) : 10;

    if (image && image.length * 0.75 > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: "That photo is too large. Try a smaller or clearer photo." });
    }
    if (!image && text.length < MIN_TEXT) {
      return res.status(422).json({ error: "Add a bit more — at least a paragraph of notes." });
    }

    const quiz = await makeQuiz(req, { text, image, level, count });
    return res.status(200).json(quiz);
  } catch (e) {
    const status = e.status === 402 ? 503 : (e.status && e.status < 600 ? e.status : 500);
    const message = e.status === 402
      ? "Today's free quiz limit is used up. Please try again tomorrow."
      : (status === 503 ? e.message : status >= 500 ? "Couldn't make a quiz right now. Please try again in a minute." : e.message);
    return res.status(status).json({ error: message });
  }
}
