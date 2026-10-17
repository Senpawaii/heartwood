import type { HeartwoodEvent } from "@heartwood/protocol";
import type { Db } from "./db.js";
import { projectionTables } from "./db.js";
import { applyMemoryProjection } from "./memory/projection.js";
import { emptyProficiency, nextProficiency, type ProficiencyState, type Rules } from "./rules.js";

/** Update read models for one event. Runs inside the append transaction. */
export function applyProjections(db: Db, e: HeartwoodEvent, rules: Rules): void {
  switch (e.type) {
    case "town.ministry_created":
      db.prepare("INSERT OR REPLACE INTO ministries VALUES (?, ?, ?)").run(
        e.payload.ministryId,
        e.payload.name,
        e.payload.kind,
      );
      break;
    case "town.budget_snapshot": {
      const m = e.payload.magicules;
      db.prepare("INSERT OR REPLACE INTO budgets VALUES (?, ?, ?, ?, ?, ?)").run(
        e.payload.scope,
        e.payload.soulId ?? "",
        m.tokens,
        m.computeSeconds,
        m.costUsd ?? null,
        e.at,
      );
      break;
    }
    case "soul.named": {
      const p = e.payload;
      db.prepare(
        `INSERT INTO souls (soul_id, name, species, ministry_id, persona, form, magicules_spent, named_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.soulId,
        p.name,
        p.species,
        p.ministryId,
        p.persona,
        p.species,
        p.magiculesSpent,
        e.at,
      );
      break;
    }
    case "soul.xp_gained":
      db.prepare("UPDATE souls SET xp = xp + ? WHERE soul_id = ?").run(
        e.payload.amount,
        e.payload.soulId,
      );
      db.prepare("INSERT INTO xp_ledger VALUES (?, ?, ?, ?, ?, ?)").run(
        e.seq,
        e.payload.soulId,
        e.payload.amount,
        e.payload.reason,
        e.payload.dispatchId ?? null,
        e.correlation.warbandId ?? null,
      );
      break;
    case "soul.leveled":
      db.prepare("UPDATE souls SET level = ? WHERE soul_id = ?").run(
        e.payload.toLevel,
        e.payload.soulId,
      );
      break;
    case "soul.evolved":
      db.prepare("UPDATE souls SET form = ? WHERE soul_id = ?").run(
        e.payload.toForm,
        e.payload.soulId,
      );
      break;
    case "soul.awakened":
      db.prepare("UPDATE souls SET titles = json_insert(titles, '$[#]', ?) WHERE soul_id = ?").run(
        e.payload.title,
        e.payload.soulId,
      );
      break;
    case "soul.mentor_assigned":
      db.prepare("UPDATE souls SET mentor_id = ? WHERE soul_id = ?").run(
        e.payload.mentorId,
        e.payload.soulId,
      );
      break;
    case "soul.office_assigned":
      db.prepare("UPDATE souls SET office = ? WHERE soul_id = ?").run(
        e.payload.office,
        e.payload.soulId,
      );
      break;
    case "soul.retired":
      db.prepare(
        "UPDATE souls SET status = 'retired', current_body_id = NULL WHERE soul_id = ?",
      ).run(e.payload.soulId);
      break;
    case "soul.reincarnated":
    case "soul.resurrected":
      db.prepare("UPDATE souls SET current_body_id = ? WHERE soul_id = ?").run(
        e.type === "soul.reincarnated" ? e.payload.toBodyId : e.payload.newBodyId,
        e.payload.soulId,
      );
      break;

    case "body.spawned": {
      const p = e.payload;
      db.prepare(
        `INSERT INTO bodies (body_id, soul_id, dispatch_id, orca_dispatch_id, orca_terminal_handle, agent, model, worktree, spawned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.bodyId,
        p.soulId,
        p.dispatchId,
        p.orcaDispatchId,
        p.orcaTerminalHandle ?? null,
        p.agent,
        p.model ?? null,
        p.worktree,
        e.at,
      );
      db.prepare("UPDATE souls SET current_body_id = ? WHERE soul_id = ?").run(p.bodyId, p.soulId);
      break;
    }
    case "body.liveness_changed":
      db.prepare("UPDATE bodies SET liveness = ? WHERE body_id = ?").run(
        e.payload.to,
        e.payload.bodyId,
      );
      break;
    case "body.released":
    case "body.retained":
      db.prepare("UPDATE bodies SET disposition = ? WHERE body_id = ?").run(
        e.type === "body.released" ? "release" : "retain",
        e.payload.bodyId,
      );
      if (e.type === "body.released")
        db.prepare("UPDATE souls SET current_body_id = NULL WHERE current_body_id = ?").run(
          e.payload.bodyId,
        );
      break;
    case "body.reused":
      db.prepare("UPDATE bodies SET disposition = 'reuse', dispatch_id = ? WHERE body_id = ?").run(
        e.payload.dispatchId,
        e.payload.bodyId,
      );
      break;

    case "warband.formed": {
      const p = e.payload;
      db.prepare(
        "INSERT INTO warbands (warband_id, objective, foreman_soul_id) VALUES (?, ?, ?)",
      ).run(p.warbandId, p.objective, p.foremanSoulId);
      for (const m of p.members)
        db.prepare("INSERT OR REPLACE INTO warband_members VALUES (?, ?, ?)").run(
          p.warbandId,
          m.soulId,
          m.role,
        );
      break;
    }
    case "warband.member_assigned":
      db.prepare("INSERT OR REPLACE INTO warband_members VALUES (?, ?, ?)").run(
        e.payload.warbandId,
        e.payload.soulId,
        e.payload.role,
      );
      break;
    case "warband.disbanded":
      db.prepare("UPDATE warbands SET status = 'disbanded' WHERE warband_id = ?").run(
        e.payload.warbandId,
      );
      break;
    case "orca.run_created":
      db.prepare("UPDATE warbands SET run_id = ? WHERE warband_id = ?").run(
        e.payload.runId,
        e.payload.warbandId,
      );
      break;

    case "dispatch.created": {
      const p = e.payload;
      db.prepare(
        `INSERT INTO dispatches (dispatch_id, warband_id, soul_id, spec_hash, skills, memory_ids, orca_task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.dispatchId,
        p.warbandId,
        p.soulId,
        p.specHash,
        JSON.stringify(p.skills),
        JSON.stringify(p.memoryIds),
        p.orcaTaskId ?? null,
        e.at,
      );
      break;
    }
    case "dispatch.started":
      db.prepare("UPDATE dispatches SET state = 'running', body_id = ? WHERE dispatch_id = ?").run(
        e.payload.bodyId,
        e.payload.dispatchId,
      );
      break;
    case "dispatch.settled":
      db.prepare(
        "UPDATE dispatches SET state = 'settled', outcome = ?, summary = ? WHERE dispatch_id = ?",
      ).run(e.payload.outcome, e.payload.summary ?? null, e.payload.dispatchId);
      break;

    case "skill.absorbed":
      db.prepare("INSERT OR REPLACE INTO soul_skills VALUES (?, ?, ?, ?, ?)").run(
        e.payload.soulId,
        e.payload.skill.name,
        e.payload.skill.digest,
        e.payload.source,
        e.at,
      );
      break;
    case "skill.forgotten":
      db.prepare("DELETE FROM soul_skills WHERE soul_id = ? AND name = ?").run(
        e.payload.soulId,
        e.payload.name,
      );
      break;
    case "skill.analyzed":
      db.prepare("INSERT INTO skill_results VALUES (?, ?, ?, ?, ?)").run(
        e.seq,
        e.payload.skill.name,
        e.payload.skill.digest,
        e.payload.resultRef,
        e.payload.score,
      );
      break;
    case "skill.ranked":
      db.prepare("INSERT OR REPLACE INTO skill_ranks VALUES (?, ?, ?, ?, ?)").run(
        e.payload.skill.name,
        e.payload.skill.digest,
        e.payload.rank,
        e.payload.score,
        e.payload.thresholdsVersion,
      );
      break;
    case "skill.used":
      projectSkillUsage(db, e, rules);
      break;
    default:
      break;
  }
  applyMemoryProjection(db, e);
}

function projectSkillUsage(
  db: Db,
  e: Extract<HeartwoodEvent, { type: "skill.used" }>,
  rules: Rules,
): void {
  const p = e.payload;
  db.prepare("INSERT INTO skill_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    e.seq,
    e.at,
    p.soulId,
    p.skill.name,
    p.skill.digest,
    p.dispatchId,
    p.outcome,
    p.evidence,
  );
  const row = db
    .prepare(
      "SELECT ewma, known, uses, successes, score FROM proficiency WHERE soul_id = ? AND skill_name = ?",
    )
    .get(p.soulId, p.skill.name) as ProficiencyState | undefined;
  const next = nextProficiency(row ?? emptyProficiency, p.outcome, rules);
  db.prepare("INSERT OR REPLACE INTO proficiency VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    p.soulId,
    p.skill.name,
    next.ewma,
    next.known,
    next.uses,
    next.successes,
    next.score,
  );
  db.prepare("INSERT INTO proficiency_points VALUES (?, ?, ?, ?, ?, ?)").run(
    e.seq,
    e.at,
    p.soulId,
    p.skill.name,
    next.uses,
    next.score,
  );
}

/** Drop all read models and replay the log. Heartbeats (ephemeral) are untouched. */
export function rebuildProjections(db: Db, events: Iterable<HeartwoodEvent>, rules: Rules): void {
  db.transaction(() => {
    for (const t of projectionTables) db.exec(`DELETE FROM ${t}`);
    for (const e of events) applyProjections(db, e, rules);
  })();
}
