import { describe, expect, it } from "vitest";
import { ApiError, createClient } from "./client";

const reply = (status: number, body: unknown, contentType = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });

function setup(
  handler: (req: {
    method: string;
    url: string;
    headers: Headers;
    body: string | null;
  }) => Response,
  token?: string,
) {
  const seen: { method: string; url: string; headers: Headers; body: string | null }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const req = {
      method: init.method ?? "GET",
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : null,
    };
    seen.push(req);
    return handler(req);
  }) as typeof fetch;
  return { seen, client: createClient({ fetch: fetchFn, getToken: () => token }) };
}

describe("createClient", () => {
  it("sends the bearer token and validates the response", async () => {
    const { client, seen } = setup(
      () =>
        reply(200, {
          ok: true,
          backend: { status: "ready", info: { name: "orca" } },
          lastSeq: 3,
          watching: [],
        }),
      "tok-123",
    );
    expect((await client.health()).backend.status).toBe("ready");
    expect(seen[0]?.url).toBe("/api/health");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok-123");
  });

  it("sends no authorization header without a token", async () => {
    const { client, seen } = setup(() => reply(200, { souls: [] }));
    await client.souls();
    expect(seen[0]?.headers.has("authorization")).toBe(false);
  });

  it("fails loudly when the daemon's response drifts from the shared schema", async () => {
    const { client } = setup(() => reply(200, { souls: [{ soulId: "s1", name: "Oak" }] }));
    await expect(client.souls()).rejects.toThrow();
  });

  it("turns the daemon's error body into an ApiError with status and code", async () => {
    const { client } = setup(() =>
      reply(409, { error: "conflict", message: "Oakhand needs level 5 to evolve (is 1)" }),
    );
    const err = await client.evolve("s1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: "conflict",
      message: "Oakhand needs level 5 to evolve (is 1)",
    });
  });

  it("survives a non-JSON error page from a proxy", async () => {
    const { client } = setup(() => reply(502, "<html>Bad gateway</html>", "text/html"));
    expect(await client.souls().catch((e) => e)).toMatchObject({ status: 502, code: "http_error" });
  });

  it("encodes ids and saves the memory view as text/plain", async () => {
    const { client, seen } = setup((req) =>
      req.method === "PUT" ? reply(200, { edited: 1, pruned: 0 }) : reply(200, { series: [] }),
    );
    await client.proficiency("soul/1", "tdd & co");
    expect(seen[0]?.url).toBe("/api/souls/soul%2F1/skills/tdd%20%26%20co/proficiency");
    expect(await client.saveMemoryMarkdown("s1", "# md")).toEqual({ edited: 1, pruned: 0 });
    expect(seen[1]?.headers.get("content-type")).toBe("text/plain");
    expect(seen[1]?.body).toBe("# md");
  });

  it("reads the last N events and skips ones this UI does not know", async () => {
    const ev = (seq: number, type: string, payload: object) => ({
      seq,
      id: `i${seq}`,
      at: "2026-10-17T00:00:00.000Z",
      v: 1,
      type,
      actor: { kind: "daemon" },
      correlation: {},
      payload,
    });
    const { client, seen } = setup((req) =>
      req.url.includes("limit=1&") || req.url.endsWith("limit=1")
        ? reply(200, { events: [], lastSeq: 50 })
        : reply(200, {
            events: [ev(49, "town.founded", { name: "T" }), ev(50, "future.thing", {})],
            lastSeq: 50,
          }),
    );
    const events = await client.recentEvents(10);
    expect(events.map((e) => e.type)).toEqual(["town.founded"]);
    expect(seen[1]?.url).toBe("/api/events?afterSeq=40&limit=10");
  });
});
