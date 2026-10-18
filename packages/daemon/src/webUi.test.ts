import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, json } from "./testing.js";
import { hasBuiltUi, isPublicPath, stripApiPrefix } from "./webUi.js";

const SHELL = "<!doctype html><title>shell</title>";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hw-ui-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), SHELL);
  await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const get = (b: Awaited<ReturnType<typeof boot>>, url: string, headers?: Record<string, string>) =>
  b.app.inject({ method: "GET", url, headers });

describe("serving the web UI", () => {
  it("redirects / to the UI, serves the shell and assets, and answers page routes with the shell so reloads work", async () => {
    const b = await boot({ webDir: dir });
    expect(await get(b, "/")).toMatchObject({ statusCode: 302, headers: { location: "/ui/" } });
    expect((await get(b, "/ui/")).body).toBe(SHELL);
    expect((await get(b, "/ui/assets/app.js")).body).toBe("console.log(1)");
    expect((await get(b, "/ui/skills")).body).toBe(SHELL);
    expect((await get(b, "/ui/souls/s1/anything")).body).toBe(SHELL);
  });

  it("answers a missing file or a write with a real 404, never the shell", async () => {
    const b = await boot({ webDir: dir });
    const missing = await get(b, "/ui/assets/gone.js");
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("shell");
    const post = await b.app.inject({ method: "POST", url: "/ui/skills" });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toMatchObject({ error: "not_found" });
  });

  it("serves the API at the root and under /api, so the UI works unchanged in dev and in production", async () => {
    const b = await boot({ webDir: dir });
    expect((await json(b.app, "GET", "/health")).body.ok).toBe(true);
    expect((await json(b.app, "GET", "/api/health")).body.ok).toBe(true);
    expect((await json(b.app, "GET", "/api/souls")).status).toBe(200);
  });

  it("keeps the API behind the token but lets the page load, so the page can ask for the token", async () => {
    const token = "a-long-enough-token";
    const b = await boot({ webDir: dir, token });
    for (const url of ["/", "/ui/", "/ui/skills", "/ui/assets/app.js", "/health"])
      expect((await get(b, url)).statusCode, url).not.toBe(401);
    for (const url of ["/souls", "/api/souls", "/skills", "/events"])
      expect((await get(b, url)).statusCode, url).toBe(401);
    const authed = await get(b, "/api/souls", { authorization: `Bearer ${token}` });
    expect(authed.statusCode).toBe(200);
  });

  it("serves only the API when no UI is configured", async () => {
    const b = await boot();
    expect((await get(b, "/")).statusCode).toBe(404);
    expect((await get(b, "/ui/")).statusCode).toBe(404);
    expect((await json(b.app, "GET", "/health")).body.ok).toBe(true);
  });
});

describe("path rules", () => {
  it("strips /api only as a whole path segment", () => {
    expect(stripApiPrefix("/api/souls")).toBe("/souls");
    expect(stripApiPrefix("/api/events?limit=1")).toBe("/events?limit=1");
    expect(stripApiPrefix("/api")).toBe("/");
    expect(stripApiPrefix("/api?x=1")).toBe("/?x=1");
    expect(stripApiPrefix("/apiary")).toBe("/apiary");
    expect(stripApiPrefix("/souls/api")).toBe("/souls/api");
  });

  it("treats only the health check and the UI shell as public", () => {
    for (const p of ["/health", "/", "/ui", "/ui/", "/ui/x/y?z=1"])
      expect(isPublicPath(p), p).toBe(true);
    for (const p of ["/souls", "/uix", "/ui-secret", "/events/stream?token=x", "/health/x"])
      expect(isPublicPath(p), p).toBe(false);
  });

  it("recognises a built UI by its index.html", async () => {
    expect(hasBuiltUi(dir)).toBe(true);
    expect(hasBuiltUi(join(dir, "assets"))).toBe(false);
    expect(hasBuiltUi(join(dir, "missing"))).toBe(false);
  });
});
