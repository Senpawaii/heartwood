import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentAdapter, dirSource, ResultStore } from "@grimoire/core";
import { openDb, SqliteKv } from "@heartwood/core";
import { createOmpRewriter, GrimoireLab, OrcaBackend, SkillStore } from "@heartwood/integrations";
import { BenchAgentError, loadBenchAgent } from "./benchAgent.js";
import { loadConfig } from "./config.js";
import { createDaemon } from "./daemon.js";
import { hasBuiltUi } from "./webUi.js";

const config = loadConfig();
const dataDir = resolve(config.dataDir);
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "heartwood.db"));

mkdirSync(join(dataDir, "grimoire"), { recursive: true });
const results = new ResultStore(join(dataDir, "grimoire", "results.db"));
// Catalog reads, pinning and rendering always work. Benchmarks run only when HEARTWOOD_BENCH_AGENT names an
// agent (a misconfiguration stops the daemon here, loudly); version proposals also need a rewriter, which is
// only configured with HEARTWOOD_REWRITER=omp, otherwise those answer 501 instead of faking results.
let agent: AgentAdapter | undefined;
try {
  agent = await loadBenchAgent(config.bench.agent);
} catch (err) {
  if (!(err instanceof BenchAgentError)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
const lab = new GrimoireLab({
  agent,
  model: config.bench.model,
  rewriterModel: config.rewriter.model,
  repeat: config.bench.repeat,
  rewriter:
    config.rewriter.agent === "omp"
      ? ({ model }) => createOmpRewriter({ model, timeoutMs: config.rewriter.timeoutMs })
      : undefined,
  sources: config.lab.skillDirs.map((d) => dirSource(resolve(d))),
  store: new SkillStore(join(dataDir, "skills")),
  results,
  outDir: join(dataDir, "grimoire", "runs"),
  onSourceProblem: (p) =>
    process.stderr.write(
      `${JSON.stringify({ level: "warn", msg: "skill source problem", ...p })}\n`,
    ),
});

const webDir = config.webDir
  ? resolve(config.webDir)
  : fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));
const serveUi = hasBuiltUi(webDir);

const daemon = await createDaemon({
  webDir: serveUi ? webDir : undefined,
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
  defaultAgent: config.defaultAgent,
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
if (serveUi)
  daemon.app.log.info(`web UI: http://${config.host}:${config.port}/ (serving ${webDir})`);
else
  daemon.app.log.warn(
    `web UI not built (no index.html in ${webDir}); run pnpm start, or pnpm build`,
  );

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
