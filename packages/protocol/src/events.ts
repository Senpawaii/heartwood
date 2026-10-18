import { z } from "zod";
import {
  BodyAgent,
  DispatchOutcome,
  EscalationLevel,
  Id,
  Liveness,
  Magicules,
  MemoryRecord,
  MinistryKind,
  Outcome,
  PinnedSkill,
  Rank,
  SkillRank,
  Species,
  WarbandRole,
} from "./domain.js";

const strings = z.array(z.string());
const ActorRef = z.object({ kind: z.string(), id: z.string().optional() });
const ProofRef = z.object({ kind: z.enum(["benchmark", "project"]), ref: z.string() });

/**
 * Payload schema per event type. The registry is the single source of truth:
 * `EventType`, payload types and runtime validation all derive from it.
 *
 * Heartbeats are intentionally NOT events: the gateway drops them at translation and keeps
 * only the last heartbeat time in a projection.
 *
 * Events originating from one Orca mailbox message carry `messageId`; the log enforces
 * uniqueness per (type, messageId) so replayed batches are idempotent.
 */
export const payloadSchemas = {
  // town
  "town.founded": z.object({ name: z.string() }),
  "town.ministry_created": z.object({ ministryId: Id, name: z.string(), kind: MinistryKind }),
  "town.budget_snapshot": z.object({
    scope: z.enum(["town", "soul"]),
    soulId: Id.optional(),
    magicules: Magicules,
  }),
  "town.config_changed": z.object({ key: z.string(), value: z.unknown() }),

  // soul
  "soul.named": z.object({
    soulId: Id,
    name: z.string().min(1),
    species: Species,
    ministryId: Id,
    persona: z.string(),
    magiculesSpent: z.number().nonnegative(),
  }),
  "soul.xp_gained": z.object({
    soulId: Id,
    amount: z.number().int().positive(),
    reason: z.enum(["task", "foreman_bonus", "mentoring", "other"]),
    dispatchId: Id.optional(),
  }),
  "soul.leveled": z.object({
    soulId: Id,
    fromLevel: z.number().int(),
    toLevel: z.number().int(),
    xp: z.number().int(),
  }),
  /** Notification only: emitted when a level change crosses a rank threshold. Not state. */
  "soul.ranked": z.object({ soulId: Id, previousRank: Rank, rank: Rank }),
  "soul.evolved": z.object({ soulId: Id, fromForm: z.string(), toForm: z.string() }),
  "soul.awakened": z.object({ soulId: Id, title: z.string(), proof: ProofRef }),
  "soul.mentor_assigned": z.object({ soulId: Id, mentorId: Id }),
  "soul.office_assigned": z.object({ soulId: Id, office: z.enum(["mayor", "advisor", "warden"]) }),
  "soul.retired": z.object({ soulId: Id, reason: z.string() }),
  "soul.reincarnated": z.object({ soulId: Id, fromBodyId: Id, toBodyId: Id }),
  "soul.resurrected": z.object({
    soulId: Id,
    failedBodyId: Id,
    newBodyId: Id,
    episodeMemoryIds: strings,
  }),

  // body
  "body.spawned": z.object({
    bodyId: Id,
    soulId: Id,
    dispatchId: Id,
    workerRef: z.string(),
    workerLocator: z.string().optional(),
    agent: BodyAgent,
    model: z.string().optional(),
    worktree: z.string(),
  }),
  "body.liveness_changed": z.object({
    bodyId: Id,
    from: Liveness.optional(),
    to: Liveness,
  }),
  "body.released": z.object({ bodyId: Id }),
  "body.retained": z.object({ bodyId: Id, reason: z.string().optional() }),
  "body.reused": z.object({ bodyId: Id, dispatchId: Id }),

  // warband
  "warband.formed": z.object({
    warbandId: Id,
    objective: z.string(),
    foremanSoulId: Id,
    members: z.array(z.object({ soulId: Id, role: WarbandRole })),
  }),
  "warband.member_assigned": z.object({ warbandId: Id, soulId: Id, role: WarbandRole }),
  "warband.disbanded": z.object({ warbandId: Id, reason: z.string() }),

  // dispatch
  "dispatch.created": z.object({
    dispatchId: Id,
    warbandId: Id,
    soulId: Id,
    specHash: z.string(),
    memoryIds: strings,
    skills: z.array(PinnedSkill),
    taskRef: z.string().optional(),
  }),
  "dispatch.started": z.object({ dispatchId: Id, bodyId: Id }),
  "dispatch.settled": z.object({
    dispatchId: Id,
    outcome: DispatchOutcome,
    summary: z.string().optional(),
  }),

  // escalation / questions
  "escalation.raised": z.object({
    escalationId: Id,
    dispatchId: Id.optional(),
    from: ActorRef,
    level: EscalationLevel,
    reason: z.string(),
    messageId: z.string().optional(),
  }),
  "escalation.resolved": z.object({ escalationId: Id, resolution: z.string() }),
  "question.asked": z.object({
    questionId: Id,
    dispatchId: Id.optional(),
    text: z.string(),
    messageId: z.string().optional(),
  }),
  "question.answered": z.object({ questionId: Id, answer: z.string() }),

  // orca lifecycle
  "backend.group_created": z.object({
    warbandId: Id,
    /** Which backend adapter owns this group (e.g. "orca"). */
    backend: z.string(),
    /** Opaque backend id of the worker group (Orca: Run). */
    groupRef: z.string(),
    objective: z.string(),
  }),
  "backend.task_created": z.object({ groupRef: z.string(), taskRef: z.string(), deps: strings }),
  "backend.mailbox_batch": z.object({
    groupRef: z.string(),
    messageIds: strings,
    heartbeatsDropped: z.number().int().nonnegative(),
    /** First message id of the batch; makes a replayed batch idempotent. */
    messageId: z.string().optional(),
  }),
  "backend.worker_done": z.object({
    groupRef: z.string(),
    messageId: z.string(),
    /** Opaque backend id of the worker (Orca: Dispatch id `ctx_…`). */
    workerRef: z.string(),
    outcome: Outcome,
    summary: z.string().optional(),
  }),
  /** The backend refused a lifecycle message (e.g. stale or unknown worker). It settles nothing. */
  "backend.message_rejected": z.object({
    groupRef: z.string(),
    messageId: z.string(),
    /** The backend's own message type, kept for diagnosis. */
    messageType: z.string(),
    code: z.string(),
    reason: z.string().optional(),
  }),
  "backend.unknown_message": z.object({
    groupRef: z.string(),
    messageId: z.string(),
    messageType: z.string(),
  }),
  "backend.poll_failed": z.object({
    groupRef: z.string(),
    consecutiveFailures: z.number().int().positive(),
    error: z.string(),
  }),
  "backend.incompatible": z.object({
    backend: z.string(),
    version: z.string().optional(),
    problems: strings,
  }),

  // memory
  "memory.persona_set": z.object({ memory: MemoryRecord }),
  "memory.episodic_written": z.object({ memory: MemoryRecord }),
  "memory.semantic_distilled": z.object({ memory: MemoryRecord, sourceMemoryIds: strings }),
  "memory.shared_promoted": z.object({ memory: MemoryRecord, fromMemoryId: Id }),
  "memory.edited": z.object({ memoryId: Id, text: z.string().min(1) }),
  "memory.pruned": z.object({ memoryId: Id, reason: z.string() }),
  "memory.injected": z.object({
    dispatchId: Id,
    soulId: Id,
    items: z.array(z.object({ memoryId: Id, score: z.number() })),
  }),

  // skills
  "skill.absorbed": z.object({ soulId: Id, skill: PinnedSkill, source: z.string() }),
  "skill.forgotten": z.object({ soulId: Id, name: z.string() }),
  "skill.analyzed": z.object({
    skill: PinnedSkill,
    resultRef: z.string(),
    /** Pass rate over all trials. */
    score: z.number(),
    trials: z.number().int().nonnegative(),
    /** Trials that could not measure the skill (infra errors). */
    errors: z.number().int().nonnegative(),
    /** False when the sample was too small or too error-ridden to rank; the rank is then left unchanged. */
    conclusive: z.boolean(),
    suiteDigest: z.string().optional(),
    agent: z.string().optional(),
  }),
  "skill.ranked": z.object({
    skill: PinnedSkill,
    rank: SkillRank,
    score: z.number(),
    thresholdsVersion: z.string(),
    /** Suite the rank was measured on. Absent in events from before ranks were keyed by suite. */
    suiteDigest: z.string().optional(),
    /** Agent, version and model (with effort) the rank was measured with. Absent in older events. */
    agent: z.string().optional(),
  }),
  "skill.evolve_proposed": z.object({
    name: z.string(),
    from: PinnedSkill,
    to: PinnedSkill,
    changelog: z.string(),
  }),
  "skill.evolve_promoted": z.object({
    name: z.string(),
    from: PinnedSkill,
    to: PinnedSkill,
    comparisonRef: z.string(),
  }),
  "skill.evolve_rejected": z.object({
    name: z.string(),
    from: PinnedSkill,
    to: PinnedSkill,
    reason: z.string(),
  }),
  /**
   * `evidence: "injected"` = skill was in the task spec and the dispatch settled (may overcount;
   * the UI labels it so). `"loaded"` is reserved for transcript-verified use.
   */
  "skill.used": z.object({
    soulId: Id,
    skill: PinnedSkill,
    dispatchId: Id,
    outcome: z.enum(["succeeded", "failed", "unknown"]),
    evidence: z.enum(["injected", "loaded"]),
  }),
} as const;

