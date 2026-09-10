/* Hyperframes Job-UI v2 — Prompt zu Video (keine Abhängigkeiten, nur Node).
 *
 * Env (.env): JOB_TOKEN (Pflicht), JOB_PORT, HF_BASE (/opt/hyperframes),
 *   OPENROUTER_API_KEY, OPENROUTER_MODEL, OMNIROUTE_URL, OMNIROUTE_KEY, OMNIROUTE_MODEL.
 * Alles davon ist zusätzlich per Web-UI unter /einstellungen änderbar
 * (settings.json, 0600) — inkl. Verbindungstest pro Anbieter.
 *
 * Ablauf pro Job: LLM (OpenRouter ODER OmniRoute, anklickbar) -> HTML-Entwurf
 * -> Projekt-Gerüst -> lint + adaptive Snapshots -> optional rendern -> Galerie.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE = process.env.HF_BASE || "/opt/hyperframes";
const PORT = parseInt(process.env.JOB_PORT || "3120", 10);
const TOKEN = process.env.JOB_TOKEN || "";
const JOBS = path.join(BASE, "jobs");
const GALLERY = path.join(BASE, "gallery");
const SETTINGS_FILE = path.join(BASE, "settings.json");
fs.mkdirSync(JOBS, { recursive: true });
fs.mkdirSync(GALLERY, { recursive: true });
process.env.HYPERFRAMES_SKIP_SKILLS = "1";

/* ---------- Einstellungen (Datei schlägt Env, Env schlägt Default) ---------- */
function loadSettings() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { file = {}; }
  const e = process.env;
  return {
    openrouterKey: file.openrouterKey ?? e.OPENROUTER_API_KEY ?? "",
    openrouterModel: file.openrouterModel ?? e.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4",
    omniUrl: (file.omniUrl ?? e.OMNIROUTE_URL ?? "http://127.0.0.1:20128/v1").replace(/\/$/, ""),
    omniKey: file.omniKey ?? e.OMNIROUTE_KEY ?? "",
    omniModel: file.omniModel ?? e.OMNIROUTE_MODEL ?? "auto",
  };
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
const mask = (k) => (!k ? "— nicht gesetzt —" : (k.length <= 8 ? "••••••••" : "••••" + k.slice(-4)));

const tasks = new Map();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const chip = (state) => {
  const m = { running: ["läuft", "#FFD234"], done: ["fertig", "#7ED957"], error: ["fehler", "#D64545"] };
  const [t, c] = m[state] || [state, "#888"];
  return `<span style="background:${c};color:#101010;font-weight:700;border-radius:999px;padding:2px 14px">${t}</span>`;
};

/* ---------- LLM (OpenAI-kompatibel, beide Anbieter + Omni-Key) ---------- */
async function callLLM(provider, model, system, user) {
  const s = loadSettings();
  const isOR = provider === "openrouter";
  const base = isOR ? "https://openrouter.ai/api/v1" : s.omniUrl;
  const key = isOR ? s.openrouterKey : s.omniKey;
  if (isOR && !key) throw new Error("OpenRouter-Key fehlt — unter /einstellungen eintragen");
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = "Bearer " + key;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 180000);
  try {
    const res = await fetch(base + "/chat/completions", {
      method: "POST", headers, signal: ctl.signal,
      body: JSON.stringify({
        model: model || (isOR ? s.openrouterModel : s.omniModel),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.7,
      }),
    });
    if (!res.ok) throw new Error("LLM-Fehler " + res.status + ": " + (await res.text()).slice(0, 300));
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message.content;
    if (!text) throw new Error("LLM lieferte leere Antwort");
    return text;
  } finally { clearTimeout(t); }
}

async function testProvider(provider) {
  const s = loadSettings();
  const isOR = provider === "openrouter";
  const base = isOR ? "https://openrouter.ai/api/v1" : s.omniUrl;
  const key = isOR ? s.openrouterKey : s.omniKey;
  const headers = {};
  if (key) headers.Authorization = "Bearer " + key;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(base + "/models", { headers, signal: ctl.signal });
    if (!res.ok) return { ok: false, info: "HTTP " + res.status + ": " + (await res.text()).slice(0, 200) };
    const data = await res.json();
    const n = data.data ? data.data.length : "?";
    return { ok: true, info: n + " Modelle erreichbar über " + base };
  } catch (e) {
    return { ok: false, info: "Keine Verbindung (" + e.message + ")" };
  } finally { clearTimeout(t); }
}

