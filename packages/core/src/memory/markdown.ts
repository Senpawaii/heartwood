import type { MemoryLayer, NewEvent } from "@heartwood/protocol";
import type { Db } from "../db.js";
import { listMemories } from "./store.js";

const layers: MemoryLayer[] = ["persona", "episodic", "semantic"];
const MARKER = /^<!-- memory:(\S+) -->$/;
const HEADING = /^## (persona|episodic|semantic)$/;

/**
 * Human-readable, editable view of one soul's private memory. Edit the text under a marker to
 * change a memory; delete a whole block to prune it. Markers must be left intact.
 */
export function renderSoulMarkdown(db: Db, soulId: string, soulName = soulId): string {
  const out = [
    `# ${soulName} — memory`,
    "",
    "<!-- Edit text under a marker to change a memory; delete a block to prune it. Do not edit markers. -->",
  ];
  for (const layer of layers) {
    out.push("", `## ${layer}`);
    for (const m of listMemories(db, { soulId, layers: [layer] })) {
      out.push("", `<!-- memory:${m.memoryId} -->`, m.text.trim());
    }
  }
  return `${out.join("\n")}\n`;
}

/** Parse an edited view into memory id -> text. */
export function parseSoulMarkdown(md: string): Map<string, string> {
  const blocks = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of md.split(/\r?\n/)) {
    const m = MARKER.exec(line.trim());
    if (m) {
      current = [];
      blocks.set(m[1] as string, current);
    } else if (HEADING.test(line.trim())) {
      current = undefined;
    } else current?.push(line);
  }
  return new Map([...blocks].map(([id, lines]) => [id, lines.join("\n").trim()]));
}

/** Diff an edited view against the stored memories: changed text -> edited, missing block -> pruned. */
export function markdownEdits(db: Db, soulId: string, md: string): NewEvent[] {
  const edited = parseSoulMarkdown(md);
  const events: NewEvent[] = [];
  for (const m of listMemories(db, { soulId, layers })) {
    const text = edited.get(m.memoryId);
    if (text === undefined) {
      events.push({
        type: "memory.pruned",
        payload: { memoryId: m.memoryId, reason: "removed in markdown view" },
        actor: { kind: "sovereign" },
        correlation: { soulId },
      });
    } else if (text === "") {
    } else if (text !== m.text.trim()) {
      events.push({
        type: "memory.edited",
        payload: { memoryId: m.memoryId, text },
        actor: { kind: "sovereign" },
        correlation: { soulId },
      });
    }
  }
  return events;
}
