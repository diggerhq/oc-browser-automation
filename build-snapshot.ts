/**
 * Build the "libretto" OC snapshot — one-time.
 *
 * Installs Playwright's bundled Chromium + libretto + @ai-sdk/anthropic into
 * /home/sandbox. Subsequent sandboxes launched from this snapshot boot ready
 * to run `libretto open`.
 *
 * Usage:
 *   npx tsx build-snapshot.ts
 */

import { Image, Snapshots } from "@opencomputer/sdk/node";

export const SNAPSHOT_NAME = "libretto-app";
const SNAPSHOT_MODEL = "anthropic/claude-sonnet-4-6";

// Runtime libraries Playwright's Chromium links against at launch.
// List matches Playwright's Ubuntu 22.04 deps for chromium.
const CHROMIUM_RUNTIME_DEPS = [
  "libnss3",
  "libnspr4",
  "libatk1.0-0",
  "libatk-bridge2.0-0",
  "libcups2",
  "libdrm2",
  "libxkbcommon0",
  "libxcomposite1",
  "libxdamage1",
  "libxfixes3",
  "libxrandr2",
  "libxext6",
  "libgbm1",
  "libpango-1.0-0",
  "libcairo2",
  "libasound2",
  "fonts-liberation",
  // `certutil` — needed at runtime to import OC's egress-proxy CA into
  // Chromium's NSS database (Chromium ignores SSL_CERT_FILE / NODE_EXTRA_CA_CERTS).
  "libnss3-tools",
];

async function main() {
  const snapshots = new Snapshots();

  const librettoConfig = JSON.stringify({ version: 1, snapshotModel: SNAPSHOT_MODEL });

  const image = Image.base()
    .aptInstall(CHROMIUM_RUNTIME_DEPS)
    .workdir("/home/sandbox")
    .runCommands(
      "cd /home/sandbox && npm init -y >/dev/null",
      // libretto + its AI adapter + the in-sandbox Hono app runtime.
      "cd /home/sandbox && npm install --no-audit --no-fund libretto @ai-sdk/anthropic hono @hono/node-server tsx",
      // Libretto drives Playwright, which needs its own bundled Chromium shell.
      "cd /home/sandbox && npx --yes playwright install chromium-headless-shell",
      // Bake libretto's AI config so the sandbox is ready to snapshot out of the box.
      "mkdir -p /home/sandbox/.libretto",
    )
    .addFile("/home/sandbox/.libretto/config.json", librettoConfig);

  try {
    await snapshots.delete(SNAPSHOT_NAME);
    console.log(`Deleted existing snapshot "${SNAPSHOT_NAME}".`);
  } catch {
    // No prior snapshot; fine.
  }

  console.log(`Building snapshot "${SNAPSHOT_NAME}"...`);
  const info = await snapshots.create({
    name: SNAPSHOT_NAME,
    image,
    onBuildLogs: (line) => process.stdout.write(`  build: ${line}`),
  });
  console.log(`\nSnapshot ready: ${info.name} (status=${info.status})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
