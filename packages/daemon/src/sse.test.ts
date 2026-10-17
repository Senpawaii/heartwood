import { afterEach, describe, expect, it } from "vitest";
import { type Booted, boot, json, seedTown } from "./testing.js";

interface Frame {
  id?: string;
  event?: string;
  data?: any;
}

/** Minimal SSE client: reads frames from a streaming fetch. */
async function connect(url: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: Frame[] = [];
  let wake: (() => void)[] = [];
  const pump = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i = buf.indexOf("\n\n");
        while (i >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const f: Frame = {};
          for (const line of raw.split("\n")) {
            if (line.startsWith("id: ")) f.id = line.slice(4);
            else if (line.startsWith("event: ")) f.event = line.slice(7);
            else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
          }
          if (f.id) {
            frames.push(f);
            for (const w of wake.splice(0)) w();
          }
          i = buf.indexOf("\n\n");
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    res,
    frames,
    /** Resolves when n frames have arrived (the test runner's own timeout is the failsafe). */
    async waitFor(n: number) {
      while (frames.length < n) await new Promise<void>((resolve) => wake.push(resolve));
    },
    close: async () => {
      ac.abort();
      await pump;
    },
  };
}

let b: Booted;
let base: string;
afterEach(async () => {
  await b.daemon.close();
});

async function up(token?: string) {
  b = await boot({ token });
  const addr = await b.app.listen({ host: "127.0.0.1", port: 0 });
  base = addr;
}

const newSoul = (n: string) => ({
  type: "soul.named" as const,
  payload: {
    soulId: n,
    name: n,
    species: "elf" as const,
    ministryId: "m",
    persona: "p",
    magiculesSpent: 0,
  },
  actor: { kind: "sovereign" as const },
});

describe("GET /events/stream", () => {
  it("streams only new events when no resume point is given", async () => {
    await up();
    b.daemon.ctx.log.append([newSoul("old")]);
    const c = await connect(`${base}/events/stream`);
    expect(c.res.headers.get("content-type")).toContain("text/event-stream");
    b.daemon.ctx.log.append([newSoul("fresh")]);
    await c.waitFor(1);
    expect(c.frames[0]).toMatchObject({
      event: "soul.named",
      data: { payload: { soulId: "fresh" } },
    });
    expect(c.frames[0]?.id).toBe(String(c.frames[0]?.data.seq));
    await c.close();
  });

  it("resumes from Last-Event-ID: replays what was missed in order, then continues live, without gaps or duplicates", async () => {
    await up();
    b.daemon.ctx.log.append([newSoul("a"), newSoul("b"), newSoul("c")]);
    const all = b.daemon.ctx.log.read();
    const resumeAfter = all[0]?.seq ?? 0; // saw town.founded only
    const c = await connect(`${base}/events/stream`, { "Last-Event-ID": String(resumeAfter) });
    await c.waitFor(3);
    b.daemon.ctx.log.append([newSoul("d")]);
    await c.waitFor(4);
    const seqs = c.frames.map((f) => Number(f.id));
    expect(seqs).toEqual(
      all
        .slice(1)
        .map((e) => e.seq)
        .concat(seqs[3] as number),
    );
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(c.frames[3]?.data.payload.soulId).toBe("d");
    await c.close();
  });

  it("accepts ?lastEventId= for clients that cannot set headers", async () => {
    await up();
    b.daemon.ctx.log.append([newSoul("a")]);
    const c = await connect(`${base}/events/stream?lastEventId=0`);
    await c.waitFor(2); // town.founded + soul.named
    expect(c.frames.map((f) => f.event)).toEqual(["town.founded", "soul.named"]);
    await c.close();
  });

  it("filters by type but still advances past filtered events", async () => {
    await up();
    const c = await connect(`${base}/events/stream?types=soul.named&lastEventId=0`);
    b.daemon.ctx.log.append([newSoul("a")]);
    await c.waitFor(1);
    expect(c.frames.map((f) => f.event)).toEqual(["soul.named"]);
    await c.close();
  });

  it("carries real daemon activity end to end", async () => {
    await up();
    const c = await connect(`${base}/events/stream?types=soul.named,memory.persona_set`);
    await seedTown(b);
    await c.waitFor(4);
    expect(c.frames.map((f) => f.event)).toEqual([
      "soul.named",
      "memory.persona_set",
      "soul.named",
      "memory.persona_set",
    ]);
    await c.close();
  });

  it("requires the token, accepted via query for EventSource", async () => {
    await up("stream-token-value-123456");
    expect((await fetch(`${base}/events/stream`)).status).toBe(401);
    const c = await connect(`${base}/events/stream?token=stream-token-value-123456`);
    expect(c.res.status).toBe(200);
    await c.close();
    expect((await json(b.app, "GET", "/health")).status).toBe(200);
  });

  it("rejects unknown event types", async () => {
    await up();
    expect((await fetch(`${base}/events/stream?types=nope.nope`)).status).toBe(400);
  });
});
