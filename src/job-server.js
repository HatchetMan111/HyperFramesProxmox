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

async function fetchModels(provider) {
  const s = loadSettings();
  const isOR = provider === "openrouter";
  const base = isOR ? "https://openrouter.ai/api/v1" : s.omniUrl;
  const key = isOR ? s.openrouterKey : s.omniKey;
  const headers = {};
  if (key) headers.Authorization = "Bearer " + key;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(base + "/models", { headers, signal: ctl.signal });
    if (!res.ok) return { ok: false, info: "HTTP " + res.status };
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id).filter(Boolean).sort().slice(0, 2000);
    return { ok: true, models: ids, count: ids.length };
  } catch (e) {
    return { ok: false, info: e.message };
  } finally { clearTimeout(t); }
}
function extractHTML(text) {
  const m = text.match(/```html\s*([\s\S]*?)```/i);
  const html = (m ? m[1] : text).trim();
  if (!html.includes("data-composition-id")) return null;
  return html;
}
function compositionDuration(html) {
  const m = html.match(/data-composition-id[^>]*data-duration=["']([\d.]+)["']/)
    || html.match(/data-duration=["']([\d.]+)["'][^>]*data-composition-id/);
  const d = m ? parseFloat(m[1]) : 10;
  return d > 0 && d <= 600 ? d : 10;
}
function listSnapshots(jobDir, subDir) {
  try {
    return fs.readdirSync(path.join(jobDir, subDir))
      .filter((f) => /^frame-.*\.png$/i.test(f))
      .sort()
      .slice(0, 12);
  } catch { return []; }
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
function shCapture(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out: out.trim().slice(0, 2000) }));
    p.on("error", (e) => resolve({ code: 127, out: e.message }));
  });
}

