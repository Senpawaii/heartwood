import { z } from "zod";
import { Magicules, MemoryProvenance, Species } from "./domain.js";

/**
 * Response shapes of the daemon's HTTP API, shared by the daemon (contract tests), the web UI
 * (runtime validation at the boundary) and any other client. Optional fields may be absent.
 */

export const Ministry = z.object({ ministryId: z.string(), name: z.string(), kind: z.string() });
export type Ministry = z.infer<typeof Ministry>;

export const Soul = z.object({
  soulId: z.string(),
  name: z.string(),
  species: Species,
  /** Current form; changes on evolution. */
  form: z.string(),
  ministryId: z.string(),
  xp: z.number(),
  level: z.number(),
  /** Derived from level; never stored. */
  rank: z.enum(["apprentice", "journeyman", "executive"]),
  office: z.string().nullable(),
  mentorId: z.string().nullable(),
  status: z.string(),
  currentBodyId: z.string().nullable(),
  titles: z.array(z.string()),
  /** What naming this soul cost (display only). */
  magiculesSpent: z.number(),
});
export type Soul = z.infer<typeof Soul>;

export const SoulSkill = z.object({
  name: z.string(),
  digest: z.string(),
  source: z.string(),
  rank: z.string().nullable(),
  proficiency: z.number().nullable(),
});
export type SoulSkill = z.infer<typeof SoulSkill>;

export const SkillUsageStat = z.object({
  skill: z.string(),
  uses: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  unknown: z.number(),
  successRate: z.number().nullable(),
  /** Uses counted from "injected and settled" only, not verified by transcript; label them as such. */
  injectedOnly: z.number(),
});
export type SkillUsageStat = z.infer<typeof SkillUsageStat>;

export const ProficiencyPoint = z.object({ at: z.string(), uses: z.number(), score: z.number() });
export type ProficiencyPoint = z.infer<typeof ProficiencyPoint>;

export const SkillRankRow = z.object({
  name: z.string(),
  digest: z.string(),
  /** Suite the rank was measured on; empty for ranks recorded before this was tracked. */
  suiteDigest: z.string(),
  /** `id@version model:effort` the rank was measured with; empty for older ranks. */
  agent: z.string(),
  rank: z.string(),
  score: z.number(),
  thresholdsVersion: z.string(),
});
export type SkillRankRow = z.infer<typeof SkillRankRow>;

/** One skill the Lab offers. `digest` is its identity; name, version and source are labels. */
export const SkillRef = z.object({
  name: z.string(),
  digest: z.string(),
  description: z.string(),
  version: z.string().optional(),
  source: z.string(),
});
export type SkillRef = z.infer<typeof SkillRef>;

export const SourceProblem = z.object({
  source: z.string(),
  operation: z.enum(["list", "load"]),
  message: z.string(),
});
export type SourceProblem = z.infer<typeof SourceProblem>;

/** `problems` lists catalog sources that are down; `skills` is built from the others. */
export const SkillCatalogResponse = z.object({
  skills: z.array(SkillRef),
  problems: z.array(SourceProblem),
});

/**
 * A model chosen for one action. Plain provider/model syntax with an optional `:level` effort suffix
 * (`anthropic/claude-sonnet-5-5:high`); it ends up in an agent's argv, so no spaces or shell syntax.
 */
export const ModelSelector = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/@+:-]*$/,
    "a model id such as provider/model or provider/model:high",
  );

/** Benchmark one pinned skill. `model` is what it is measured with; unset means the server's setting. */
export const AnalyzeRequest = z.object({
  name: z.string().min(1),
  digest: z.string().min(1),
  model: ModelSelector.optional(),
});
export type AnalyzeRequest = z.infer<typeof AnalyzeRequest>;

/** Propose a new version. `model` measures both versions; `rewriterModel` writes the candidate. */
export const EvolveRequest = AnalyzeRequest.extend({ rewriterModel: ModelSelector.optional() });
export type EvolveRequest = z.infer<typeof EvolveRequest>;

/** Result of benchmarking a skill. `rank` is null when the run was inconclusive. */
export const AnalyzeResponse = z.object({
  evidence: z.object({
    trials: z.number(),
    passes: z.number(),
    errors: z.number(),
    passRate: z.number(),
    agent: z.object({
      id: z.string(),
      version: z.string().optional(),
      model: z.string().optional(),
    }),
    vsBaseline: z.object({ delta: z.number() }).optional(),
  }),
  rank: z.string().nullable(),
});

