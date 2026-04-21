/**
 * Launcher for the logged-in-SaaS workflow demo with VNC-based login.
 *
 * The user logs in to the target site themselves, using a real browser
 * embedded in the page via noVNC. Credentials never leave the sandbox.
 * After login, `libretto save` persists cookies to the data disk so future
 * task runs (via POST /api/tasks in otaco-server.ts) don't need to log in
 * again.
 *
 * Required env:
 *   ANTHROPIC_API_KEY  — libretto AI snapshot for task planning
 *   OTACO_URL          — login URL (default: https://otaco.app)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... OTACO_URL=https://otaco.app npx tsx otaco.ts
 */

import { readFileSync } from "node:fs";

import { Sandbox, SecretStore } from "@opencomputer/sdk/node";

const SNAPSHOT_NAME = "libretto-app";
const SECRET_STORE = "libretto-demo";
const APP_PORT = 3000;
const VNC_PORT = 6080;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set");

  const otacoUrl = process.env.OTACO_URL || "https://otaco.app";

  // Secrets-proxy registration (same quirk as launch.ts).
  const stores = await SecretStore.list();
  let store = stores.find((s) => s.name === SECRET_STORE);
  if (!store) store = await SecretStore.create({ name: SECRET_STORE, egressAllowlist: ["*"] });
  else await SecretStore.update(store.id, { egressAllowlist: ["*"] });
  await SecretStore.setSecret(store.id, "LIBRETTO_DUMMY", "placeholder-to-register-proxy-session");

  console.log(`Launching sandbox from snapshot "${SNAPSHOT_NAME}"...`);
  const sandbox = await Sandbox.create({
    snapshot: SNAPSHOT_NAME,
    timeout: 0,
    envs: {
      ANTHROPIC_API_KEY: apiKey,
      OTACO_URL: otacoUrl,
      TMPDIR: "/home/sandbox/tmp",
      // Xvfb display — libretto --headed renders here.
      DISPLAY: ":99",
    },
    secretStore: SECRET_STORE,
    cpuCount: 4,
    memoryMB: 16384,
  });
  console.log(`  sandbox id: ${sandbox.sandboxId}`);

  // Per-boot setup: /etc/hosts + NSS trust for egress-proxy CA + TMPDIR.
  await sandbox.commands.run(
    "grep -q 'localhost' /etc/hosts || " +
      "(printf '127.0.0.1 localhost\\n::1 localhost\\n' | sudo tee -a /etc/hosts)",
  );
  await sandbox.commands.run(
    [
      "mkdir -p /home/sandbox/.pki/nssdb",
      "certutil -d sql:/home/sandbox/.pki/nssdb -N --empty-password || true",
      "certutil -d sql:/home/sandbox/.pki/nssdb -A -n opensandbox-proxy -t 'TC,C,T' -i /usr/local/share/ca-certificates/opensandbox-proxy.crt",
      "mkdir -p /home/sandbox/tmp && chmod 700 /home/sandbox/tmp",
    ].join(" && "),
  );

  // Add 2GB swap on the data disk so Chromium can page idle memory — OC's
  // memoryMB is ignored and VMs boot with ~896MB, not enough for headed
  // Chromium + Xvfb stack in RAM alone.
  console.log("Adding 2GB swap...");
  const swap = await sandbox.commands.run(
    "if [ ! -f /home/sandbox/swapfile ]; then " +
      "sudo fallocate -l 2G /home/sandbox/swapfile && " +
      "sudo chmod 600 /home/sandbox/swapfile && " +
      "sudo mkswap /home/sandbox/swapfile >/dev/null; " +
    "fi; " +
    "sudo swapon /home/sandbox/swapfile 2>/dev/null || true; " +
    "free -h | awk '/Swap:/ {print $0}'",
  );
  console.log(`  ${swap.stdout.trim()}`);
  if (swap.exitCode !== 0) console.warn("  swap setup failed, continuing anyway:", swap.stderr);

  // VNC stack + full Chromium (not baked into the snapshot so we can iterate
  // without rebuilds). Snapshot has chromium-headless-shell, which can't run
  // --headed; full chromium is needed for VNC-visible login.
  console.log("Installing VNC stack (xvfb + x11vnc + novnc)...");
  const apt = await sandbox.commands.run(
    "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb x11vnc novnc websockify 2>&1 | tail -3",
  );
  if (apt.exitCode !== 0) {
    console.error("apt install failed:", apt.stdout, apt.stderr);
    await sandbox.kill();
    process.exit(1);
  }

  console.log("Installing full Chromium (for headed mode)...");
  const chromium = await sandbox.commands.run(
    "cd /home/sandbox && npx --yes playwright install chromium 2>&1 | tail -5",
  );
  if (chromium.exitCode !== 0) {
    console.error("playwright install chromium failed:", chromium.stdout, chromium.stderr);
    await sandbox.kill();
    process.exit(1);
  }

  // Start Xvfb → x11vnc → websockify chain as long-lived exec sessions.
  // These outlive individual libretto commands because they're their own
  // exec.start() handles.
  console.log("Starting Xvfb, x11vnc, websockify...");
  const xvfb = await sandbox.exec.start("Xvfb", {
    args: [":99", "-screen", "0", "1280x800x24", "-ac", "+extension", "RANDR"],
    onStderr: (b) => process.stderr.write(`[xvfb] ${new TextDecoder().decode(b)}`),
  });
  await new Promise((r) => setTimeout(r, 1500)); // give Xvfb a beat to bind :99

  const x11vnc = await sandbox.exec.start("x11vnc", {
    args: ["-display", ":99", "-forever", "-shared", "-nopw", "-rfbport", "5900", "-quiet"],
    onStderr: (b) => process.stderr.write(`[x11vnc] ${new TextDecoder().decode(b)}`),
  });
  await new Promise((r) => setTimeout(r, 1000));

  const websockify = await sandbox.exec.start("websockify", {
    args: [`--web=/usr/share/novnc/`, String(VNC_PORT), "localhost:5900"],
    onStderr: (b) => process.stderr.write(`[websockify] ${new TextDecoder().decode(b)}`),
  });

  // Check persistence status — shows whether a prior login is already saved.
  const origin = new URL(otacoUrl).hostname;
  const profileProbe = await sandbox.commands.run(
    `test -d /home/sandbox/.libretto/profiles/${origin} && echo 'cached' || echo 'none'`,
  );
  console.log(`  saved profile for ${origin}: ${profileProbe.stdout.trim()}`);

  console.log("Uploading otaco-server.ts...");
  const serverSource = readFileSync("./otaco-server.ts", "utf8");
  await sandbox.files.write("/home/sandbox/otaco-server.ts", serverSource);

  console.log("Starting in-sandbox server...");
  const server = await sandbox.exec.start("sudo", {
    args: [
      "-E",
      "bash", "-c",
      "ulimit -n 65535 && cd /home/sandbox && exec npx tsx /home/sandbox/otaco-server.ts",
    ],
    cwd: "/home/sandbox",
    onStdout: (b) => process.stdout.write(`[server] ${new TextDecoder().decode(b)}`),
    onStderr: (b) => process.stderr.write(`[server!] ${new TextDecoder().decode(b)}`),
  });

  // Wait for :3000 to answer.
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const { stdout } = await sandbox.commands.run(
      `curl -sS -o /dev/null -w '%{http_code}' http://localhost:${APP_PORT}/ || echo 000`,
    );
    if (stdout.trim() === "200") { ready = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) {
    console.error("Server didn't answer on port 3000 within 60s — check [server] logs above.");
    await sandbox.kill();
    process.exit(1);
  }

  const appUrl = `https://${sandbox.getPreviewDomain(APP_PORT)}`;
  const vncUrl = `https://${sandbox.getPreviewDomain(VNC_PORT)}`;
  console.log("\n────────────────────────────────────────────");
  console.log(`  app: ${appUrl}`);
  console.log(`  vnc: ${vncUrl}`);
  console.log("────────────────────────────────────────────");
  console.log("Press Ctrl-C to shut down.\n");

  const shutdown = async () => {
    console.log("\nShutting down...");
    try { xvfb.close(); } catch { /* best effort */ }
    try { x11vnc.close(); } catch { /* best effort */ }
    try { websockify.close(); } catch { /* best effort */ }
    try { server.close(); } catch { /* best effort */ }
    try { await sandbox.kill(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => { /* block forever */ });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
