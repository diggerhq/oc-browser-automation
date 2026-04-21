/**
 * Launch a sandbox from the "libretto" snapshot and drive a browser session.
 *
 * Prereq: run `npx tsx build-snapshot.ts` once to create the snapshot.
 * Required env: ANTHROPIC_API_KEY (libretto snapshot is AI-driven).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx run.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Sandbox, SecretStore } from "@opencomputer/sdk/node";

const SNAPSHOT_NAME = "libretto";
const SESSION = "demo";
const URL = "https://example.com";
const SNAPSHOT_MODEL = "anthropic/claude-sonnet-4-6";
const SECRET_STORE = "libretto-demo";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY must be set — libretto snapshot uses it for page analysis");
  }

  // OC's secrets proxy refuses traffic unless the sandbox is registered, which
  // only happens when there's at least one sealed secret. Create a secret store
  // with an allow-all egress list and a dummy entry so RegisterSession fires.
  const stores = await SecretStore.list();
  let store = stores.find((s) => s.name === SECRET_STORE);
  if (!store) {
    console.log(`Creating secret store "${SECRET_STORE}" with egress *...`);
    store = await SecretStore.create({ name: SECRET_STORE, egressAllowlist: ["*"] });
  } else {
    await SecretStore.update(store.id, { egressAllowlist: ["*"] });
  }
  await SecretStore.setSecret(store.id, "LIBRETTO_DUMMY", "placeholder-to-register-proxy-session");

  console.log(`Launching sandbox from snapshot "${SNAPSHOT_NAME}"...`);
  const sandbox = await Sandbox.create({
    snapshot: SNAPSHOT_NAME,
    timeout: 300,
    envs: { ANTHROPIC_API_KEY: apiKey },
    secretStore: SECRET_STORE,
  });

  try {
    // Sanity: does the proxy accept this sandbox's source IP at all?
    console.log("Testing proxy with curl...");
    const curlTest = await sandbox.commands.run(
      "curl -sS -o /dev/null -w 'code=%{http_code} proxy=%{proxy_ssl_verify_result}\\n' https://example.com || echo curl-failed",
    );
    console.log(`  curl → ${curlTest.stdout.trim()}`);
    if (curlTest.stderr) console.error(`  curl stderr: ${curlTest.stderr.trim()}`);

    // Chromium uses an NSS DB for cert validation on Linux and ignores
    // NODE_EXTRA_CA_CERTS / SSL_CERT_FILE. Import OC's egress-proxy CA into
    // ~/.pki/nssdb so Chromium trusts the MITM-rewritten certs.
    console.log("Importing OC proxy CA into Chromium NSS store...");
    const certSetup = await sandbox.commands.run(
      [
        "mkdir -p /home/sandbox/.pki/nssdb",
        "certutil -d sql:/home/sandbox/.pki/nssdb -N --empty-password || true",
        "certutil -d sql:/home/sandbox/.pki/nssdb -A -n opensandbox-proxy -t 'TC,C,T' -i /usr/local/share/ca-certificates/opensandbox-proxy.crt",
        "certutil -d sql:/home/sandbox/.pki/nssdb -L",
      ].join(" && "),
    );
    console.log(certSetup.stdout.trim());
    if (certSetup.exitCode !== 0) console.error(certSetup.stderr);

    // VM boot doesn't populate /etc/hosts; libretto's CDP client hardcodes
    // "http://localhost:$port" so missing localhost → ENOTFOUND.
    await sandbox.commands.run(
      "grep -q 'localhost' /etc/hosts || " +
        "(printf '127.0.0.1 localhost\\n::1 localhost\\n' | sudo tee -a /etc/hosts)",
    );

    // Write libretto config so `snapshot` knows which AI model to use.
    const config = JSON.stringify({ version: 1, snapshotModel: SNAPSHOT_MODEL });
    await sandbox.commands.run(
      `mkdir -p /home/sandbox/.libretto && cat > /home/sandbox/.libretto/config.json <<'EOF'\n${config}\nEOF`,
    );

    // One persistent bash session for every libretto command. cwd, env, and any
    // backgrounded child processes (like libretto's browser worker) all share
    // this shell's process group — no setsid needed.
    console.log("Starting persistent bash session...");
    let stdoutBuf = "";
    let stderrBuf = "";
    let chunkCount = 0;
    const shell = await sandbox.exec.start("bash", {
      cwd: "/home/sandbox",
      onStdout: (b) => {
        chunkCount++;
        stdoutBuf += new TextDecoder().decode(b);
      },
      onStderr: (b) => { stderrBuf += new TextDecoder().decode(b); },
    });

    // The SDK's sendStdin silently drops writes before the WebSocket is OPEN.
    // Wait for the connection to be live by round-tripping a trivial echo.
    const waitForShell = async () => {
      for (let i = 0; i < 50; i++) {
        stdoutBuf = "";
        shell.sendStdin("echo __READY__\n");
        await new Promise((r) => setTimeout(r, 100));
        if (stdoutBuf.includes("__READY__")) return;
      }
      throw new Error("bash session never became ready (sendStdin dropped?)");
    };
    await waitForShell();
    console.log(`bash session ready (${chunkCount} stdout chunks).`);

    const runInShell = (label: string, cmd: string, timeoutMs = 120_000): Promise<number> =>
      new Promise((resolve, reject) => {
        const marker = `__OC_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
        const markerRe = new RegExp(`\\n${marker}:(-?\\d+)\\n`);
        const startedAt = Date.now();

        console.log(`[${label}] ${cmd}`);
        stdoutBuf = "";
        stderrBuf = "";
        shell.sendStdin(`${cmd}\nprintf '\\n%s:%d\\n' '${marker}' $?\n`);

        const tick = setInterval(() => {
          const m = stdoutBuf.match(markerRe);
          if (m) {
            clearInterval(tick);
            const code = parseInt(m[1], 10);
            const out = stdoutBuf.slice(0, m.index).trim();
            const err = stderrBuf.trim();
            if (out) console.log(`[${label}] ${out.replace(/\n/g, `\n[${label}] `)}`);
            if (err) console.error(`[${label}!] ${err.replace(/\n/g, `\n[${label}!] `)}`);
            console.log(`[${label}] exit=${code}`);
            resolve(code);
          } else if (Date.now() - startedAt > timeoutMs) {
            clearInterval(tick);
            reject(new Error(`[${label}] timed out after ${timeoutMs}ms`));
          }
        }, 100);
      });

    const openCode = await runInShell(
      "open",
      `npx libretto open ${URL} --session ${SESSION} --headless`,
    );

    const snapshotCode = await runInShell(
      "snapshot",
      `npx libretto snapshot --session ${SESSION} --objective 'Summarize what this page is about' --context 'Freshly loaded page, no prior interaction'`,
    );

    if (openCode !== 0 || snapshotCode !== 0) {
      const logPath = `/home/sandbox/.libretto/sessions/${SESSION}/logs.jsonl`;
      const logs = await sandbox.commands.run(`cat ${logPath} 2>/dev/null || echo "(no log file)"`);
      console.log(`--- ${logPath} ---\n${logs.stdout}\n--- end log ---`);
    }

    const librettoDir = "/home/sandbox/.libretto";
    const tree = await sandbox.commands.run(`find ${librettoDir} -type f 2>/dev/null | sort || true`);
    console.log(`--- ${librettoDir} tree ---\n${tree.stdout.trim() || "(empty)"}\n--- end tree ---`);

    const remotePaths = tree.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

    const localDir = join(process.cwd(), "artefacts");
    mkdirSync(localDir, { recursive: true });
    for (const remotePath of remotePaths) {
      const rel = remotePath.startsWith(librettoDir + "/") ? remotePath.slice(librettoDir.length + 1) : remotePath.replace(/^\/+/, "");
      const localPath = join(localDir, rel);
      mkdirSync(dirname(localPath), { recursive: true });
      const bytes = await sandbox.files.readBytes(remotePath);
      writeFileSync(localPath, bytes);
      console.log(`  pulled ${remotePath} → ${localPath} (${bytes.byteLength} bytes)`);
    }

    await runInShell("close", `npx libretto close --session ${SESSION}`, 30_000);

    shell.sendStdin("exit\n");
    await shell.done;
  } finally {
    await sandbox.kill();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
