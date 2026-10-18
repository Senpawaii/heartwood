import { z } from "zod";

export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

export const Species = z.enum(["dwarf", "elf", "dryad"]);
export type Species = z.infer<typeof Species>;

/** Standing organisations, one per species. */
export const MinistryKind = z.enum(["construction", "planning", "forest_healing"]);
export type MinistryKind = z.infer<typeof MinistryKind>;

/** Rank is DERIVED from level (see core `rankForLevel`). Never stored on a soul. */
export const Rank = z.enum(["apprentice", "journeyman", "executive"]);
export type Rank = z.infer<typeof Rank>;

/** Town-level offices held by souls. Orthogonal to rank. */
export const Office = z.enum(["mayor", "advisor", "warden"]);
export type Office = z.infer<typeof Office>;

export const SkillRank = z.enum(["common", "extra", "unique", "ultimate"]);
export type SkillRank = z.infer<typeof SkillRank>;

export const MemoryLayer = z.enum(["persona", "episodic", "semantic", "town"]);
export type MemoryLayer = z.infer<typeof MemoryLayer>;

export const Liveness = z.enum(["live", "unverifiable", "exited"]);
export type Liveness = z.infer<typeof Liveness>;

export const Outcome = z.enum(["succeeded", "failed"]);
export type Outcome = z.infer<typeof Outcome>;

export const DispatchOutcome = z.enum(["succeeded", "failed", "abandoned"]);
export type DispatchOutcome = z.infer<typeof DispatchOutcome>;

export const BodyAgent = z.string().min(1); // Orca agent id; Heartwood runs "omp" (Oh My Pi) by default
export type BodyAgent = z.infer<typeof BodyAgent>;

export const WarbandRole = z.enum(["foreman", "member"]);
export type WarbandRole = z.infer<typeof WarbandRole>;

export const EscalationLevel = z.enum(["foreman", "executive", "mayor", "sovereign"]);
export type EscalationLevel = z.infer<typeof EscalationLevel>;

export const PinnedSkill = z.object({ name: z.string().min(1), digest: z.string().min(1) });
export type PinnedSkill = z.infer<typeof PinnedSkill>;

/** Display-only budget. No enforcement anywhere. */
export const Magicules = z.object({
  tokens: z.number().nonnegative(),
  computeSeconds: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type Magicules = z.infer<typeof Magicules>;

export const MemoryProvenance = z.object({
  author: z.enum(["soul", "reflection", "human", "warden", "daemon"]),
  source: z.string(), // e.g. "worker_done", "reflection:2026-10-17", "markdown_edit"
  eventId: z.string().optional(),
  dispatchId: z.string().optional(),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenance>;

export const MemoryRecord = z.object({
  memoryId: Id,
  layer: MemoryLayer,
  /** null only for the shared town layer. */
  ownerSoulId: Id.nullable(),
  text: z.string().min(1),
  tags: z.array(z.string()).default([]),
  provenance: MemoryProvenance,
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;
