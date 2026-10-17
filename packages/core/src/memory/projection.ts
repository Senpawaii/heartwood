import type { HeartwoodEvent, MemoryRecord } from "@heartwood/protocol";
import type { Db } from "../db.js";

function insertMemory(db: Db, m: MemoryRecord, at: string): void {
  const res = db
    .prepare(
      `INSERT INTO memories (memory_id, layer, owner_soul_id, text, tags, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.memoryId,
      m.layer,
      m.ownerSoulId,
      m.text,
      JSON.stringify(m.tags),
      JSON.stringify(m.provenance),
      at,
    );
  db.prepare("INSERT INTO memories_fts (rowid, text, tags) VALUES (?, ?, ?)").run(
    res.lastInsertRowid,
    m.text,
    m.tags.join(" "),
  );
}

export function applyMemoryProjection(db: Db, e: HeartwoodEvent): void {
  switch (e.type) {
    case "memory.persona_set":
    case "memory.episodic_written":
    case "memory.shared_promoted":
      insertMemory(db, e.payload.memory, e.at);
      break;
    case "memory.semantic_distilled": {
      insertMemory(db, e.payload.memory, e.at);
      const mark = db.prepare("UPDATE memories SET distilled_at = ? WHERE memory_id = ?");
      for (const id of e.payload.sourceMemoryIds) mark.run(e.at, id);
      break;
    }
    case "memory.edited": {
      const row = db
        .prepare("SELECT rowid, tags, pruned_at FROM memories WHERE memory_id = ?")
        .get(e.payload.memoryId) as
        | { rowid: number; tags: string; pruned_at: string | null }
        | undefined;
      if (!row) break;
      db.prepare("UPDATE memories SET text = ? WHERE memory_id = ?").run(
        e.payload.text,
        e.payload.memoryId,
      );
      if (!row.pruned_at) {
        db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(row.rowid);
        db.prepare("INSERT INTO memories_fts (rowid, text, tags) VALUES (?, ?, ?)").run(
          row.rowid,
          e.payload.text,
          (JSON.parse(row.tags) as string[]).join(" "),
        );
      }
      break;
    }
    case "memory.pruned": {
      const row = db
        .prepare("SELECT rowid FROM memories WHERE memory_id = ?")
        .get(e.payload.memoryId) as { rowid: number } | undefined;
      if (!row) break;
      db.prepare("UPDATE memories SET pruned_at = ?, pruned_reason = ? WHERE memory_id = ?").run(
        e.at,
        e.payload.reason,
        e.payload.memoryId,
      );
      db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(row.rowid);
      break;
    }
    default:
      break;
  }
}
