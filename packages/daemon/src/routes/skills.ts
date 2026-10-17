import {
  absorbSkill,
  analyzeSkill,
  evolveSkill,
  getSoul,
  NotFoundError,
  townSkillUsage,
} from "@heartwood/core";
import { PinnedSkill } from "@heartwood/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DaemonContext } from "../daemon.js";

const Absorb = z.object({ name: z.string().min(1) });

export function registerSkillRoutes(app: FastifyInstance, d: DaemonContext): void {
  const { ctx } = d;

  /** Skills the Lab offers. 501 until a Lab adapter is configured. */
  app.get("/skills", async () => ({ skills: await ctx.lab.listSkills() }));

  /** Town-wide usage: most used first, with success rate. `injectedOnly` marks usage not verified by transcript. */
  app.get("/skills/usage", async () => ({ usage: townSkillUsage(ctx.db) }));

  app.get("/skills/ranks", async () => ({
    ranks: ctx.db
      .prepare(
        "SELECT name, digest, rank, score, thresholds_version AS thresholdsVersion FROM skill_ranks ORDER BY name, digest",
      )
      .all(),
  }));

  /** Absorb: the soul acquires a skill from the Lab, pinned by digest. */
  app.post<{ Params: { id: string } }>("/souls/:id/skills", async (req, reply) => {
    const b = Absorb.parse(req.body);
    if (!getSoul(ctx.db, req.params.id, ctx.rules))
      throw new NotFoundError(`unknown soul: ${req.params.id}`);
    const skill = await absorbSkill(ctx, { soulId: req.params.id, name: b.name });
    return reply.status(201).send({ skill });
  });

  /** Analyze: benchmark a skill and derive its rank. */
  app.post("/skills/analyze", async (req) => {
    const b = PinnedSkill.parse(req.body);
    const { evidence, rank } = await analyzeSkill(ctx, { name: b.name, digest: b.digest });
    // rank is absent when the benchmark was inconclusive (too few trials / too many infra errors)
    return { evidence, rank: rank ?? null };
  });

  /** Evolve: propose a new version and promote it only on proof from a comparison. */
  app.post("/skills/evolve", async (req) => {
    const b = PinnedSkill.parse(req.body);
    const out = await evolveSkill(ctx, { name: b.name, digest: b.digest });
    return { promoted: out.promoted, candidate: out.candidate, comparison: out.comparison };
  });
}
