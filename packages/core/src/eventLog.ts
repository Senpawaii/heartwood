import {
  type EventType,
  type HeartwoodEvent,
  type NewEvent,
  parseEvent,
  validateNewEvent,
} from "@heartwood/protocol";
import { ulid } from "ulid";
import type { Db } from "./db.js";
import { applyProjections } from "./projections.js";
import { defaultRules, type Rules } from "./rules.js";

export interface ReadOptions {
  afterSeq?: number;
  types?: readonly EventType[];
  limit?: number;
}

export type Subscriber = (event: HeartwoodEvent) => void;

/**
 * The append-only source of truth. A broker-backed implementation can replace this behind the
 * same interface; projections are then the only SQLite-specific part.
 */
export interface EventLog {
  /**
   * Atomically validates, appends and projects. Events whose (type, messageId) already
   * exist are skipped, so replayed Orca batches are idempotent. Returns only appended events.
   */
  append(events: readonly NewEvent[]): HeartwoodEvent[];
  read(opts?: ReadOptions): HeartwoodEvent[];
  lastSeq(): number;
  /** Subscribers run after the outermost transaction commits. Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void;
  /** Run `fn` atomically; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;
}

export interface EventLogOptions {
  rules?: Rules;
  now?: () => Date;
}

export class SqliteEventLog implements EventLog {
  private readonly rules: Rules;
  private readonly now: () => Date;
  private readonly subscribers = new Set<Subscriber>();
  private pending: HeartwoodEvent[] = [];
  private depth = 0;

  constructor(
    private readonly db: Db,
    opts: EventLogOptions = {},
  ) {
    this.rules = opts.rules ?? defaultRules;
    this.now = opts.now ?? (() => new Date());
  }

  transaction<T>(fn: () => T): T {
    this.depth++;
    const startLen = this.pending.length;
    try {
      const result = this.db.transaction(fn)();
      this.depth--;
      if (this.depth === 0) this.flush();
      return result;
    } catch (err) {
      this.depth--;
      this.pending.length = startLen;
      throw err;
    }
  }

  append(events: readonly NewEvent[]): HeartwoodEvent[] {
    return this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO events (id, at, type, v, actor, correlation, caused_by, message_id, payload)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      const out: HeartwoodEvent[] = [];
      for (const raw of events) {
        const e = validateNewEvent(raw);
        const id = ulid();
        const at = this.now().toISOString();
        const payload = e.payload as { messageId?: string };
        const res = insert.run(
          id,
          at,
          e.type,
          JSON.stringify(e.actor),
          JSON.stringify(e.correlation ?? {}),
          e.causedBy ?? null,
          payload.messageId ?? null,
          JSON.stringify(e.payload),
        );
        if (res.changes === 0) continue;
        const event = {
          seq: Number(res.lastInsertRowid),
          id,
          at,
          v: 1,
          type: e.type,
          actor: e.actor,
          correlation: e.correlation ?? {},
          ...(e.causedBy ? { causedBy: e.causedBy } : {}),
          payload: e.payload,
        } as HeartwoodEvent;
        applyProjections(this.db, event, this.rules);
        out.push(event);
      }
      this.pending.push(...out);
      return out;
    });
  }

  read(opts: ReadOptions = {}): HeartwoodEvent[] {
    const where = ["seq > ?"];
    const args: unknown[] = [opts.afterSeq ?? 0];
    if (opts.types?.length) {
      where.push(`type IN (${opts.types.map(() => "?").join(",")})`);
      args.push(...opts.types);
    }
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`)
      .all(...args, opts.limit ?? -1) as EventRow[];
    return rows.map(rowToEvent);
  }

  lastSeq(): number {
    const r = this.db.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number | null };
    return r.s ?? 0;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private flush(): void {
    const batch = this.pending;
    this.pending = [];
    for (const e of batch) for (const s of this.subscribers) s(e);
  }
}

interface EventRow {
  seq: number;
  id: string;
  at: string;
  type: string;
  v: number;
  actor: string;
  correlation: string;
  caused_by: string | null;
  payload: string;
}

function rowToEvent(r: EventRow): HeartwoodEvent {
  return parseEvent({
    seq: r.seq,
    id: r.id,
    at: r.at,
    type: r.type,
    v: r.v,
    actor: JSON.parse(r.actor),
    correlation: JSON.parse(r.correlation),
    ...(r.caused_by ? { causedBy: r.caused_by } : {}),
    payload: JSON.parse(r.payload),
  });
}