/* ---------- System-Verwaltung (alles per UI, ohne SSH) ---------- */
const ENV_FILE = path.join(BASE, ".env");
const ALLOWED_RESTARTS = ["hf-jobs", "hf-studio", "hf-studio-bridge", "hf-gallery", "hf-portal", "omniroute"];
async function serviceStates() {
  const out = [];
  for (const s of ALLOWED_RESTARTS) {
    const r = await shCapture("systemctl", ["is-active", s]);
    out.push({ name: s, active: r.out === "active" });
  }
  return out;
}
async function versions() {
  const hf = await shCapture("hyperframes", ["--version"]);
  const node = await shCapture("node", ["--version"]);
  return { hyperframes: hf.out.split("\n")[0] || "?", node: node.out.split("\n")[0] || "?" };
}
function setEnvToken(newToken) {
  let content = "";
  try { content = fs.readFileSync(ENV_FILE, "utf8"); } catch { content = ""; }
  if (/^JOB_TOKEN=.*/m.test(content)) content = content.replace(/^JOB_TOKEN=.*/m, "JOB_TOKEN=" + newToken);
  else content += (content.endsWith("\n") || content === "" ? "" : "\n") + "JOB_TOKEN=" + newToken + "\n";
  fs.writeFileSync(ENV_FILE, content, { mode: 0o600 });
}
function systemPage(tok, states, vers, msg) {
  const rows = states.map((s) =>
    `<div class="card" style="display:flex;align-items:center;gap:12px">`
    + `${s.active ? '<span class="ok">● aktiv</span>' : '<span class="err">● gestoppt</span>'} <b>${esc(s.name)}</b>`
    + `<form method="post" action="/system/restart?token=${esc(tok)}" style="margin-left:auto">`
    + `<input type="hidden" name="svc" value="${esc(s.name)}">`
    + `<button style="margin:0;padding:8px 18px">Neu starten</button></form></div>`).join("");
  return page("System", "sys", tok, `
<h2>🖥 System — alles ohne SSH</h2>
${msg ? `<div class="card">${msg}</div>` : ""}
<div class="card"><b>Versionen:</b> Hyperframes ${esc(vers.hyperframes)} · Node ${esc(vers.node)}<br>
<span class="mut">Basis: ${esc(BASE)} · Chrome, FFmpeg und Keys siehe unten.</span></div>
<h2>Dienste</h2>${rows}
<div class="card"><h2>Job-UI-Token wechseln</h2>
<p class="mut">Neues Token speichern → Dienst startet automatisch neu → danach mit neuem Token anmelden.</p>
<form method="post" action="/system/token?token=${esc(tok)}">
<input type="text" name="newtoken" required minlength="12" placeholder="Neues Token (min. 12 Zeichen)">
<button>Token wechseln + neu starten</button></form></div>
<div class="card"><h2>Galerie-Passwort neu setzen</h2>
<form method="post" action="/system/gallery-password?token=${esc(tok)}">
<input type="text" name="newpw" required minlength="12" placeholder="Neues Galerie-Passwort (min. 12 Zeichen)">
<button>Passwort setzen</button></form></div>
<div class="card"><h2>Update aus GitHub</h2>
<p class="mut">Holt update.sh aus dem Repo und führt es aus (Log unten). Dauert Minuten.</p>
<form method="post" action="/system/update?token=${esc(tok)}"><button>Update starten</button></form>
<p><a class="btn sec" href="/system/update-log?token=${esc(tok)}">Update-Log ansehen</a></p></div>`);
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

    if (!html.includes("__timelines")) say("WARNUNG: Entwurf ohne __timelines-Timeline — Vorschau/Render evtl. statisch (siehe Log)");
    set({ step: "lint + Snapshots …" });
    say("lint + Snapshots laufen");
    const lintCode = await run("hyperframes", ["lint"], projDir, logFile);
    if (lintCode !== 0) say("WARNUNG: lint meldet Fehler (siehe Log) — trotzdem weiter");
    const times = snapshotTimes(duration);
    set({ times: times.split(","), duration });
    // Absolute Pfade: hyperframes löst -o gegen process.cwd() auf, nicht gegen das
    // Spawn-cwd — relative Pfade würden nach /opt/hyperframes schreiben und die
    // Statusseite fände keine Snapshots.
    const snapDir = path.join(projDir, "entwurf");
    const snapCode = await run("hyperframes", ["snapshot", "--at", times, "--no-end", "-o", snapDir], projDir, logFile);
    if (snapCode !== 0) say("WARNUNG: Snapshot fehlgeschlagen (Exit " + snapCode + ") — meist fehlt Chrome: im CT 'sudo -u hyperframes hyperframes browser ensure' ausführen");

    if (opts.render) {
      set({ step: "rendere MP4 (dauert Minuten) …" });
      say("Render startet");
      const outMp4 = path.join(projDir, "ergebnis.mp4");
      const code = await run("hyperframes", ["render", "-o", outMp4], projDir, logFile);
      const mp4 = outMp4;
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
const NAV = (on, tok) => {
  const t = esc(tok);
  return `<nav><a href="/?token=${t}" class="${on === "neu" ? "on" : ""}">＋ Neu</a>`
  + `<a href="/jobs-list?token=${t}" class="${on === "jobs" ? "on" : ""}">Aufträge</a>`
  + `<a href="/einstellungen?token=${t}" class="${on === "set" ? "on" : ""}">⚙ KI-Keys</a>`
  + `<a href="/system?token=${t}" class="${on === "sys" ? "on" : ""}">🖥 System</a></nav>`;
};
const page = (title, on, tok, body) => `<!doctype html><html lang="de"><head><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Hyperframes</title>`
  + `<style>${CSS}</style></head><body><h1>🎬 Hyperframes Job-UI</h1>${NAV(on, tok)}${body}</body></html>`;

function formPage(tok, s) {
  const orOk = !!s.openrouterKey, omniLocal = s.omniUrl.includes("127.0.0.1") || s.omniUrl.includes("localhost");
  return page("Neuer Auftrag", "neu", tok, `
<h2>Prompt → Video</h2>
<form method="post" action="/job?token=${esc(tok)}">
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
<span class="mut">${esc(omniLocal ? "lokal, Free-Tiers" : s.omniUrl)}${s.omniKey ? " · Key hinterlegt" : ""}</span></label>
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
<form method="post" action="/einstellungen?token=${esc(tok)}">
<div class="card"><h2>OpenRouter</h2>
<label>API-Token <span class="mut">(aktuell: ${esc(mask(s.openrouterKey))})</span></label>
<input type="password" name="openrouterKey" placeholder="sk-or-… (leer = unverändert)" autocomplete="off">
<label>Standard-Modell</label>
<input type="text" id="model-openrouter" name="openrouterModel" value="${esc(s.openrouterModel)}">
<div class="mut">Aus Liste wählen:</div>
<input type="text" id="q-openrouter" placeholder="🔍 Modelle suchen …" oninput="filterMods('openrouter')">
<div style="display:flex;gap:10px;margin-top:8px">
<button type="button" class="btn sec" style="margin:0" onclick="loadMods('openrouter')">Liste laden</button>
<a class="btn sec" style="margin:0" href="/test?provider=openrouter&token=${esc(tok)}">Verbindung testen</a></div>
<div id="list-openrouter" class="modlist"><span class="mut">Noch nicht geladen.</span></div></div>
<div class="card"><h2>OmniRoute-Instanz</h2>
<label>Basis-URL <span class="mut">(eigene Instanz oder lokal)</span></label>
<input type="text" name="omniUrl" value="${esc(s.omniUrl)}">
<label>API-Key <span class="mut">(aktuell: ${esc(mask(s.omniKey))}, leer lassen wenn keyless)</span></label>
<input type="password" name="omniKey" placeholder="leer = unverändert" autocomplete="off">
<label>Standard-Modell</label>
<input type="text" id="model-omniroute" name="omniModel" value="${esc(s.omniModel)}">
<div class="mut">Aus Liste wählen:</div>
<input type="text" id="q-omniroute" placeholder="🔍 Modelle suchen …" oninput="filterMods('omniroute')">
<div style="display:flex;gap:10px;margin-top:8px">
<button type="button" class="btn sec" style="margin:0" onclick="loadMods('omniroute')">Liste laden</button>
<a class="btn sec" style="margin:0" href="/test?provider=omniroute&token=${esc(tok)}">Verbindung testen</a></div>
<div id="list-omniroute" class="modlist"><span class="mut">Noch nicht geladen.</span></div></div>
<button>Speichern</button></form>
<p class="mut">Gespeichert in <code>settings.json</code> (0600, nur lesbar für den Dienst). „__LEEREN__" als Key löscht ihn. Datei-Einträge aus <code>.env</code> gelten als Fallback.</p>
<style>.modlist{max-height:220px;overflow:auto;border:1px solid #333;border-radius:9px;margin-top:8px;background:#0d0d0d}
.modlist div{padding:8px 12px;cursor:pointer;border-bottom:1px solid #222;font-size:14px}
.modlist div:hover{background:#1e3a24}</style>
<script>
const MODS = { openrouter: [], omniroute: [] };
const TOK = ${JSON.stringify(tok)};
async function loadMods(p) {
  const box = document.getElementById("list-" + p);
  box.innerHTML = "<span class='mut'>Lade …</span>";
  try {
    const r = await fetch("/modelle?provider=" + p + "&token=" + encodeURIComponent(TOK));
    const j = await r.json();
    if (!j.ok) { box.innerHTML = "<span class='mut'>Fehler: " + j.info + "</span>"; return; }
    MODS[p] = j.models;
    renderMods(p, "");
  } catch (e) { box.innerHTML = "<span class='mut'>Fehler: " + e.message + "</span>"; }
}
function renderMods(p, q) {
  const box = document.getElementById("list-" + p);
  const hit = MODS[p].filter((m) => m.toLowerCase().includes(q.toLowerCase())).slice(0, 100);
  box.innerHTML = hit.length
    ? hit.map((m) => "<div onclick=\\"pickMod('" + p + "','" + m.replace(/'/g, "&#39;") + "')\\">" + m + "</div>").join("")
    : "<span class='mut'>Keine Treffer.</span>";
}
function filterMods(p) { renderMods(p, document.getElementById("q-" + p).value); }
function pickMod(p, m) {
  document.getElementById("model-" + p).value = m;
  document.getElementById("model-" + p).scrollIntoView({ block: "center" });
}
</script>`);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
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
          + `<p><a class="btn sec" href="/einstellungen?token=${esc(qTok)}">Zurück</a></p>`));
    });
    return;
  }
  if (req.method === "GET" && u.pathname === "/modelle") {
    if (!needAuth()) return;
    const provider = u.searchParams.get("provider") === "openrouter" ? "openrouter" : "omniroute";
    const r = await fetchModels(provider);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(r));
    return;
  }
  if (req.method === "GET" && u.pathname === "/jobs-list") {
    if (!needAuth()) return;
    // Aufträge vom Datenträger mit einbeziehen (Tasks im Speicher gehen bei Neustart verloren)
    const known = new Map(tasks);
    try {
      for (const d of fs.readdirSync(JOBS)) {
        if (/^[a-z0-9]+$/i.test(d) && !known.has(d) && fs.statSync(path.join(JOBS, d)).isDirectory())
          known.set(d, { state: "done", step: "aus früherer Sitzung (Log einsehen)", prompt: "" });
      }
    } catch { /* Jobs-Verzeichnis fehlt noch */ }
    const items = [...known.entries()].reverse().map(([id, t]) =>
      `<div class="card">${chip(t.state)} <a href="/status?id=${esc(id)}&token=${esc(qTok)}"><b>${esc(id)}</b></a><br>`
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
    const found = listSnapshots(path.join(JOBS, id, "projekt"), "entwurf");
    const shots = (found.length ? found : (t.times || []).map((at, i) => "frame-0" + i + "-at-" + at + "s.png"))
      .filter((f) => fs.existsSync(path.join(JOBS, id, "projekt", "entwurf", f)))
      .map((f) => `<img class="shot" src="/jobs/${esc(id)}/projekt/entwurf/${esc(f)}?token=${esc(qTok)}">`).join("");
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
        + `<p><a class="btn sec" href="/jobs/${esc(id)}/task.log?token=${esc(qTok)}">Voll-Log</a></p>`));
    return;
  }
  if (req.method === "GET" && u.pathname.startsWith("/jobs/")) {
    if (!needAuth()) return;
    let rel;
    try {
      rel = decodeURIComponent(u.pathname.slice(6));
    } catch { res.writeHead(400).end("ungültige URL-Kodierung"); return; }
    if (rel.includes("\0")) { res.writeHead(400).end("ungültig"); return; }
    const fp = path.normalize(path.join(JOBS, rel));
    if (!fp.startsWith(JOBS) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404).end("nicht gefunden"); return;
    }
    const ext = { ".png": "image/png", ".jpg": "image/jpeg", ".log": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8" }[path.extname(fp)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ext }).end(fs.readFileSync(fp));
    return;
  }
  if (req.method === "GET" && u.pathname === "/system") {
    if (!needAuth()) return;
    const [states, vers] = await Promise.all([serviceStates(), versions()]);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(systemPage(qTok, states, vers, ""));
    return;
  }
  if (req.method === "POST" && u.pathname === "/system/restart") {
    if (!needAuth()) return;
    bodyOf().then(async (b) => {
      const svc = new URLSearchParams(b).get("svc") || "";
      if (!ALLOWED_RESTARTS.includes(svc)) { res.writeHead(400).end("unbekannter Dienst"); return; }
      const r = await shCapture("sudo", ["systemctl", "restart", svc]);
      const [states, vers] = await Promise.all([serviceStates(), versions()]);
      const msg = r.code === 0 ? `<span class="ok">✓ ${esc(svc)} wird neu gestartet.</span>`
        : `<span class="err">✘ Neustart fehlgeschlagen (Exit ${r.code}).</span> ${esc(r.out)}<br><span class="mut">Fehlt die sudo-Regel? Install-Script erneut laufen lassen (RESUME_MODE=1).</span>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(systemPage(qTok, states, vers, msg));
    }).catch(() => res.writeHead(400).end("ungültig"));
    return;
  }
  if (req.method === "POST" && u.pathname === "/system/token") {
    if (!needAuth()) return;
    bodyOf().then((b) => {
      const nt = (new URLSearchParams(b).get("newtoken") || "").trim();
      if (nt.length < 12) { res.writeHead(400).end("Token zu kurz (min. 12)"); return; }
      try { setEnvToken(nt); } catch (e) { res.writeHead(500).end("Schreiben fehlgeschlagen: " + e.message); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        `<h1>Token gewechselt</h1><p>Dienst startet neu — in ca. 10 Sekunden mit dem <b>neuen</b> Token anmelden.</p>`);
      setTimeout(() => { shCapture("sudo", ["systemctl", "restart", "hf-jobs"]).then(() => process.exit(0)); }, 800);
    }).catch(() => res.writeHead(400).end("ungültig"));
    return;
  }
  if (req.method === "POST" && u.pathname === "/system/gallery-password") {
    if (!needAuth()) return;
    bodyOf().then(async (b) => {
      const pw = (new URLSearchParams(b).get("newpw") || "").trim();
      if (pw.length < 12) { res.writeHead(400).end("Passwort zu kurz (min. 12, FileBrowser-Vorgabe)"); return; }
      const r = await shCapture("filebrowser", ["users", "update", "admin", "--password", pw, "--database", path.join(BASE, "filebrowser.db")]);
      const [states, vers] = await Promise.all([serviceStates(), versions()]);
      const msg = r.code === 0 ? `<span class="ok">✓ Galerie-Passwort gesetzt.</span>`
        : `<span class="err">✘ Fehlgeschlagen (Exit ${r.code}).</span> ${esc(r.out)}`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(systemPage(qTok, states, vers, msg));
    }).catch(() => res.writeHead(400).end("ungültig"));
    return;
  }
  if (req.method === "POST" && u.pathname === "/system/update") {
    if (!needAuth()) return;
    const logFile = path.join(BASE, "update.log");
    // Update läuft im Hintergrund (sudo); Status via Log
    fs.appendFileSync(logFile, "\n=== Update gestartet (UI) ===\n");
    const upd = spawn("sudo", [path.join(BASE, "update.sh")]);
    const log = fs.createWriteStream(logFile, { flags: "a" });
    upd.stdout.on("data", (d) => log.write(d));
    upd.stderr.on("data", (d) => log.write(d));
    upd.on("close", (c) => { log.write("\n[update exit " + c + "]\n"); log.end(); });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      page("Update", "sys", qTok, `<h2>Update läuft …</h2><p>Dauert Minuten.</p>`
        + `<meta http-equiv="refresh" content="8;url=/system/update-log?token=${esc(qTok)}">`
        + `<p><a class="btn sec" href="/system/update-log?token=${esc(qTok)}">Zum Log</a></p>`));
    return;
  }
  if (req.method === "GET" && u.pathname === "/system/update-log") {
    if (!needAuth()) return;
    let content = "(noch kein Update-Log)";
    try {
      const lines = fs.readFileSync(path.join(BASE, "update.log"), "utf8").split("\n");
      content = lines.slice(-60).join("\n");
    } catch { content = "(noch kein Update-Log)"; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      page("Update-Log", "sys", qTok, `<h2>Update-Log</h2><pre class="log">${esc(content)}</pre>`
        + `<meta http-equiv="refresh" content="10">`));
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
