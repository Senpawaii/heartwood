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