export type EventPayloadSchemas = typeof payloadSchemas;
export type EventType = keyof EventPayloadSchemas;
export const eventTypes = Object.keys(payloadSchemas) as EventType[];
export type EventPayloads = { [K in EventType]: z.infer<EventPayloadSchemas[K]> };

export const Actor = z.object({
  kind: z.enum(["sovereign", "mayor", "soul", "foreman", "daemon", "warden", "backend"]),
  id: z.string().optional(),
});
export type Actor = z.infer<typeof Actor>;

export const Correlation = z.object({
  warbandId: z.string().optional(),
  groupRef: z.string().optional(),
  taskId: z.string().optional(),
  dispatchId: z.string().optional(),
  soulId: z.string().optional(),
});
export type Correlation = z.infer<typeof Correlation>;

const EnvelopeFields = z.object({
  seq: z.number().int().positive(),
  id: z.string().min(1),
  at: z.iso.datetime(),
  v: z.literal(1),
  actor: Actor,
  correlation: Correlation,
  causedBy: z.string().optional(),
});
export type EnvelopeFields = z.infer<typeof EnvelopeFields>;

export type HeartwoodEvent<T extends EventType = EventType> = T extends EventType
  ? EnvelopeFields & { type: T; payload: EventPayloads[T] }
  : never;

