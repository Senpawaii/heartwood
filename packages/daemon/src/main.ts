import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirSource, ResultStore } from "@grimoire/core";
import { openDb, SqliteKv } from "@heartwood/core";
import { GrimoireLab, OrcaBackend, SkillStore } from "@heartwood/integrations";
import { loadConfig } from "./config.js";
import { createDaemon } from "./daemon.js";

const config = loadConfig();
const dataDir = resolve(config.dataDir);
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "heartwood.db"));

mkdirSync(join(dataDir, "grimoire"), { recursive: true });
const results = new ResultStore(join(dataDir, "grimoire", "results.db"));
// Catalog reads, pinning and rendering work as is. Benchmarks need an AgentAdapter and version proposals
// need a rewriter; neither is configured here, so those operations answer 501 instead of faking results.
const lab = new GrimoireLab({
  sources: config.lab.skillDirs.map((d) => dirSource(resolve(d))),
  store: new SkillStore(join(dataDir, "skills")),
  results,
  outDir: join(dataDir, "grimoire", "runs"),
});

const daemon = await createDaemon({
  db,
  townName: config.townName,
  token: config.token,
  logger: { level: config.logLevel },
  backend: new OrcaBackend({
    bin: config.orca.bin,
    coordinatorWorktree: config.orca.coordinatorWorktree,
    pollTimeoutMs: config.orca.pollTimeoutMs,
    identity: new SqliteKv(db, "orca"),
  }),
  lab,
  coordinator: { maxConcurrentGroups: config.maxConcurrentGroups },
});

if (
  !config.token &&
  config.host !== "127.0.0.1" &&
  config.host !== "localhost" &&
  config.host !== "::1"
)
  daemon.app.log.warn("listening on a non-loopback address without HEARTWOOD_TOKEN");

await daemon.app.listen({ host: config.host, port: config.port });

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  daemon.app.log.info({ signal }, "shutting down");
  await daemon.close();
  await lab.close();
  results.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
