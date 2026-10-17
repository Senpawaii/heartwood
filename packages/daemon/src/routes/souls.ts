import {
  awakenSoul,
  evolveSoul,
  getMemory,
  getSoul,
  listMemories,
  listMinistries,
  listSoulSkills,
  listSouls,
  markdownEdits,
  NotFoundError,
  nameSoul,
  newMemoryId,
  personaFor,
  proficiencySeries,
  renderSoulMarkdown,
  skillUsageForSoul,
} from "@heartwood/core";
import { MinistryKind, Species } from "@heartwood/protocol";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import type { DaemonContext } from "../daemon.js";

const NewMinistry = z.object({ name: z.string().min(1), kind: MinistryKind });
const NewSoul = z.object({
  name: z.string().min(1).max(60),
  species: Species,
  ministryId: z.string().min(1),
  persona: z.string().min(1),
  magiculesSpent: z.number().nonnegative().default(0),
});
const Awaken = z.object({
  title: z.string().min(1),
  proof: z.object({ kind: z.enum(["benchmark", "project"]), ref: z.string().min(1) }),
});
const Reason = z.object({ reason: z.string().min(1) });

export function registerSoulRoutes(app: FastifyInstance, d: DaemonContext): void {
  const { ctx } = d;
  const soulOr404 = (id: string) => {
    const s = getSoul(ctx.db, id, ctx.rules);
    if (!s) throw new NotFoundError(`unknown soul: ${id}`);
    return s;
  };

  app.get("/ministries", async () => ({ ministries: listMinistries(ctx.db) }));

  app.post("/ministries", async (req, reply) => {
    const b = NewMinistry.parse(req.body);
    const ministryId = `min_${ulid()}`;
    ctx.log.append([
      {
        type: "town.ministry_created",
        payload: { ministryId, name: b.name, kind: b.kind },
        actor: { kind: "sovereign" },
      },
    ]);
    return reply.status(201).send({ ministryId });
  });

  app.get("/souls", async () => ({ souls: listSouls(ctx.db, ctx.rules) }));

  /** Naming is a deliberate act: it creates the character and records what it cost. */
  app.post("/souls", async (req, reply) => {
    const b = NewSoul.parse(req.body);
    const ministry = listMinistries(ctx.db).find((m) => m.ministryId === b.ministryId);
    if (!ministry) throw new NotFoundError(`unknown ministry: ${b.ministryId}`);
    const soulId = nameSoul(ctx, b);
    // The persona is also the stable first layer of the soul's memory (editable in its Markdown view).
    ctx.log.append([
      {
        type: "memory.persona_set",
        payload: {
          memory: {
            memoryId: newMemoryId(),
            layer: "persona",
            ownerSoulId: soulId,
            text: b.persona,
            tags: [],
            provenance: { author: "human", source: "naming" },
          },
        },
        actor: { kind: "sovereign" },
        correlation: { soulId },
      },
    ]);
    return reply.status(201).send({ soul: soulOr404(soulId) });
  });

  app.get<{ Params: { id: string } }>("/souls/:id", async (req) => {
    const soul = soulOr404(req.params.id);
    return {
      soul,
      skills: listSoulSkills(ctx.db, soul.soulId),
      skillUsage: skillUsageForSoul(ctx.db, soul.soulId),
    };
  });

  app.post<{ Params: { id: string } }>("/souls/:id/evolve", async (req) => {
    soulOr404(req.params.id);
    evolveSoul(ctx, req.params.id);
    return { soul: soulOr404(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/souls/:id/awaken", async (req) => {
    const b = Awaken.parse(req.body);
    awakenSoul(ctx, { soulId: req.params.id, ...b });
    return { soul: soulOr404(req.params.id) };
  });

  app.get<{ Params: { id: string; skill: string } }>(
    "/souls/:id/skills/:skill/proficiency",
    async (req) => {
      soulOr404(req.params.id);
      return { series: proficiencySeries(ctx.db, req.params.id, req.params.skill) };
    },
  );

  // --- memory -------------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/souls/:id/memory", async (req) => {
    soulOr404(req.params.id);
    return {
      persona: personaFor(ctx.db, req.params.id),
      memories: listMemories(ctx.db, { soulId: req.params.id }),
    };
  });

  app.get<{ Params: { id: string } }>("/souls/:id/memory.md", async (req, reply) => {
    const soul = soulOr404(req.params.id);
    return reply
      .type("text/markdown; charset=utf-8")
      .send(renderSoulMarkdown(ctx.db, soul.soulId, soul.name));
  });

  /** Apply the Sovereign's edits to the Markdown view: changed text is edited, removed blocks are pruned. */
  app.put<{ Params: { id: string }; Body: string }>("/souls/:id/memory.md", async (req) => {
    soulOr404(req.params.id);
    const body = typeof req.body === "string" ? req.body : "";
    const events = ctx.log.append(markdownEdits(ctx.db, req.params.id, body));
    return {
      edited: events.filter((e) => e.type === "memory.edited").length,
      pruned: events.filter((e) => e.type === "memory.pruned").length,
    };
  });

  /** The Warden reviews and prunes bad memories. */
  app.post<{ Params: { id: string } }>("/memories/:id/prune", async (req) => {
    const b = Reason.parse(req.body);
    const m = getMemory(ctx.db, req.params.id);
    if (!m) throw new NotFoundError(`unknown memory: ${req.params.id}`);
    ctx.log.append([
      {
        type: "memory.pruned",
        payload: { memoryId: m.memoryId, reason: b.reason },
        actor: { kind: "warden" },
        correlation: m.ownerSoulId ? { soulId: m.ownerSoulId } : {},
      },
    ]);
    return { pruned: m.memoryId };
  });

  /** Copy a private memory into shared town knowledge, keeping provenance. */
  app.post<{ Params: { id: string } }>("/memories/:id/promote", async (req, reply) => {
    const m = getMemory(ctx.db, req.params.id);
    if (!m || m.prunedAt) throw new NotFoundError(`unknown memory: ${req.params.id}`);
    const memoryId = newMemoryId();
    ctx.log.append([
      {
        type: "memory.shared_promoted",
        payload: {
          fromMemoryId: m.memoryId,
          memory: {
            memoryId,
            layer: "town",
            ownerSoulId: null,
            text: m.text,
            tags: m.tags,
            provenance: { ...m.provenance, source: `promoted:${m.memoryId}` },
          },
        },
        actor: { kind: "sovereign" },
      },
    ]);
    return reply.status(201).send({ memoryId });
  });

  app.get("/town/memory", async () => ({
    memories: ctx.db
      .prepare(
        "SELECT memory_id AS memoryId, text FROM memories WHERE layer = 'town' AND pruned_at IS NULL ORDER BY rowid",
      )
      .all(),
  }));
}
