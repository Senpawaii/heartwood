import type { MemoryLayer, MemoryRecord, NewEvent } from "@heartwood/protocol";
import { ulid } from "ulid";
import type { Db } from "../db.js";

export interface StoredMemory extends MemoryRecord {
  createdAt: string;
  prunedAt: string | null;
  distilledAt: string | null;
}

interface Row {
  memory_id: string;
  layer: MemoryLayer;
  owner_soul_id: string | null;
  text: string;
  tags: string;
  provenance: string;
  created_at: string;
  pruned_at: string | null;
  distilled_at: string | null;
}

const toMemory = (r: Row): StoredMemory => ({
  memoryId: r.memory_id,
  layer: r.layer,
  ownerSoulId: r.owner_soul_id,
  text: r.text,
  tags: JSON.parse(r.tags),
  provenance: JSON.parse(r.provenance),
  createdAt: r.created_at,
  prunedAt: r.pruned_at,
  distilledAt: r.distilled_at,
});

export const newMemoryId = (): string => `mem_${ulid()}`;

export function getMemory(db: Db, memoryId: string): StoredMemory | undefined {
  const r = db.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memoryId) as
    | Row
    | undefined;
  return r ? toMemory(r) : undefined;
}

export interface ListOptions {
  soulId?: string;
  layers?: readonly MemoryLayer[];
  includePruned?: boolean;
  /** Only memories not yet distilled by a reflection pass. */
  undistilled?: boolean;
}

/** Soul's own private memories, or (no soulId) the town layer. Oldest first. */
export function listMemories(db: Db, o: ListOptions = {}): StoredMemory[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (o.soulId) {
    where.push("owner_soul_id = ?");
    args.push(o.soulId);
  } else {
    where.push("owner_soul_id IS NULL");
  }
  if (o.layers?.length) {
    where.push(`layer IN (${o.layers.map(() => "?").join(",")})`);
    args.push(...o.layers);
  }
  if (!o.includePruned) where.push("pruned_at IS NULL");
  if (o.undistilled) where.push("distilled_at IS NULL");
  const rows = db
    .prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY rowid`)
    .all(...args) as Row[];
  return rows.map(toMemory);
}

export interface ScoredMemory {
  memory: StoredMemory;
  /** Higher is more relevant (negated BM25). */
  score: number;
}

/** Turn free text into a safe FTS5 OR-query of quoted terms. */
export function toFtsQuery(text: string): string | undefined {
  const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 32);
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : undefined;
}

/**
 * Top-k relevant memories for a task: the soul's own episodic/semantic memories plus the town
 * layer. Persona is always injected separately and never competes for top-k slots. Other souls'
 * private memories are never returned.
 */
export function retrieveMemories(
  db: Db,
  o: { soulId: string; query: string; k: number },
): ScoredMemory[] {
  const q = toFtsQuery(o.query);
  if (!q || o.k <= 0) return [];
  const rows = db
    .prepare(
      `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.pruned_at IS NULL AND m.layer != 'persona'
         AND (m.owner_soul_id = ? OR m.layer = 'town')
       ORDER BY rank LIMIT ?`,
    )
    .all(q, o.soulId, o.k) as (Row & { rank: number })[];
  return rows.map((r) => ({ memory: toMemory(r), score: -r.rank }));
}

export function personaFor(db: Db, soulId: string): string | undefined {
  const r = db
    .prepare(
      "SELECT text FROM memories WHERE owner_soul_id = ? AND layer = 'persona' AND pruned_at IS NULL ORDER BY rowid DESC LIMIT 1",
    )
    .get(soulId) as { text: string } | undefined;
  if (r) return r.text;
  return (
    db.prepare("SELECT persona FROM souls WHERE soul_id = ?").get(soulId) as
      | { persona: string }
      | undefined
  )?.persona;
}

/** Event for writing a soul's episodic record when a dispatch settles. */
export function episodicEvent(o: {
  soulId: string;
  dispatchId: string;
  text: string;
  tags?: string[];
  eventId?: string;
}): NewEvent<"memory.episodic_written"> {
  return {
    type: "memory.episodic_written",
    payload: {
      memory: {
        memoryId: newMemoryId(),
        layer: "episodic",
        ownerSoulId: o.soulId,
        text: o.text,
        tags: o.tags ?? [],
        provenance: {
          author: "daemon",
          source: "worker_done",
          dispatchId: o.dispatchId,
          eventId: o.eventId,
        },
      },
    },
    actor: { kind: "daemon" },
    correlation: { soulId: o.soulId, dispatchId: o.dispatchId },
  };
}
