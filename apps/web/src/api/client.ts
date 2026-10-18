import {
  AnalyzeResponse,
  EvolveResponse,
  Health,
  Inbox,
  MinistriesResponse,
  ProficiencyResponse,
  SkillCatalogResponse,
  SkillRanksResponse,
  SkillUsageResponse,
  SoulDetail,
  SoulMemoryResponse,
  SoulsResponse,
  TownSummary,
  WarbandDetail,
  WarbandsResponse,
} from "@heartwood/protocol";
import { z } from "zod";
import { parseLiveEvent } from "./live";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  /** Where the daemon is mounted. The Vite dev server proxies `/api` to it. */
  baseUrl?: string;
  getToken?: () => string | undefined;
  fetch?: typeof fetch;
}

const ErrorBody = z.object({ error: z.string(), message: z.string().optional() }).passthrough();
const Ok = z.looseObject({});

export interface DispatchInput {
  soulId: string;
  brief: {
    target: string;
    change: string;
    constraints: string;
    ownership: string;
    acceptance: string;
  };
  agent?: string;
  model?: string;
  effort?: string;
  placement?: string;
}

/** Typed daemon client. Every response is validated against the shared schemas, so drift fails loudly. */
export function createClient(o: ClientOptions = {}) {
  const base = o.baseUrl ?? "/api";
  const doFetch = o.fetch ?? fetch;

  async function send(
    method: string,
    path: string,
    body?: unknown,
    contentType?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    const token = o.getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = contentType ?? "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await doFetch(base + path, { method, headers, body: payload });
    if (res.ok) return res;
    let parsed: z.infer<typeof ErrorBody> | undefined;
    try {
      parsed = ErrorBody.parse(await res.json());
    } catch {
      // non-JSON error (e.g. a proxy page)
    }
    throw new ApiError(
      res.status,
      parsed?.error ?? "http_error",
      parsed?.message ?? `HTTP ${res.status}`,
      parsed,
    );
  }

  async function request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const res = await send(method, path, body);
    return schema.parse(await res.json());
  }

  const enc = encodeURIComponent;
  return {
    health: () => request("GET", "/health", Health),
    town: () => request("GET", "/town", TownSummary),
    inbox: () => request("GET", "/inbox", Inbox),
    ministries: () => request("GET", "/ministries", MinistriesResponse),
    souls: () => request("GET", "/souls", SoulsResponse),
    soul: (id: string) => request("GET", `/souls/${enc(id)}`, SoulDetail),
    soulMemory: (id: string) => request("GET", `/souls/${enc(id)}/memory`, SoulMemoryResponse),
    proficiency: (id: string, skill: string) =>
      request("GET", `/souls/${enc(id)}/skills/${enc(skill)}/proficiency`, ProficiencyResponse),
    skillCatalog: () => request("GET", "/skills", SkillCatalogResponse),
    skillUsage: () => request("GET", "/skills/usage", SkillUsageResponse),
    skillRanks: () => request("GET", "/skills/ranks", SkillRanksResponse),
    warbands: () => request("GET", "/warbands", WarbandsResponse),
    warband: (id: string) => request("GET", `/warbands/${enc(id)}`, WarbandDetail),
    /** Newest events first is the caller's job; this returns the last `limit` events in order. */
    recentEvents: async (limit: number) => {
      const Page = z.object({ events: z.array(z.unknown()), lastSeq: z.number() });
      const head = await request("GET", "/events?limit=1", Page);
      const page = await request(
        "GET",
        `/events?afterSeq=${Math.max(0, head.lastSeq - limit)}&limit=${limit}`,
        Page,
      );
      return page.events.flatMap((e) => {
        const parsed = parseLiveEvent(JSON.stringify(e));
        return parsed ? [parsed] : [];
      });
    },
    memoryMarkdown: async (id: string) => (await send("GET", `/souls/${enc(id)}/memory.md`)).text(),

    createMinistry: (b: { name: string; kind: string }) => request("POST", "/ministries", Ok, b),
    createSoul: (b: {
      name: string;
      species: string;
      ministryId: string;
      persona: string;
      magiculesSpent?: number;
    }) => request("POST", "/souls", Ok, b),
    /** Benchmarks a pinned skill. Takes minutes with a real agent. */
    analyzeSkill: (name: string, digest: string) =>
      request("POST", "/skills/analyze", AnalyzeResponse, { name, digest }),
    /** Proposes a new version and promotes it only on proof. Takes minutes with a real agent. */
    evolveSkill: (name: string, digest: string) =>
      request("POST", "/skills/evolve", EvolveResponse, { name, digest }),
    evolve: (id: string) => request("POST", `/souls/${enc(id)}/evolve`, Ok),
    absorb: (id: string, name: string) => request("POST", `/souls/${enc(id)}/skills`, Ok, { name }),
    saveMemoryMarkdown: (id: string, md: string) =>
      send("PUT", `/souls/${enc(id)}/memory.md`, md, "text/plain").then(async (r) =>
        z.object({ edited: z.number(), pruned: z.number() }).parse(await r.json()),
      ),
    pruneMemory: (id: string, reason: string) =>
      request("POST", `/memories/${enc(id)}/prune`, Ok, { reason }),
    promoteMemory: (id: string) => request("POST", `/memories/${enc(id)}/promote`, Ok),
    formWarband: (b: { objective: string; foremanSoulId: string; memberSoulIds: string[] }) =>
      request("POST", "/warbands", Ok, b),
    dispatch: (warbandId: string, b: DispatchInput) =>
      request("POST", `/warbands/${enc(warbandId)}/dispatches`, Ok, b),
    disband: (warbandId: string, reason?: string) =>
      request("POST", `/warbands/${enc(warbandId)}/disband`, Ok, { reason }),
    answerQuestion: (id: string, answer: string) =>
      request("POST", `/questions/${enc(id)}/answer`, Ok, { answer }),
    resolveEscalation: (id: string, resolution: string) =>
      request("POST", `/escalations/${enc(id)}/resolve`, Ok, { resolution }),
    connectBackend: () => request("POST", "/backend/connect", Ok),
  };
}

export type Client = ReturnType<typeof createClient>;