function extractHTML(text) {
  const m = text.match(/```html\s*([\s\S]*?)```/i);
  const html = (m ? m[1] : text).trim();
  if (html.includes("data-composition-id") && html.includes("__timelines")) return html;
  return null;
}
function compositionDuration(html) {
  const m = html.match(/data-composition-id[^>]*data-duration="([\d.]+)"/)
    || html.match(/data-duration="([\d.]+)"[^>]*data-composition-id/);
  const d = m ? parseFloat(m[1]) : 10;
  return d > 0 && d <= 600 ? d : 10;
}
function snapshotTimes(d) {
  const r = (x) => Math.round(x * 10) / 10;
  return [r(d * 0.2), r(d * 0.5), r(Math.min(d * 0.85, d - 0.1))].map(String).join(",");
}

/* ---------- Projekt-Gerüst (lokal, ohne hyperframes init + Skills-Download) ---------- */
const SCAFFOLD_HYPERFRAMES_JSON = `{
  "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
  "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
  "paths": { "blocks": "compositions", "components": "compositions/components", "assets": "assets" },
  "media": { "autoProxy": true }
}`;
const SCAFFOLD_INDEX_HTML = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #101010; }
      body { font-family: system-ui, sans-serif; color: #fff; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="10"
         data-width="1920" data-height="1080"
         style="display:flex;align-items:center;justify-content:center;height:1080px">
      <h1 class="clip" data-start="0" data-duration="10" data-track-index="1"
          style="font-size:96px">Entwurf folgt</h1>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>`;
function scaffoldProject(projDir, html) {
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "hyperframes.json"), SCAFFOLD_HYPERFRAMES_JSON);
  fs.writeFileSync(path.join(projDir, "index.html"), html || SCAFFOLD_INDEX_HTML);
}

/* ---------- Shell ---------- */
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
      + "GSAP-Timeline (paused) in window.__timelines[\"main\"], deutsche Texte, "
      + "keine externen Bilder (nur CSS/SVG/Emoji). Antworte NUR mit ```html-Codeblock.";
    const raw = await callLLM(opts.provider, opts.model, system,
      opts.prompt + "\n\nVideolänge: ca. " + opts.seconds + " Sekunden (data-duration entsprechend setzen).");
    fs.writeFileSync(path.join(dir, "llm-roh.txt"), raw);
    const html = extractHTML(raw);

    set({ step: "Projekt-Gerüst …" });
    say("Projekt wird angelegt (lokal, ohne Skills-Download)");
    const projDir = path.join(dir, "projekt");
    let duration = 10;
    if (html) {
      scaffoldProject(projDir, html);
      duration = compositionDuration(html);
      say("LLM-HTML übernommen (Dauer: " + duration + "s)");
    } else {
      scaffoldProject(projDir, null);
      fs.writeFileSync(path.join(dir, "behandlung.md"), raw);
      say("WARNUNG: kein gültiges HTML erkannt — leeres Gerüst + behandlung.md");
    }

    set({ step: "lint + Snapshots …" });
    say("lint + Snapshots laufen");
    const lintCode = await run("hyperframes", ["lint"], projDir, logFile);
    if (lintCode !== 0) say("WARNUNG: lint meldet Fehler (siehe Log) — trotzdem weiter");
    const times = snapshotTimes(duration);
    set({ times: times.split(","), duration });
    const snapCode = await run("hyperframes", ["snapshot", "--at", times, "--no-end", "-o", "entwurf"], projDir, logFile);
    if (snapCode !== 0) say("WARNUNG: Snapshot fehlgeschlagen (Exit " + snapCode + ") — meist fehlt Chrome: im CT 'sudo -u hyperframes hyperframes browser ensure' ausführen");

    if (opts.render) {
      set({ step: "rendere MP4 (dauert Minuten) …" });
      say("Render startet");
      const code = await run("hyperframes", ["render", "-o", "ergebnis.mp4"], projDir, logFile);
      const mp4 = path.join(projDir, "ergebnis.mp4");
      if (code === 0 && fs.existsSync(mp4)) {
        fs.copyFileSync(mp4, path.join(GALLERY, "job-" + id + ".mp4"));
        set({ mp4: "job-" + id + ".mp4" });
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

/* ---------- UI ---------- */
const CSS = `body{font-family:system-ui,-apple-system,sans-serif;background:#101010;color:#eee;max-width:820px;margin:0 auto;padding:24px 20px 60px}
nav{display:flex;gap:10px;margin:18px 0 26px;flex-wrap:wrap}
nav a{background:#1e1e1e;color:#FFD234;text-decoration:none;font-weight:700;padding:10px 20px;border-radius:10px;border:1px solid #333}
nav a.on{background:#FFD234;color:#101010}
h1{color:#FFD234;margin:6px 0}h2{color:#7ED957}
.card{background:#1a1a1a;border:1px solid #333;border-radius:14px;padding:18px;margin:14px 0}
label{display:block;margin:14px 0 5px;font-weight:700}
input[type=text],input[type=password],textarea,select{width:100%;padding:11px;font-size:15px;background:#0d0d0d;color:#eee;border:1px solid #444;border-radius:9px;box-sizing:border-box}
button,.btn{display:inline-block;margin-top:16px;padding:12px 26px;font-size:16px;font-weight:700;background:#7ED957;color:#101010;border:0;border-radius:10px;cursor:pointer;text-decoration:none}
.btn.sec{background:#333;color:#FFD234}
.mut{color:#999;font-size:13px}.ok{color:#7ED957;font-weight:700}.err{color:#D64545;font-weight:700}
img.shot{max-width:100%;border-radius:10px;margin:8px 0;border:1px solid #333}
pre.log{background:#0d0d0d;border:1px solid #333;border-radius:10px;padding:14px;overflow:auto;max-height:300px;font-size:13px}
.prov{display:flex;gap:14px}.prov label{flex:1;background:#0d0d0d;border:2px solid #444;border-radius:12px;padding:14px;cursor:pointer;margin:0}
.prov input{accent-color:#7ED957}`;
const NAV = (on, tok) => `<nav><a href="/?token=${tok}" class="${on === "neu" ? "on" : ""}">＋ Neu</a>`
  + `<a href="/jobs-list?token=${tok}" class="${on === "jobs" ? "on" : ""}">Aufträge</a>`
  + `<a href="/einstellungen?token=${tok}" class="${on === "set" ? "on" : ""}">⚙ Einstellungen</a></nav>`;
const page = (title, on, tok, body) => `<!doctype html><html lang="de"><head><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Hyperframes</title>`
  + `<style>${CSS}</style></head><body><h1>🎬 Hyperframes Job-UI</h1>${NAV(on, tok)}${body}</body></html>`;

function formPage(tok, s) {
  const orOk = !!s.openrouterKey, omniLocal = s.omniUrl.includes("127.0.0.1") || s.omniUrl.includes("localhost");
  return page("Neuer Auftrag", "neu", tok, `
<h2>Prompt → Video</h2>
<form method="post" action="/job?token=${tok}">
<label>Videowunsch</label>
<textarea name="prompt" rows="4" required placeholder="z. B. 30s Produkt-Clip für den Hofladen, Marke grün/gelb …"></textarea>
<div style="display:flex;gap:14px">
<div style="flex:1"><label>Länge (Sekunden)</label>
<select name="seconds"><option>10</option><option selected>30</option><option>60</option><option>90</option></select></div>
<div style="flex:1"><label>Modell (leer = Standard)</label>
<input type="text" name="model" placeholder="Standard des Anbieters"></div>
</div>
<label>KI-Anbieter</label>
<div class="prov">
<label><input type="radio" name="provider" value="omniroute" checked> <b>OmniRoute</b><br>
<span class="mut">${esc(omniLocal ? "lokal, Free-Tiers" : esc(s.omniUrl))}${s.omniKey ? " · Key hinterlegt" : ""}</span></label>
<label><input type="radio" name="provider" value="openrouter"> <b>OpenRouter</b><br>
<span class="mut">${orOk ? "Key hinterlegt ✓" : "⚠ kein Key — in Einstellungen eintragen"}</span></label>
</div>
<div class="card"><input type="checkbox" name="render" value="1" style="accent-color:#7ED957">
<b>Nach Entwurf sofort rendern</b> <span class="mut">(dauert Minuten, MP4 landet in der Galerie)</span></div>
<button>Auftrag starten</button></form>`);
}

function settingsPage(tok, s, msg) {
  return page("Einstellungen", "set", tok, `
<h2>⚙ KI-Anbieter einrichten</h2>
${msg ? `<div class="card">${msg}</div>` : ""}
<form method="post" action="/einstellungen?token=${tok}">
<div class="card"><h2>OpenRouter</h2>
<label>API-Token <span class="mut">(aktuell: ${esc(mask(s.openrouterKey))})</span></label>
<input type="password" name="openrouterKey" placeholder="sk-or-… (leer = unverändert)" autocomplete="off">
<label>Standard-Modell</label>
<input type="text" name="openrouterModel" value="${esc(s.openrouterModel)}">
<p><a class="btn sec" href="/test?provider=openrouter&token=${tok}">Verbindung testen</a></p></div>
<div class="card"><h2>OmniRoute-Instanz</h2>
<label>Basis-URL <span class="mut">(eigene Instanz oder lokal)</span></label>
<input type="text" name="omniUrl" value="${esc(s.omniUrl)}">
<label>API-Key <span class="mut">(aktuell: ${esc(mask(s.omniKey))}, leer lassen wenn keyless)</span></label>
<input type="password" name="omniKey" placeholder="leer = unverändert" autocomplete="off">
<label>Standard-Modell</label>
<input type="text" name="omniModel" value="${esc(s.omniModel)}">
<p><a class="btn sec" href="/test?provider=omniroute&token=${tok}">Verbindung testen</a></p></div>
<button>Speichern</button></form>
<p class="mut">Gespeichert in <code>settings.json</code> (0600, nur lesbar für den Dienst). Datei-Einträge aus <code>.env</code> gelten als Fallback.</p>`);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const qTok = u.searchParams.get("token") || "";
  const authed = TOKEN && qTok === TOKEN;
  const needAuth = () => {
    if (!TOKEN) { res.writeHead(500).end("JOB_TOKEN nicht gesetzt (Dienst-Config prüfen)"); return false; }
    if (!authed) { res.writeHead(403).end("Token fehlt oder falsch — über ?token= aufrufen"); return false; }
    return true;
  };
  const bodyOf = () => new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 50000) { req.destroy(); reject(new Error("zu groß")); } });
    req.on("end", () => resolve(b));
  });

  if (req.method === "GET" && u.pathname === "/") {
    if (!needAuth()) return;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(formPage(qTok, loadSettings()));
    return;
  }
  if (req.method === "GET" && u.pathname === "/einstellungen") {
    if (!needAuth()) return;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(settingsPage(qTok, loadSettings(), ""));
    return;
  }
  if (req.method === "POST" && u.pathname === "/einstellungen") {
    if (!needAuth()) return;
    bodyOf().then((b) => {
      const p = new URLSearchParams(b);
      const cur = loadSettings();
      const next = {
        openrouterKey: (p.get("openrouterKey") || "").trim() || cur.openrouterKey,
        openrouterModel: (p.get("openrouterModel") || "").trim() || cur.openrouterModel,
        omniUrl: ((p.get("omniUrl") || "").trim() || cur.omniUrl).replace(/\/$/, ""),
        omniKey: (p.get("omniKey") || "").trim() || cur.omniKey,
        omniModel: (p.get("omniModel") || "").trim() || cur.omniModel,
      };
      if (p.get("openrouterKey") === "__LEEREN__") next.openrouterKey = "";
      if (p.get("omniKey") === "__LEEREN__") next.omniKey = "";
      saveSettings(next);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(settingsPage(qTok, next, `<span class="ok">✓ Gespeichert.</span> Keys: OpenRouter ${esc(mask(next.openrouterKey))} · OmniRoute ${esc(mask(next.omniKey))}`));
    }).catch(() => res.writeHead(400).end("ungültig"));
    return;
  }
  if (req.method === "GET" && u.pathname === "/test") {
    if (!needAuth()) return;
    const provider = u.searchParams.get("provider") === "openrouter" ? "openrouter" : "omniroute";
    testProvider(provider).then((r) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        page("Verbindungstest", "set", qTok,
          `<h2>Test: ${provider}</h2><div class="card">${r.ok ? `<span class="ok">✓ OK</span> — ${esc(r.info)}` : `<span class="err">✘ Fehlgeschlagen</span> — ${esc(r.info)}`}</div>`
          + `<p><a class="btn sec" href="/einstellungen?token=${qTok}">Zurück</a></p>`));
    });
    return;
  }
  if (req.method === "GET" && u.pathname === "/jobs-list") {
    if (!needAuth()) return;
    const items = [...tasks.entries()].reverse().map(([id, t]) =>
      `<div class="card">${chip(t.state)} <a href="/status?id=${id}&token=${qTok}"><b>${id}</b></a><br>`
      + `<span class="mut">${esc(t.prompt || "")}</span><br>${esc(t.step || "")}</div>`).join("");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(page("Aufträge", "jobs", qTok, items || "<p>Keine Aufträge.</p>"));
    return;
  }
  if (req.method === "GET" && u.pathname === "/status") {
    if (!needAuth()) return;
    const id = u.searchParams.get("id") || "";
    const t = tasks.get(id);
    if (!t) { res.writeHead(404).end("unbekannt"); return; }
    if (u.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(t));
      return;
    }
    const shots = (t.times || ["1", "5", "10"]).map((at, i) => {
      const f = "projekt/entwurf/frame-0" + i + "-at-" + at + "s.png";
      return fs.existsSync(path.join(JOBS, id, f))
        ? `<img class="shot" src="/jobs/${id}/${f}?token=${qTok}">` : "";
    }).join("");
    const noShots = !shots
      ? `<div class="card"><span class="err">Keine Snapshots gefunden.</span> Typische Ursachen: Chrome fehlt im CT
        (<code>sudo -u hyperframes hyperframes browser ensure</code>), Lint-Fehler im Entwurf oder LLM lieferte kein HTML.
        Details stehen unten im Log.</div>` : "";
    let logTail = "";
    try {
      const lines = fs.readFileSync(path.join(JOBS, id, "task.log"), "utf8").split("\n");
      logTail = `<h2>Log (letzte 25 Zeilen)</h2><pre class="log">${esc(lines.slice(-25).join("\n"))}</pre>`;
    } catch { logTail = ""; }
    const mp4 = t.mp4 ? `<div class="card"><span class="ok">✓ MP4 fertig:</span> <b>${esc(t.mp4)}</b> (Galerie)</div>` : "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      page("Auftrag " + id, "jobs", qTok,
        `<h2>Auftrag ${esc(id)}</h2><p>${chip(t.state)} — ${esc(t.step || "")}</p>`
        + (t.state === "running" ? `<meta http-equiv="refresh" content="5">` : "")
        + mp4 + noShots + shots + logTail
        + `<p><a class="btn sec" href="/jobs/${id}/task.log?token=${qTok}">Voll-Log</a></p>`));
    return;
  }
  if (req.method === "GET" && u.pathname.startsWith("/jobs/")) {
    if (!needAuth()) return;
    const fp = path.normalize(path.join(JOBS, decodeURIComponent(u.pathname.slice(6))));
    if (!fp.startsWith(JOBS) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404).end("nicht gefunden"); return;
    }
    const ext = { ".png": "image/png", ".jpg": "image/jpeg", ".log": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8" }[path.extname(fp)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ext }).end(fs.readFileSync(fp));
    return;
  }
  if (req.method === "POST" && u.pathname === "/job") {
    if (!needAuth()) return;
    bodyOf().then((b) => {
      const p = new URLSearchParams(b);
      const prompt = (p.get("prompt") || "").trim();
      if (prompt.length < 10) { res.writeHead(400).end("Prompt zu kurz"); return; }
      const seconds = [10, 30, 60, 90].includes(parseInt(p.get("seconds"), 10)) ? parseInt(p.get("seconds"), 10) : 30;
      const id = Date.now().toString(36);
      fs.mkdirSync(path.join(JOBS, id), { recursive: true });
      tasks.set(id, { state: "running", step: "wartet", prompt: prompt.slice(0, 120) });
      pipeline(id, {
        prompt, seconds,
        provider: p.get("provider") === "openrouter" ? "openrouter" : "omniroute",
        model: (p.get("model") || "").trim(), render: p.get("render") === "1",
      });
      res.writeHead(303, { Location: "/status?id=" + id + "&token=" + qTok }).end();
    }).catch(() => res.writeHead(400).end("ungültig"));
    return;
  }
  res.writeHead(404).end("nicht gefunden");
});

server.listen(PORT, "0.0.0.0", () => console.log("Job-UI v2 auf :" + PORT));
