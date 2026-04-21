/**
 * Logged-in-SaaS workflow server. Runs inside the sandbox on :3000.
 *
 * Two phases:
 *   Phase 1 (VNC login) — POST /api/login/start opens OTACO_URL in a *headed*
 *     libretto session against Xvfb :99. The UI embeds an iframe pointing at
 *     the p6080 preview URL (websockify + noVNC), so the user sees the real
 *     browser and types credentials there. POST /api/login/save persists the
 *     cookies/localStorage via `libretto save <host>`.
 *   Phase 2 (automated task) — POST /api/tasks opens a headless session with
 *     `--auth-profile <host>` so it's already logged in. AI plans the click/fill
 *     sequence, `libretto exec` performs it, final screenshot is returned.
 *
 * Xvfb/x11vnc/websockify are started by otaco.ts (the launcher) as long-lived
 * exec sessions; this server only talks libretto.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";

const execFileP = promisify(execFile);
const LIBRETTO_CWD = "/home/sandbox";
const SESSIONS_DIR = "/home/sandbox/.libretto/sessions";

const OTACO_URL = process.env.OTACO_URL || "https://otaco.app";
const OTACO_HOST = new URL(OTACO_URL).hostname;
// One session name used for both phases — libretto persists cookies/localStorage
// per-session under .libretto/sessions/<name>/, so reopening with the same
// name restores the logged-in state. (There is no --auth-profile flag on `open`.)
const SESSION = "otaco";

async function closeIfStale(session: string) {
  await execFileP("npx", ["libretto", "close", "--session", session], {
    cwd: LIBRETTO_CWD, timeout: 15_000,
  }).catch(() => { /* best-effort */ });
}

/** Reap any Chromium / Playwright / node-libretto processes left behind from
 *  prior sessions. `libretto close` doesn't always cleanly kill the browser
 *  process tree; on a 896MB VM with RLIMIT_NPROC=3550, leaked threads will
 *  starve future libretto spawns with EAGAIN. */
async function reapBrowsers() {
  await execFileP("bash", ["-c",
    "pkill -9 -f chrome-headless-shell 2>/dev/null; " +
    "pkill -9 -f 'chrome/chrome' 2>/dev/null; " +
    "pkill -9 -f 'ms-playwright' 2>/dev/null; " +
    "pkill -9 -f 'libretto open' 2>/dev/null; " +
    "pkill -9 -f 'libretto snapshot' 2>/dev/null; " +
    "sleep 0.5; true",
  ], { cwd: LIBRETTO_CWD, timeout: 10_000 }).catch(() => { /* best-effort */ });
}

async function openSession(url: string, opts: { headed: boolean }) {
  await closeIfStale(SESSION);
  await reapBrowsers();
  const modeFlag = opts.headed ? "--headed" : "--headless";
  // --headed renders to DISPLAY (set by otaco.ts to :99 → Xvfb → x11vnc → websockify).
  // Same session name across both modes → cookies/localStorage from headed
  // login survive into headless task runs.
  await execFileP("npx", ["libretto", "open", url, "--session", SESSION, modeFlag], {
    cwd: LIBRETTO_CWD, timeout: 90_000,
  });
}

async function saveProfile(session: string, host: string) {
  await execFileP("npx", ["libretto", "save", host, "--session", session], {
    cwd: LIBRETTO_CWD, timeout: 30_000,
  });
}

/** Libretto snapshot returns formatted prose (PNG/HTML paths + Analysis section).
 *  It's intended to be READ by an agent, not parsed. We just return the raw
 *  text and feed it to a separate Claude call for structured planning. */
