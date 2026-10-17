import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb, SqliteKv, UnavailableLab } from "@heartwood/core";
import { OrcaBackend } from "@heartwood/integrations";
import { loadConfig } from "./config.js";
import { createDaemon } from "./daemon.js";

const config = loadConfig();
const dataDir = resolve(config.dataDir);
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "heartwood.db"));

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
  // Until the grimoire-lab adapter exists, Lab operations fail loudly instead of being stubbed.
  lab: new UnavailableLab("grimoire-lab adapter is not implemented yet"),
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
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
