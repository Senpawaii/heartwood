import type { HeartwoodEvent } from "@heartwood/protocol";
import type { Db } from "../db.js";
import type { EventLog } from "../eventLog.js";
import { listMemories, newMemoryId, type StoredMemory } from "./store.js";

export interface Lesson {
  text: string;
  tags?: string[];
  /** Episodic memories this lesson was distilled from; they are then marked distilled. */
  sourceMemoryIds: string[];
}

/** Distils episodes into lessons (an LLM in production). Injected so the pass stays testable. */
export type Reflector = (soulId: string, episodes: StoredMemory[]) => Promise<Lesson[]>;

/**
 * One scheduled reflection pass for a soul. Episodes not covered by any returned lesson stay
 * undistilled and are offered again next pass. Scheduling itself belongs to the daemon.
 */
export async function runReflection(
  log: EventLog,
  db: Db,
  soulId: string,
  reflect: Reflector,
  opts: { minEpisodes?: number } = {},
): Promise<HeartwoodEvent[]> {
  const episodes = listMemories(db, { soulId, layers: ["episodic"], undistilled: true });
  if (episodes.length < (opts.minEpisodes ?? 1)) return [];
  const known = new Set(episodes.map((e) => e.memoryId));
  const lessons = await reflect(soulId, episodes);
  return log.append(
    lessons.map((l) => ({
      type: "memory.semantic_distilled" as const,
      payload: {
        sourceMemoryIds: l.sourceMemoryIds.filter((id) => known.has(id)),
        memory: {
          memoryId: newMemoryId(),
          layer: "semantic" as const,
          ownerSoulId: soulId,
          text: l.text,
          tags: l.tags ?? [],
          provenance: {
            author: "reflection" as const,
            source: `reflection:${new Date().toISOString().slice(0, 10)}`,
          },
        },
      },
      actor: { kind: "daemon" as const },
      correlation: { soulId },
    })),
  );
}