async function librettoSnapshot(
  session: string, objective: string, context: string,
): Promise<string> {
  const { stdout } = await execFileP(
    "npx",
    ["libretto", "snapshot", "--session", session, "--objective", objective, "--context", context],
    { cwd: LIBRETTO_CWD, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

/** Direct Claude call via the Anthropic REST API. Returns the text content. */
async function askClaude(prompt: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { content: Array<{ type: string; text: string }> };
  const text = data.content.find((c) => c.type === "text")?.text || "";
  return text;
}

/** Run libretto snapshot, then ask Claude to turn the page description into
 *  a structured click/fill plan. Two-step pipeline gives us reliable JSON. */
async function planFromPage<T>(
  session: string, pageObjective: string, context: string, planPrompt: string,
): Promise<{ parsed: T | null; rawSnapshot: string; rawPlan: string }> {
  const rawSnapshot = await librettoSnapshot(session, pageObjective, context);
  const rawPlan = await askClaude(
    `Here is an AI-generated description of the current browser page:\n\n` +
    `---\n${rawSnapshot}\n---\n\n` +
    `${planPrompt}\n\n` +
    `Reply with ONLY a JSON object and no surrounding prose or code fences.`,
  );
  const match = rawPlan.match(/\{[\s\S]*\}/);
  if (!match) return { parsed: null, rawSnapshot, rawPlan };
  try { return { parsed: JSON.parse(match[0]) as T, rawSnapshot, rawPlan }; }
  catch { return { parsed: null, rawSnapshot, rawPlan }; }
}

/** Run Playwright code against a live libretto session. Libretto's `exec`
 *  subcommand reads code from stdin — there's no --code flag. */
async function librettoExec(session: string, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // `libretto exec - --session X` — the dash tells libretto to read the
    // Playwright code from stdin.
    const p = spawn("npx", ["libretto", "exec", "-", "--session", session], {
      cwd: LIBRETTO_CWD,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("libretto exec timed out")); }, 60_000);
    p.stdout.on("data", (d) => { stdout += d.toString(); });
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`libretto exec exit=${code}: ${stderr || stdout}`));
    });
    p.on("error", (err) => { clearTimeout(timer); reject(err); });
    p.stdin.end(code);
  });
}

function latestSnapshotPng(session: string): Buffer | null {
  const dir = join(SESSIONS_DIR, session, "snapshots");
  try {
    const subs = readdirSync(dir).filter((e) => e.startsWith("snapshot-")).sort();
    const latest = subs[subs.length - 1];
    if (!latest) return null;
    return readFileSync(join(dir, latest, "page.png"));
  } catch { return null; }
}

function profileExists(): boolean {
  return !!findProfilePath();
}

/** Libretto saves auth via `libretto save <domain> --session X` to a single
 *  JSON file: .libretto/profiles/<domain>.json. That's what we look for. */
function findProfilePath(): string | null {
  const p = `/home/sandbox/.libretto/profiles/${OTACO_HOST}.json`;
  return existsSync(p) ? p : null;
}

/** Recursively list everything under .libretto/ for debugging. */
function listLibrettoTree(): string[] {
  const out: string[] = [];
  const walk = (p: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(p); } catch { return; }
    for (const e of entries) {
      const full = `${p}/${e}`;
      out.push(full.replace("/home/sandbox/.libretto", ""));
      // Recurse only into directories.
      try {
        const stat = require("node:fs").statSync(full);
        if (stat.isDirectory()) walk(full, depth + 1);
      } catch { /* ignore */ }
    }
  };
  walk("/home/sandbox/.libretto", 0);
  return out.sort();
}

// ── Jobs (for task phase) ──────────────────────────────────────────────────
type Step = { at: number; message: string; level: "info" | "ok" | "fail" };
type Job = {
  id: string;
  started: number;
  task: string;
  steps: Step[];
  status: "running" | "done" | "fail";
  error?: string;
};
const jobs = new Map<string, Job>();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, j] of jobs) if (j.started < cutoff) jobs.delete(id);
}, 60_000);

function step(job: Job, message: string, level: Step["level"] = "info") {
  job.steps.push({ at: Date.now(), message, level });
  console.log(`[${job.id.slice(0, 8)}] ${message}`);
}

const MAX_AGENT_STEPS = 15;

type AgentDecision = {
  done: boolean;
  reason: string;
  action?: {
    type: "click" | "fill";
    selector: string;
    value?: string;
    note: string;
  };
};

