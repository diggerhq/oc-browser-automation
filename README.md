# OpenComputer + Libretto browser automation

Runnable reference implementations of the patterns described in the OpenComputer [Browser Automation guide](https://docs.opencomputer.dev/guides/browser-automation).

Two demos:

## 1. Flight price race (`launch.ts`)

Spawns an OpenComputer sandbox, runs **N parallel Libretto sessions** against flight aggregators (Kayak, Google Flights, Skyscanner, Expedia, Southwest), AI-extracts the cheapest price from each, and renders live results in a web UI served from the sandbox itself.

```bash
ANTHROPIC_API_KEY=sk-... npm run launch
```

Open the preview URL printed at the end. Type a city pair + date, hit Search, watch tiles populate as each site settles.

## 2. Logged-in SaaS workflow (`otaco.ts`)

Same sandbox shape, different story: **log in once via an embedded live browser** (Xvfb + x11vnc + noVNC iframe), then run agentic natural-language tasks (“create a unit named demo-42”) using the persisted cookies. Demonstrates:

- Real-browser login in-sandbox (credentials never leave your device)
- Cookie persistence across task runs
- Agent-loop execution: observe → plan one step → act → repeat

```bash
ANTHROPIC_API_KEY=sk-... OTACO_URL=https://your-saas.app npm run otaco
```

## Setup

```bash
npm install
npm run build-snapshot   # one-time: builds the libretto-app OC snapshot
```

You need:
- An OpenComputer API key (`OPENCOMPUTER_API_KEY` in env, or `~/.opencomputer/config`)
- An Anthropic API key for Libretto’s AI snapshot + the agent-loop planner

## Files

| File | Purpose |
|---|---|
| `build-snapshot.ts` | Creates the `libretto-app` snapshot with Chromium runtime deps + libretto + Playwright pre-installed |
| `launch.ts` | Launcher for the flight demo |
| `server.ts` | In-sandbox Hono app for the flight demo (uploaded fresh each launch) |
| `otaco.ts` | Launcher for the logged-in-SaaS demo |
| `otaco-server.ts` | In-sandbox Hono app for the otaco demo, including VNC iframe + agent loop |
| `run.ts` | Early one-shot script that hits libretto directly, useful for verifying setup |

## Platform caveats we hit during development

Documented in detail in the [guide](https://docs.opencomputer.dev/guides/browser-automation#troubleshooting), but the short list:

- Sandboxes need a `secretStore` attached, or the egress proxy refuses all traffic.
- `/etc/hosts` has no `localhost` entry by default — Libretto’s CDP client hardcodes `http://localhost`, so add it at boot.
- Chromium ignores `SSL_CERT_FILE` — trust OC’s egress-proxy CA via `certutil` in Chromium’s NSS store.
- OC preview URLs buffer response bodies — use short-polling, not SSE, for progress updates.
- `memoryMB` is currently ignored; VMs boot with ~900 MB. Run 2–3 concurrent headless Chromiums at most until this is fixed upstream.

## License

MIT.