export type AnalyzeResponse = z.infer<typeof AnalyzeResponse>;

/** Result of proposing a new version. A refused proposal still answers 200 with `promoted: false`. */
export const EvolveResponse = z.object({
  promoted: z.boolean(),
  candidate: z.object({ name: z.string(), digest: z.string() }),
  comparison: z.object({
    delta: z.number(),
    verdict: z.enum(["better", "same", "worse"]),
    significant: z.boolean(),
    ci: z.object({ lower: z.number(), upper: z.number() }).optional(),
  }),
});
export type EvolveResponse = z.infer<typeof EvolveResponse>;

export const Warband = z.object({
  warbandId: z.string(),
  objective: z.string(),
  foremanSoulId: z.string(),
  groupRef: z.string().nullable(),
  status: z.string(),
  members: z.array(z.object({ soulId: z.string(), role: z.string() })),
});
export type Warband = z.infer<typeof Warband>;

export const DispatchRow = z.object({
  dispatchId: z.string(),
  soulId: z.string(),
  state: z.enum(["created", "running", "settled"]),
  outcome: z.string().nullable(),
});
export type DispatchRow = z.infer<typeof DispatchRow>;

export const MemoryItem = z.object({
  memoryId: z.string(),
  layer: z.enum(["persona", "episodic", "semantic", "town"]),
  ownerSoulId: z.string().nullable(),
  text: z.string(),
  tags: z.array(z.string()),
  provenance: MemoryProvenance,
  createdAt: z.string(),
  prunedAt: z.string().nullable(),
  distilledAt: z.string().nullable(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

export const BackendState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("starting") }),
  z.object({
    status: z.literal("ready"),
    info: z.object({ name: z.string(), version: z.string().optional() }),
  }),
  z.object({
    status: z.literal("degraded"),
    info: z.object({ name: z.string(), version: z.string().optional() }).optional(),
    problems: z.array(z.string()),
  }),
]);
export type BackendState = z.infer<typeof BackendState>;

export const Health = z.object({
  ok: z.boolean(),
  backend: BackendState,
  lastSeq: z.number(),
  watching: z.array(z.string()),
  /** Present and true only when the daemon runs on fake data. */
  demo: z.boolean().optional(),
});
export type Health = z.infer<typeof Health>;

export const OpenQuestion = z.object({
  questionId: z.string(),
  text: z.string(),
  dispatchId: z.string().nullable(),
  soulId: z.string().nullable(),
  at: z.string(),
});
export const OpenEscalation = z.object({
  escalationId: z.string(),
  level: z.string(),
  reason: z.string(),
  dispatchId: z.string().nullable(),
  soulId: z.string().nullable(),
  at: z.string(),
});
export const Inbox = z.object({
  questions: z.array(OpenQuestion),
  escalations: z.array(OpenEscalation),
});
export type Inbox = z.infer<typeof Inbox>;

export const TownSummary = z.object({
  name: z.string(),
  /** Latest town-wide budget snapshot, if any has been recorded. Display only; nothing enforces it. */
  budget: Magicules.nullable(),
  /** Sum of what naming souls cost. */
  magiculesSpent: z.number(),
  counts: z.object({
    souls: z.number(),
    ministries: z.number(),
    warbands: z.number(),
    activeWarbands: z.number(),
    openQuestions: z.number(),
    openEscalations: z.number(),
  }),
});
export type TownSummary = z.infer<typeof TownSummary>;

// Envelopes
export const MinistriesResponse = z.object({ ministries: z.array(Ministry) });
export const SoulsResponse = z.object({ souls: z.array(Soul) });
export const SoulDetail = z.object({
  soul: Soul,
  skills: z.array(SoulSkill),
  skillUsage: z.array(SkillUsageStat),
});
export const SoulMemoryResponse = z.object({
  persona: z.string().optional(),
  memories: z.array(MemoryItem),
});
export const ProficiencyResponse = z.object({ series: z.array(ProficiencyPoint) });
export const SkillUsageResponse = z.object({ usage: z.array(SkillUsageStat) });
export const SkillRanksResponse = z.object({ ranks: z.array(SkillRankRow) });
export const WarbandsResponse = z.object({ warbands: z.array(Warband) });
export const WarbandDetail = z.object({ warband: Warband, dispatches: z.array(DispatchRow) });