/** What a producer supplies; the log assigns `seq`, `id` and `at`. */
export type NewEvent<T extends EventType = EventType> = T extends EventType
  ? {
      type: T;
      payload: EventPayloads[T];
      actor: Actor;
      correlation?: Correlation;
      causedBy?: string;
    }
  : never;

export class EventValidationError extends Error {}

/** Validate a producer-supplied event; returns it with the parsed payload. */
export function validateNewEvent<T extends EventType>(e: NewEvent<T>): NewEvent<T> {
  const schema = payloadSchemas[e.type];
  if (!schema) throw new EventValidationError(`unknown event type: ${e.type}`);
  const r = schema.safeParse(e.payload);
  if (!r.success) throw new EventValidationError(`${e.type}: ${r.error.message}`);
  Actor.parse(e.actor);
  return { ...e, payload: r.data } as NewEvent<T>;
}

/** Parse a stored/transmitted event. Throws on unknown type or invalid payload. */
export function parseEvent(raw: unknown): HeartwoodEvent {
  const env = EnvelopeFields.extend({ type: z.string(), payload: z.unknown() }).parse(raw);
  const schema = payloadSchemas[env.type as EventType];
  if (!schema) throw new EventValidationError(`unknown event type: ${env.type}`);
  const payload = schema.parse(env.payload);
  return { ...env, payload } as HeartwoodEvent;
}
