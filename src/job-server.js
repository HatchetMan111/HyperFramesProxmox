/* Hyperframes Job-UI — Prompt zu Video (keine Abhängigkeiten, nur Node).
 * Env: JOB_TOKEN (Pflicht), JOB_PORT, HF_BASE (/opt/hyperframes),
 *      OPENROUTER_API_KEY, OPENROUTER_MODEL, OMNIROUTE_URL, OMNIROUTE_MODEL.
 * Ablauf pro Job: LLM (OpenRouter ODER OmniRoute, anklickbar) -> HTML-Entwurf
 * -> Projekt-Gerüst -> lint + snapshot -> optional rendern -> Galerie-Link.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE = process.env.HF_BASE || "/opt/hyperframes";
const PORT = parseInt(process.env.JOB_PORT || "3120", 10);
const TOKEN = process.env.JOB_TOKEN || "";
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const OR_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";
const OMNI_URL = (process.env.OMNIROUTE_URL || "http://127.0.0.1:20128/v1").replace(/\/$/, "");
const OMNI_MODEL = process.env.OMNIROUTE_MODEL || "auto";
const JOBS = path.join(BASE, "jobs");
const GALLERY = path.join(BASE, "gallery");
fs.mkdirSync(JOBS, { recursive: true });
fs.mkdirSync(GALLERY, { recursive: true });

const tasks = new Map();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- LLM-Aufruf (OpenAI-kompatibel, beide Anbieter) ---------- */
async function callLLM(provider, model, system, user) {
  const isOR = provider === "openrouter";
  const url = isOR ? "https://openrouter.ai/api/v1/chat/completions" : OMNI_URL + "/chat/completions";
  const headers = { "Content-Type": "application/json" };
  if (isOR) {
    if (!OR_KEY) throw new Error("OPENROUTER_API_KEY fehlt in .env");
    headers.Authorization = "Bearer " + OR_KEY;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 180000);
  try {
    const res = await fetch(url, {
      method: "POST", headers, signal: ctl.signal,
      body: JSON.stringify({
        model: model || (isOR ? OR_MODEL : OMNI_MODEL),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.7,
      }),
    });
    if (!res.ok) throw new Error("LLM-Fehler " + res.status + ": " + (await res.text()).slice(0, 300));
    const data = await res.json();
    return data.choices[0].message.content;
  } finally { clearTimeout(t); }
}

function extractHTML(text) {
  const m = text.match(/```html\s*([\s\S]*?)```/i);
  const html = (m ? m[1] : text).trim();
  if (html.includes("data-composition-id") && html.includes("__timelines")) return html;
  return null;
}

/* ---------- Shell-Helfer ---------- */
function run(cmd, args, cwd, logFile) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd });
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write("\n$ " + cmd + " " + args.join(" ") + "\n");
    p.stdout.on("data", (d) => log.write(d));
    p.stderr.on("data", (d) => log.write(d));
    p.on("close", (code) => { log.write("[exit " + code + "]\n"); log.end(); resolve(code); });
    p.on("error", (e) => { log.write("[error " + e.message + "]\n"); log.end(); resolve(1); });
  });
}

/* ---------- Pipeline ---------- */
async function pipeline(id, opts) {
  const dir = path.join(JOBS, id);
  const logFile = path.join(dir, "task.log");
  const set = (patch) => tasks.set(id, Object.assign({}, tasks.get(id), patch));
  const say = (m) => { fs.appendFileSync(logFile, m + "\n"); set({ step: m }); };
  try {
    set({ state: "running", step: "LLM erzeugt Entwurf …" });
    say("LLM (" + opts.provider + "): Entwurf wird erzeugt");
    const system = "Du schreibst Hyperframes-Kompositionen: genau EINE HTML-Datei mit "
      + "einer <div data-composition-id=\"main\" data-start=\"0\" data-duration=\"SEKUNDEN\" "
      + "data-width=\"1920\" data-height=\"1080\">, Clips mit class=\"clip\" data-start/duration/track-index, "
      + "GSAP-Timeline (paused) in window.__timelines[\"main\"], Markendesign (Gelb #FFD234, Grün #14532D), "
      + "deutsche Texte, keine externen Bilder (nur CSS/SVG/Emoji). Antworte NUR mit ```html-Codeblock.";
    const raw = await callLLM(opts.provider, opts.model, system, opts.prompt);
    fs.writeFileSync(path.join(dir, "llm-roh.txt"), raw);
    const html = extractHTML(raw);

    set({ step: "Projekt-Gerüst …" });
    say("Projekt wird angelegt");
    await run("hyperframes", ["init", "projekt", "--example", "blank", "--non-interactive"],
      dir, logFile);
    const projDir = path.join(dir, "projekt");
    if (html) {
      fs.writeFileSync(path.join(projDir, "index.html"), html);
      say("LLM-HTML übernommen");
    } else {
      fs.writeFileSync(path.join(dir, "behandlung.md"), raw);
      say("WARNUNG: kein gültiges HTML erkannt — Template + behandlung.md");
    }

    set({ step: "lint + snapshot …" });
    say("lint + snapshot laufen");
    process.env.HYPERFRAMES_SKIP_SKILLS = "1";
    await run("hyperframes", ["lint"], projDir, logFile);
    await run("hyperframes", ["snapshot", "--at", "1,5,10", "--no-end", "-o", "entwurf"],
      projDir, logFile);

    if (opts.render) {
      set({ step: "rendere MP4 (dauert Minuten) …" });
      say("Render startet");
      const code = await run("hyperframes", ["render", "-o", "ergebnis.mp4"], projDir, logFile);
      const mp4 = path.join(projDir, "ergebnis.mp4");
      if (code === 0 && fs.existsSync(mp4)) {
        fs.copyFileSync(mp4, path.join(GALLERY, "job-" + id + ".mp4"));
        say("MP4 fertig → Galerie: job-" + id + ".mp4");
      } else say("Render fehlgeschlagen (siehe task.log)");
    }
    set({ state: "done", step: "fertig" });
    say("FERTIG");
  } catch (e) {
    say("FEHLER: " + e.message);
    set({ state: "error", step: "Fehler: " + e.message });
  }
}

