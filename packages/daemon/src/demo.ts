import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBackend, openDb } from "@heartwood/core";
import { loadConfig } from "./config.js";
import { createDaemon } from "./daemon.js";
import { DemoLab, seedDemo } from "./demoData.js";
import { hasBuiltUi } from "./webUi.js";

/**
 * Heartwood with fake data, for trying the UI: an in-memory database, a fake worker backend, and a Lab
 * whose benchmarks are scripted. Nothing here touches Orca, omp, a model, or the disk. Same port,
 * token and web directory settings as the real daemon.
 */
const config = loadConfig();
const demoDelayMs = Number(process.env.HEARTWOOD_DEMO_DELAY_MS ?? 1500);
const webDir = config.webDir
  ? resolve(config.webDir)
  : fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));
const serveUi = hasBuiltUi(webDir);

const lab = new DemoLab();
const daemon = await createDaemon({
  db: openDb(),
  backend: new FakeBackend(),
  lab,
  townName: config.townName,
  token: config.token,
  // quiet unless asked: the seeding requests would otherwise fill the first screen
  logger: { level: process.env.HEARTWOOD_LOG_LEVEL ? config.logLevel : "warn" },
  webDir: serveUi ? webDir : undefined,
  demo: true,
});
await seedDemo(daemon.app, lab);
lab.delayMs = demoDelayMs; // seeding is instant; clicking is slow enough to see

await daemon.app.listen({ host: config.host, port: config.port });
daemon.app.log.warn(
  `DEMO MODE: fake data, nothing is real or saved. ${serveUi ? `Open http://${config.host}:${config.port}/` : "UI not built; run pnpm demo, or use the Vite dev server"}`,
);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await daemon.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