async function runTask(job: Job) {
  try {
    if (!profileExists()) throw new Error(`no saved login for ${OTACO_HOST}; complete VNC login first`);

    step(job, `Opening ${OTACO_URL} with saved profile...`);
    await openSession(OTACO_URL, { headed: false });

    // Agent loop: observe page → ask Claude for next action → execute → repeat.
    // One-shot planning breaks for multi-page flows (e.g., clicking a button
    // reveals a form that wasn't visible when we originally planned).
    const history: string[] = [];

    for (let i = 1; i <= MAX_AGENT_STEPS; i++) {
      step(job, `Step ${i}/${MAX_AGENT_STEPS} — observing page...`);

      const { parsed: decision, rawPlan } = await planFromPage<AgentDecision>(
        SESSION,
        `Describe the visible interactive elements (buttons, inputs, links), their selectors, ` +
          `and current page state. Focus on elements relevant to: "${job.task}".`,
        `Step ${i}/${MAX_AGENT_STEPS}. Task: "${job.task}".`,
        `User task: "${job.task}".\n\n` +
        `Actions taken so far:\n${history.length ? history.map((a, idx) => `  ${idx + 1}. ${a}`).join("\n") : "  (none)"}\n\n` +
        `Based on the page description above, decide ONE of:\n` +
        `  - The task is complete → return {"done": true, "reason": string}\n` +
        `  - One more action needed → return {"done": false, "reason": string, "action": {"type": "click"|"fill", "selector": string, "value"?: string, "note": string}}\n\n` +
        `Prefer stable selectors (data-testid, aria-label, visible text). Don't repeat actions already taken.`,
      );

      if (!decision) {
        step(job, `Agent output: ${rawPlan.slice(0, 400)}`, "fail");
        throw new Error("Claude did not return a parseable decision");
      }

      if (decision.done) {
        step(job, `Task complete: ${decision.reason}`, "ok");
        return;
      }

      if (!decision.action) {
        step(job, `Agent stuck: ${decision.reason}`, "fail");
        throw new Error("No action returned but task not marked done");
      }

      const a = decision.action;
      step(job, `${a.type} ${a.selector}${a.value ? ` = "${a.value}"` : ""} — ${a.note}`);

      const sel = JSON.stringify(a.selector);
      if (a.type === "fill") {
        await librettoExec(SESSION, `await page.fill(${sel}, ${JSON.stringify(a.value ?? "")});`);
      } else {
        await librettoExec(SESSION, `await page.click(${sel});`);
      }
      await librettoExec(SESSION, `await page.waitForLoadState("networkidle").catch(() => {});`);

      history.push(`${a.type} ${a.selector}${a.value ? ` = "${a.value}"` : ""} (${a.note})`);
    }

    throw new Error(`Hit MAX_AGENT_STEPS=${MAX_AGENT_STEPS} without reported completion`);

    job.status = "done";
    step(job, "Done.", "ok");
  } catch (err: unknown) {
    job.status = "fail";
    job.error = err instanceof Error ? err.message : String(err);
    step(job, job.error, "fail");
  } finally {
    await closeIfStale(SESSION);
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const app = new Hono();

app.get("/", (c) => c.html(UI_HTML));

app.get("/api/status", (c) => c.json({
  host: OTACO_HOST,
  url: OTACO_URL,
  hasProfile: profileExists(),
  profilePath: findProfilePath(),
  librettoTree: listLibrettoTree(),
  vncPort: 6080,
}));

app.post("/api/login/start", async (c) => {
  try {
    await openSession(OTACO_URL, { headed: true });
    return c.json({ ok: true, message: `headed session "${SESSION}" open — connect VNC and log in` });
  } catch (err: unknown) {
    // Libretto emits detailed startup failures to sessions/<name>/logs.jsonl.
    // Surface the last handful of lines so the UI (and us) stop guessing.
    let log = "";
    try {
      const path = `${SESSIONS_DIR}/${SESSION}/logs.jsonl`;
      if (existsSync(path)) {
        const all = readFileSync(path, "utf8").trim().split("\n");
        log = all.slice(-10).join("\n");
      }
    } catch { /* best-effort */ }
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      log,
    }, 500);
  }
});

