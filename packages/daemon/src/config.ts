import { delimiter } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  dataDir: z.string().default(".heartwood"),
  townName: z.string().default("Heartwood"),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(0).max(65535).default(7777),
  /** Bearer token required on every request except /health. Strongly recommended off loopback. */
  token: z.string().min(16).optional(),
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
    token: env.HEARTWOOD_TOKEN,
    maxConcurrentGroups: env.HEARTWOOD_MAX_GROUPS,
    logLevel: env.HEARTWOOD_LOG_LEVEL,
    lab: { skillDirs: env.HEARTWOOD_SKILL_DIRS },
    orca: {
      bin: env.HEARTWOOD_ORCA_BIN,
      coordinatorWorktree: env.HEARTWOOD_ORCA_COORDINATOR_WORKTREE,
      pollTimeoutMs: env.HEARTWOOD_ORCA_POLL_TIMEOUT_MS,
    },
  });
}
