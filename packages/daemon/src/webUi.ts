import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** Where the built web UI is served. The JSON API stays at the root, so API paths never collide with UI pages. */
export const UI_PREFIX = "/ui";

/**
 * The UI calls the API under `/api` (the Vite dev server proxies it, and the production build uses the
 * same paths). The daemon serves those paths itself by dropping the prefix, so one build works in both.
 */
export function stripApiPrefix(url: string): string {
  if (!(url === "/api" || url.startsWith("/api/") || url.startsWith("/api?"))) return url;
  const rest = url.slice("/api".length);
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** Requests that need no token: the health check and the UI shell (which then asks for the token itself). */
export function isPublicPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return (
    path === "/health" || path === "/" || path === UI_PREFIX || path.startsWith(`${UI_PREFIX}/`)
  );
}

/** True when `dir` holds a built UI. */
export const hasBuiltUi = (dir: string): boolean => existsSync(join(dir, "index.html"));

/**
 * Serves the built web UI from `dir` at `/ui/` and redirects `/` there. Unknown `/ui/...` page paths answer
 * with the app shell, so client-side routes survive a reload; a missing file (a path with an extension)
 * is a real 404, not a page.
 */
export async function registerWebUi(app: FastifyInstance, dir: string): Promise<void> {
  app.get("/", async (_req, reply) => reply.redirect(`${UI_PREFIX}/`));
  await app.register(
    async (ui) => {
      await ui.register(fastifyStatic, { root: dir, wildcard: false });
      ui.setNotFoundHandler((req, reply) => {
        const path = req.url.split("?")[0] ?? "";
        const isPage =
          (req.method === "GET" || req.method === "HEAD") && !/\.[A-Za-z0-9]+$/.test(path);
        return isPage
          ? reply.sendFile("index.html")
          : reply
              .code(404)
              .send({ error: "not_found", message: `Route ${req.method}:${path} not found` });
      });
    },
    { prefix: UI_PREFIX },
  );
}
