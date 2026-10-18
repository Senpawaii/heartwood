import { delimiter } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  dataDir: z.string().default(".heartwood"),
  townName: z.string().default("Heartwood"),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(0).max(65535).default(7777),
  /** Built web UI to serve at /ui/. Default: apps/web/dist of this repository, when it has been built. */
  webDir: z.string().optional(),
  /** Bearer token required on every request except /health. Strongly recommended off loopback. */
  token: z.string().min(16).optional(),
  /** Agent for dispatches that do not name one. */
  defaultAgent: z.string().min(1).default("omp"),
  maxConcurrentGroups: z.coerce.number().int().positive().default(4),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  lab: z
    .object({
      /** Catalog directories of skill folders, searched in order. */
      skillDirs: z
        .string()
        .optional()
        .transform((s) => (s ? s.split(delimiter).filter(Boolean) : ["grimoire/skills"])),
    })
    .default({ skillDirs: ["grimoire/skills"] }),
  /** Benchmarks (analyze, evolve). Off unless an agent is named; see `loadBenchAgent`. */
  bench: z
    .object({
      /** Agent to benchmark with. Heartwood runs omp only, never `claude` directly. */
      agent: z.enum(["omp"]).optional(),
      /** Model selector passed to the agent. For omp, a `:level` suffix sets the effort (`anthropic/claude-sonnet-5-5:low`). */
      model: z.string().min(1).optional(),
      /** Trials per task and arm. Default: the suite's own. */
      repeat: z.coerce.number().int().positive().optional(),
    })
    .default({}),
  /** Proposes new skill versions (evolve). `omp` runs one headless omp per proposal. Off by default. */
  rewriter: z
    .object({
      agent: z.enum(["omp"]).optional(),
      /** Model id, with an optional `:level` effort suffix. Default: omp's own. */
      model: z.string().min(1).optional(),
      timeoutMs: z.coerce.number().int().positive().optional(),
    })
    .default({}),
  orca: z
    .object({
      bin: z.string().optional(),
      coordinatorWorktree: z.string().optional(),
      pollTimeoutMs: z.coerce.number().int().positive().optional(),
    })
    .default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Read configuration from `HEARTWOOD_*` environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    dataDir: env.HEARTWOOD_DATA_DIR,
    townName: env.HEARTWOOD_TOWN_NAME,
    host: env.HEARTWOOD_HOST,
    port: env.HEARTWOOD_PORT,
    webDir: env.HEARTWOOD_WEB_DIR,
    token: env.HEARTWOOD_TOKEN,
    defaultAgent: env.HEARTWOOD_DEFAULT_AGENT,
    maxConcurrentGroups: env.HEARTWOOD_MAX_GROUPS,
    logLevel: env.HEARTWOOD_LOG_LEVEL,
    lab: { skillDirs: env.HEARTWOOD_SKILL_DIRS },
    bench: {
      agent: env.HEARTWOOD_BENCH_AGENT,
      model: env.HEARTWOOD_BENCH_MODEL,
      repeat: env.HEARTWOOD_BENCH_REPEAT,
    },
    rewriter: {
      agent: env.HEARTWOOD_REWRITER,
      model: env.HEARTWOOD_REWRITER_MODEL,
      timeoutMs: env.HEARTWOOD_REWRITER_TIMEOUT_MS,
    },
    orca: {
      bin: env.HEARTWOOD_ORCA_BIN,
      coordinatorWorktree: env.HEARTWOOD_ORCA_COORDINATOR_WORKTREE,
      pollTimeoutMs: env.HEARTWOOD_ORCA_POLL_TIMEOUT_MS,
    },
  });
}