app.post("/api/login/save", async (c) => {
  try {
    await saveProfile(SESSION, OTACO_HOST);
    await closeIfStale(SESSION);
    return c.json({ ok: true, hasProfile: profileExists() });
  } catch (err: unknown) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/api/login/cancel", async (c) => {
  await closeIfStale(SESSION);
  return c.json({ ok: true });
});

app.post("/api/tasks", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const task = String(body.task || "").trim();
  if (!task) return c.json({ error: "task is required" }, 400);
  const job: Job = { id: randomUUID(), started: Date.now(), task, steps: [], status: "running" };
  jobs.set(job.id, job);
  runTask(job).catch((err) => console.error(`job ${job.id} threw:`, err));
  return c.json({ jobId: job.id });
});

app.get("/api/tasks/:id", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json(job);
});

app.get("/screenshot", (c) => {
  const png = latestSnapshotPng(SESSION);
  if (!png) return c.notFound();
  return c.body(png, 200, { "content-type": "image/png", "cache-control": "no-store" });
});

const PORT = 3000;
serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`otaco demo listening on ${info.address}:${info.port}  (profile cached: ${profileExists()}, host=${OTACO_HOST})`);
});

// ── UI ──────────────────────────────────────────────────────────────────────
const UI_HTML = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>otaco workflow demo</title>
<style>
  body { font: 14px system-ui, sans-serif; max-width: 1200px; margin: 1.5rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { margin: 0 0 .25rem; }
  .tag { color: #666; margin-bottom: 1.25rem; font-size: 13px; }
  button { padding: .55rem .9rem; font: inherit; border: 1px solid #111; border-radius: 4px; background: #111; color: white; cursor: pointer; }
  button.ghost { background: white; color: #111; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  input[type="text"] { padding: .55rem .75rem; font: inherit; border: 1px solid #ccc; border-radius: 4px; width: 100%; box-sizing: border-box; }
  .row { display: flex; gap: .5rem; margin-bottom: 1rem; }
  .row input { flex: 1; }
  .panel { border: 1px solid #e5e5e5; border-radius: 8px; padding: 1rem; background: white; margin-bottom: 1rem; }
  .panel h2 { margin: 0 0 .75rem; font-size: 15px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin-left: .5rem; }
  .badge.warm { background: #e6f9ec; color: #0b8f3a; }
  .badge.cold { background: #fdecec; color: #cc2222; }
  .vnc { width: 100%; height: 640px; border: 1px solid #ddd; border-radius: 4px; background: #000; }
  .steps { margin: 0; padding: 0; list-style: none; font-size: 13px; line-height: 1.5; max-height: 360px; overflow: auto; }
  .steps li { padding: .3rem 0; border-bottom: 1px solid #f0f0f0; display: flex; gap: .5rem; }
  .steps .t { color: #aaa; font-variant-numeric: tabular-nums; font-size: 11px; min-width: 4.5em; }
  .steps .info { color: #333; }
  .steps .ok { color: #0b8f3a; }
  .steps .fail { color: #cc2222; }
  .thumb { max-width: 100%; border: 1px solid #eee; border-radius: 4px; }
  .hidden { display: none !important; }
  .hint { font-size: 12px; color: #888; margin-top: .25rem; }
</style>
</head><body>
<h1>Logged-in workflow demo <span id="badge"></span></h1>
<div class="tag">One sandbox. Log in once via the embedded browser; cookies persist on disk for every task after.</div>

<div class="panel" id="login-panel">
  <h2>1. Log in <span class="hint" id="host-hint"></span></h2>
  <div class="row">
    <button id="login-start">Open browser</button>
    <button id="login-save" class="ghost" disabled>Save login</button>
    <button id="login-cancel" class="ghost" disabled>Cancel</button>
  </div>
  <iframe id="vnc" class="vnc hidden"></iframe>
  <div class="hint">After "Open browser", click into the frame, log in, then click "Save login" to persist cookies.</div>
</div>

<div class="panel" id="task-panel">
  <h2>2. Run a task</h2>
  <form id="f">
    <div class="row">
      <input type="text" name="task" placeholder='e.g. "create a unit named demo-42"' value="create a unit named demo-42">
      <button id="go">Run</button>
    </div>
  </form>
  <ul class="steps" id="steps"><li class="info"><span class="t">—</span><span class="msg">idle</span></li></ul>
  <img class="thumb hidden" id="thumb" alt="">
</div>

<script>
const loginStartBtn = document.getElementById("login-start");
const loginSaveBtn = document.getElementById("login-save");
const loginCancelBtn = document.getElementById("login-cancel");
const vncFrame = document.getElementById("vnc");
const hostHint = document.getElementById("host-hint");
const badgeEl = document.getElementById("badge");
const form = document.getElementById("f");
const go = document.getElementById("go");
const stepsEl = document.getElementById("steps");
const thumbEl = document.getElementById("thumb");

let poller = null, shotPoller = null;

async function refreshStatus() {
  const r = await fetch("/api/status");
  const s = await r.json();
  hostHint.textContent = \`(\${s.host})\`;
  badgeEl.innerHTML = s.hasProfile
    ? '<span class="badge warm">cached login</span>'
    : '<span class="badge cold">no saved login</span>';
  return s;
}
refreshStatus();

function vncUrlFromAppUrl() {
  // App is served from <id>-p3000.<domain>; swap to -p6080.
  return location.origin.replace(/-p3000\\./, "-p6080.") + "/vnc.html?autoconnect=true&resize=scale";
}

loginStartBtn.onclick = async () => {
  loginStartBtn.disabled = true;
  const r = await fetch("/api/login/start", { method: "POST" });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    alert("open failed: " + (e.error || r.status) + (e.log ? "\\n\\n--- libretto log ---\\n" + e.log : ""));
    loginStartBtn.disabled = false;
    return;
  }
  vncFrame.src = vncUrlFromAppUrl();
  vncFrame.classList.remove("hidden");
  loginSaveBtn.disabled = false;
  loginCancelBtn.disabled = false;
};

loginSaveBtn.onclick = async () => {
  loginSaveBtn.disabled = true;
  const r = await fetch("/api/login/save", { method: "POST" });
  const j = await r.json();
  if (!r.ok || !j.ok) { alert("save failed: " + (j.error || r.status)); loginSaveBtn.disabled = false; return; }
  vncFrame.src = "about:blank";
  vncFrame.classList.add("hidden");
  loginStartBtn.disabled = false;
  loginCancelBtn.disabled = true;
  await refreshStatus();
};

loginCancelBtn.onclick = async () => {
  await fetch("/api/login/cancel", { method: "POST" });
  vncFrame.src = "about:blank";
  vncFrame.classList.add("hidden");
  loginStartBtn.disabled = false;
  loginSaveBtn.disabled = true;
  loginCancelBtn.disabled = true;
};

function fmtT(ms) { return new Date(ms).toLocaleTimeString([], { hour12: false }); }
function render(job) {
  stepsEl.innerHTML = job.steps.map((s) =>
    \`<li class="\${s.level}"><span class="t">\${fmtT(s.at)}</span><span class="msg">\${s.message}</span></li>\`
  ).join("") || '<li class="info"><span class="t">—</span><span class="msg">starting...</span></li>';
}

function cleanup() {
  if (poller) clearInterval(poller); poller = null;
  if (shotPoller) clearInterval(shotPoller); shotPoller = null;
  go.disabled = false;
}

form.onsubmit = async (e) => {
  e.preventDefault();
  cleanup(); go.disabled = true;
  stepsEl.innerHTML = '<li class="info"><span class="t">—</span><span class="msg">submitting...</span></li>';
  thumbEl.classList.add("hidden");

  const r = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: form.task.value }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); alert("failed: " + (e.error || r.status)); cleanup(); return; }
  const { jobId } = await r.json();

  shotPoller = setInterval(() => {
    thumbEl.src = "/screenshot?t=" + Date.now();
    thumbEl.classList.remove("hidden");
  }, 1500);

  poller = setInterval(async () => {
    try {
      const r = await fetch("/api/tasks/" + jobId);
      if (!r.ok) return;
      const job = await r.json();
      render(job);
      if (job.status !== "running") cleanup();
    } catch { /* transient */ }
  }, 1000);
};
</script>
</body></html>`;
