import { type EventType, eventTypes, type HeartwoodEvent } from "@heartwood/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DaemonContext } from "../daemon.js";

const MAX_BUFFERED_BYTES = 1_000_000;
const KEEPALIVE_MS = 15_000;

const TypesParam = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(",").filter(Boolean) : []))
  .pipe(z.array(z.enum(eventTypes as [EventType, ...EventType[]])));

const ListQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  types: TypesParam,
});

const StreamQuery = z.object({
  lastEventId: z.coerce.number().int().min(0).optional(),
  types: TypesParam,
});

const frame = (e: HeartwoodEvent) =>
  `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

export function registerEventRoutes(app: FastifyInstance, d: DaemonContext): void {
  app.get("/events", async (req) => {
    const q = ListQuery.parse(req.query);
    const events = d.ctx.log.read({ afterSeq: q.afterSeq, limit: q.limit, types: q.types });
    return { events, lastSeq: d.ctx.log.lastSeq() };
  });

  /**
   * Server-sent events. Resumes after `Last-Event-ID` (= event seq) or `?lastEventId=`; without one
   * it streams only new events. Subscribes before replaying so nothing falls in the gap, and
   * de-duplicates the overlap by seq.
   */
  app.get("/events/stream", (req, reply) => {
    const q = StreamQuery.parse(req.query);
    const header = Number(req.headers["last-event-id"]);
    const resumeFrom = Number.isInteger(header) && header >= 0 ? header : q.lastEventId;
    const wanted = q.types.length ? new Set<string>(q.types) : undefined;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let lastSent = resumeFrom ?? d.ctx.log.lastSeq();
    let replaying = true;
    const buffered: HeartwoodEvent[] = [];
    let closed = false;

    const send = (e: HeartwoodEvent) => {
      if (closed || e.seq <= lastSent) return;
      lastSent = e.seq;
      if (wanted && !wanted.has(e.type)) return;
      raw.write(frame(e));
      if (raw.writableLength > MAX_BUFFERED_BYTES) {
        // A client that cannot keep up is dropped; it reconnects with Last-Event-ID and replays.
        finish();
      }
    };

    const unsubscribe = d.ctx.log.subscribe((e) => {
      if (replaying) buffered.push(e);
      else send(e);
    });
    const keepalive = setInterval(() => !closed && raw.write(": ping\n\n"), KEEPALIVE_MS);

    function finish() {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
      raw.end();
    }
    req.raw.on("close", finish);

    raw.write("retry: 3000\n\n");
    if (resumeFrom !== undefined) {
      for (;;) {
        const page = d.ctx.log.read({ afterSeq: lastSent, limit: 500 });
        if (page.length === 0) break;
        const before = lastSent;
        for (const e of page) send(e);
        if (lastSent === before) break;
      }
    }
    replaying = false;
    for (const e of buffered.splice(0)) send(e);
  });
}
