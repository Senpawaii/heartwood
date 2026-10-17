import { type HeartwoodEvent, parseEvent } from "@heartwood/protocol";

/** Query-key prefixes to refresh when an event of this type arrives. */
const KEYS_BY_PREFIX: Record<string, readonly string[]> = {
  town: ["town", "ministries"],
  soul: ["town", "souls", "soul"],
  body: ["souls", "soul", "warband"],
  warband: ["town", "warbands", "warband", "souls", "soul"],
  dispatch: ["warband", "warbands", "souls", "soul", "skillUsage", "proficiency"],
  backend: ["health", "warband"],
  escalation: ["town", "inbox"],
  question: ["town", "inbox"],
  memory: ["memory", "soul"],
  skill: ["skillUsage", "skillRanks", "soul", "proficiency"],
};

/** Which query keys an event invalidates. Unknown event families refresh nothing. */
export function queryKeysFor(type: string): readonly string[] {
  const prefix = type.split(".")[0] ?? "";
  // settling a dispatch grants XP and records usage, so refresh the town and inbox too
  const extra = type === "dispatch.settled" ? ["town"] : [];
  return [...(KEYS_BY_PREFIX[prefix] ?? []), ...extra];
}

/** Parse one SSE `data:` payload; undefined for events this UI version does not know. */
export function parseLiveEvent(data: string): HeartwoodEvent | undefined {
  try {
    return parseEvent(JSON.parse(data));
  } catch {
    return undefined;
  }
}

/** One-line, human description of an event for the live feed. `nameOf` resolves soul ids to names. */
export function describeEvent(
  e: HeartwoodEvent,
  nameOf: (soulId: string) => string = (id) => id,
): string {
  const who = e.correlation.soulId ? nameOf(e.correlation.soulId) : undefined;
  switch (e.type) {
    case "soul.named":
      return `${e.payload.name} the ${e.payload.species} was named`;
    case "soul.xp_gained":
      return `${nameOf(e.payload.soulId)} +${e.payload.amount} xp (${e.payload.reason.replace("_", " ")})`;
    case "soul.leveled":
      return `${nameOf(e.payload.soulId)} reached level ${e.payload.toLevel}`;
    case "soul.ranked":
      return `${nameOf(e.payload.soulId)} is now a ${e.payload.rank}`;
    case "soul.evolved":
      return `${nameOf(e.payload.soulId)} evolved into a ${e.payload.toForm}`;
    case "soul.awakened":
      return `${nameOf(e.payload.soulId)} awakened: ${e.payload.title}`;
    case "town.ministry_created":
      return `ministry founded: ${e.payload.name}`;
    case "warband.formed":
      return `warband formed: ${e.payload.objective}`;
    case "warband.disbanded":
      return `warband disbanded: ${e.payload.reason}`;
    case "dispatch.created":
      return who ? `task prepared for ${who}` : "task prepared";
    case "dispatch.started":
      return who ? `${who}'s body started working` : "worker started";
    case "dispatch.settled":
      return `${who ?? "task"} ${e.payload.outcome}${e.payload.summary ? `: ${e.payload.summary}` : ""}`;
    case "body.spawned":
      return who ? `a body was spawned for ${who}` : "a body was spawned";
    case "body.released":
      return "body released";
    case "body.retained":
      return "body retained";
    case "skill.absorbed":
      return `${nameOf(e.payload.soulId)} absorbed ${e.payload.skill.name}`;
    case "skill.used":
      return `${nameOf(e.payload.soulId)} used ${e.payload.skill.name}: ${e.payload.outcome} (${e.payload.evidence})`;
    case "skill.analyzed":
      return `${e.payload.skill.name} benchmarked at ${e.payload.score.toFixed(2)}`;
    case "skill.ranked":
      return `${e.payload.skill.name} ranked ${e.payload.rank}`;
    case "memory.episodic_written":
    case "memory.semantic_distilled":
    case "memory.persona_set":
      return `${who ?? "someone"} remembers: ${e.payload.memory.text.slice(0, 80)}`;
    case "question.asked":
      return `question: ${e.payload.text}`;
    case "escalation.raised":
      return `escalation: ${e.payload.reason}`;
    case "backend.mailbox_batch":
      return `${e.payload.messageIds.length} message(s) from the backend`;
    case "backend.worker_done":
      return `worker reported ${e.payload.outcome}`;
    case "backend.group_created":
      return `${e.payload.backend} group created`;
    case "backend.incompatible":
      return e.payload.problems.join("; ");
    default:
      return "";
  }
}