/* ---------- HTTP ---------- */
function formPage() {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<title>Hyperframes Job-UI</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px}
label{display:block;margin:14px 0 4px;font-weight:700}textarea,input[type=text]{width:100%;padding:10px;font-size:15px}
button{margin-top:16px;padding:12px 26px;font-size:16px;font-weight:700;background:#14532D;color:#FFD234;border:0;border-radius:10px;cursor:pointer}
.card{background:#f4f4f0;border:2px solid #14532D;border-radius:12px;padding:16px;margin-top:20px}</style></head><body>
<h1>🎬 Prompt → Video</h1>
<form method="post" action="/job">
<label>Token</label><input type="text" name="token" required>
<label>Videowunsch</label><textarea name="prompt" rows="4" required placeholder="z. B. 30s Produkt-Clip für …"></textarea>
<label>KI-Anbieter (anklickbar)</label>
<div><input type="radio" name="provider" value="omniroute" checked> OmniRoute (lokal, Free-Tiers)
<input type="radio" name="provider" value="openrouter"> OpenRouter (Key nötig)</div>
<label>Modell (leer = Standard)</label><input type="text" name="model" placeholder="z. B. anthropic/claude-sonnet-4">
<div class="card"><input type="checkbox" name="render" value="1"> Nach Entwurf <b>sofort rendern</b> (dauert Minuten, MP4 landet in Galerie)</div>
<button>Auftrag starten</button></form>
<p><a href="/jobs-list">Alle Aufträge</a></p></body></html>`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(formPage());
    return;
  }
  if (req.method === "GET" && u.pathname === "/jobs-list") {
    const items = [...tasks.entries()].map(([id, t]) =>
      `<li><a href="/status?id=${id}">${id}</a> — ${esc(t.state)} — ${esc(t.step)}</li>`).join("");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(`<h1>Aufträge</h1><ul>${items || "<li>keine</li>"}</ul><p><a href="/">Neu</a></p>`);
    return;
  }
  if (req.method === "GET" && u.pathname === "/status") {
    const t = tasks.get(u.searchParams.get("id") || "");
    if (!t) { res.writeHead(404).end("unbekannt"); return; }
    if (u.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(t));
      return;
    }
    const snap = ["entwurf/frame-00-at-1s.png", "entwurf/frame-01-at-5s.png", "entwurf/frame-02-at-10s.png"]
      .filter((f) => fs.existsSync(path.join(JOBS, u.searchParams.get("id"), "projekt", f)))
      .map((f) => `<img src="/jobs/${u.searchParams.get("id")}/projekt/${f}" style="max-width:100%;margin:8px 0">`).join("");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      `<h1>Auftrag ${esc(u.searchParams.get("id"))}</h1><p>Status: <b>${esc(t.state)}</b> — ${esc(t.step)}</p>`
      + (t.state === "running" ? `<meta http-equiv="refresh" content="5">` : "")
      + snap + `<p><a href="/jobs/${u.searchParams.get("id")}/task.log">Log</a> · <a href="/">Neu</a></p>`);
    return;
  }
  if (req.method === "GET" && u.pathname.startsWith("/jobs/")) {
    const fp = path.normalize(path.join(JOBS, decodeURIComponent(u.pathname.slice(6))));
    if (!fp.startsWith(JOBS) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404).end("nicht gefunden"); return;
    }
    const ext = { ".png": "image/png", ".jpg": "image/jpeg", ".log": "text/plain", ".md": "text/markdown", ".txt": "text/plain" }[path.extname(fp)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ext }).end(fs.readFileSync(fp));
    return;
  }
  if (req.method === "POST" && u.pathname === "/job") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on("end", () => {
      const p = new URLSearchParams(body);
      if (!TOKEN || p.get("token") !== TOKEN) { res.writeHead(403).end("Token falsch"); return; }
      const prompt = (p.get("prompt") || "").trim();
      if (prompt.length < 10) { res.writeHead(400).end("Prompt zu kurz"); return; }
      const id = Date.now().toString(36);
      fs.mkdirSync(path.join(JOBS, id), { recursive: true });
      tasks.set(id, { state: "running", step: "wartet", prompt: prompt.slice(0, 120) });
      pipeline(id, {
        prompt, provider: p.get("provider") === "openrouter" ? "openrouter" : "omniroute",
        model: (p.get("model") || "").trim(), render: p.get("render") === "1",
      });
      res.writeHead(303, { Location: "/status?id=" + id }).end();
    });
    return;
  }
  res.writeHead(404).end("nicht gefunden");
});

server.listen(PORT, "0.0.0.0", () => console.log("Job-UI auf :" + PORT));
