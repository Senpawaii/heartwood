import { timingSafeEqual } from "node:crypto";
import {
  BackendCoordinator,
  BackendError,
  type BackendInfo,
  type CoordinatorOptions,
  type Ctx,
  type Db,
  DomainError,
  defaultRules,
  GroupLimitError,
  type LabCtx,
  type LabPort,
  LabUnavailableError,
  NotFoundError,
  type Rules,
  SourceUnavailableError,
  SqliteEventLog,
  type WorkerBackend,
  WorkerStartError,
} from "@heartwood/core";
import { EventValidationError } from "@heartwood/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { registerEventRoutes } from "./routes/events.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerSoulRoutes } from "./routes/souls.js";
import { registerWarbandRoutes } from "./routes/warbands.js";
import { isPublicPath, registerWebUi, stripApiPrefix } from "./webUi.js";

const TokenQuery = z.object({ token: z.string().optional() });

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Workers run as Oh My Pi (`omp`), which uses whatever Claude model omp is configured with. Never `claude` directly. */
export const DEFAULT_AGENT = "omp";

export interface DaemonDeps {
  db: Db;
  backend: WorkerBackend;
  lab: LabPort;
  rules?: Rules;
  townName?: string;
  /** Directory of the built web UI, served at /ui/. Omit to serve the API only. */
  webDir?: string;
  /** Bearer token required on every request except /health and the UI shell. */
  token?: string;
  coordinator?: CoordinatorOptions;
  /** Agent for dispatches that do not name one. Default `omp` (Oh My Pi); Claude models run through it. */
  defaultAgent?: string;
  logger?: boolean | { level: string };
}

export type BackendState =
  | { status: "ready"; info: BackendInfo }
  | { status: "degraded"; info?: BackendInfo; problems: string[] }
  | { status: "starting" };

/** Everything the routes need. */
export interface DaemonContext {
  /** Agent that dispatches use unless the request names one. */
  defaultAgent: string;
  ctx: LabCtx;
  backend: WorkerBackend;
  coordinator: BackendCoordinator;
  backendState(): BackendState;
}

export interface Daemon {
  app: FastifyInstance;
  ctx: Ctx;
  coordinator: BackendCoordinator;
  backendState(): BackendState;
  /** (Re)connect to the backend and resume watching active groups. Safe to call again after a failure. */
  connectBackend(): Promise<BackendState>;
  close(): Promise<void>;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Composition root: wires the event log, coordinator and HTTP surface. */
export async function createDaemon(deps: DaemonDeps): Promise<Daemon> {
  const rules = deps.rules ?? defaultRules;
  const log = new SqliteEventLog(deps.db, { rules });
  const ctx: LabCtx = { db: deps.db, log, rules, lab: deps.lab };
  const coordinator = new BackendCoordinator(ctx, deps.backend, deps.coordinator);
  let state: BackendState = { status: "starting" };

  if (!deps.db.prepare("SELECT 1 FROM events WHERE type = 'town.founded'").get()) {
    log.append([
      {
        type: "town.founded",
        payload: { name: deps.townName ?? "Heartwood" },
        actor: { kind: "sovereign" },
      },
    ]);
  }

  const connectBackend = async (): Promise<BackendState> => {
    try {
      const info = await deps.backend.open();
      if (!info.compatible) {
        log.append([
          {
            type: "backend.incompatible",
            payload: { backend: info.name, version: info.version, problems: info.problems },
            actor: { kind: "daemon" },
          },
        ]);
        state = { status: "degraded", info, problems: info.problems };
      } else {
        coordinator.resume();
        state = { status: "ready", info };
      }
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err);
      log.append([
        {
          type: "backend.incompatible",
          payload: { backend: deps.backend.name, problems: [`could not open backend: ${problem}`] },
          actor: { kind: "daemon" },
        },
      ]);
      state = { status: "degraded", problems: [problem] };
    }
    return state;
  };

  const app = Fastify({
    logger: deps.logger ?? false,
    rewriteUrl: (req) => stripApiPrefix(req.url ?? ""),
  });
  const dctx: DaemonContext = {
    defaultAgent: deps.defaultAgent ?? DEFAULT_AGENT,
    ctx,
    backend: deps.backend,
    coordinator,
    backendState: () => state,
  };

  app.addHook("onRequest", async (req) => {
    if (!deps.token || isPublicPath(req.url)) return;
    const header = req.headers.authorization?.replace(/^Bearer /i, "");
    // EventSource cannot set headers, so the SSE endpoint also accepts ?token=.
    const query = TokenQuery.safeParse(req.query).data?.token;
    const given = header ?? query ?? "";
    if (!safeEqual(given, deps.token))
      throw new HttpError(401, "unauthorized", "missing or invalid token");
  });

  app.setErrorHandler((err, _req, reply) => {
    const send = (status: number, error: string, extra: object = {}) =>
      reply
        .status(status)
        .send({ error, message: err instanceof Error ? err.message : String(err), ...extra });
    if (err instanceof HttpError) return send(err.status, err.code);
    if (err instanceof ZodError) return send(400, "invalid_request", { issues: err.issues });
    if (err instanceof EventValidationError) return send(400, "invalid_request");
    if (err instanceof GroupLimitError) return send(429, "group_limit");
    if (err instanceof NotFoundError) return send(404, "not_found");
    if (err instanceof DomainError) return send(409, "conflict");
    if (err instanceof LabUnavailableError) return send(501, "lab_unavailable");
    if (err instanceof SourceUnavailableError) return send(503, "source_unavailable");
    if (err instanceof WorkerStartError)
      return send(502, err.code ?? "worker_start_failed", {
        failedStage: err.failedStage,
        residualResources: err.residualResources,
      });
    if (err instanceof BackendError) return send(502, err.code ?? "backend_error");
    const status =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof err.statusCode === "number"
        ? err.statusCode
        : undefined;
    if (status && status >= 400 && status < 500) return send(status, "bad_request");
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "internal error" });
  });

  app.get("/health", async () => ({
    ok: true,
    backend: state,
    lastSeq: log.lastSeq(),
    watching: coordinator.watching,
  }));
  app.post("/backend/connect", async () => connectBackend());

  if (deps.webDir) await registerWebUi(app, deps.webDir);

  registerEventRoutes(app, dctx);
  registerSoulRoutes(app, dctx);
  registerSkillRoutes(app, dctx);
  registerWarbandRoutes(app, dctx);

  await connectBackend();

  return {
    app,
    ctx,
    coordinator,
    backendState: () => state,
    connectBackend,
    async close() {
      await coordinator.stopAll();
      await app.close();
    },
  };
}
