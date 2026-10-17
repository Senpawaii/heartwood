import {
  Correlation,
  type Magicules,
  payloadSchemas,
  type Rank,
  type Species,
} from "@heartwood/protocol";
import type { Db } from "./db.js";
import { defaultRules, type Rules, rankForLevel } from "./rules.js";

export interface SoulView {
  soulId: string;
  name: string;
  species: Species;
  form: string;
  ministryId: string;
  xp: number;
  level: number;
  /** Derived from level at read time; never stored. */
  rank: Rank;
  office: string | null;
  mentorId: string | null;
  status: string;
  currentBodyId: string | null;
  titles: string[];
  magiculesSpent: number;
}

interface SoulRow {
  soul_id: string;
  name: string;
  species: Species;
  form: string;
  ministry_id: string;
  xp: number;
  level: number;
  office: string | null;
  mentor_id: string | null;
  status: string;
  current_body_id: string | null;
  titles: string;
  magicules_spent: number;
}

const toSoul = (r: SoulRow, rules: Rules): SoulView => ({
  soulId: r.soul_id,
  name: r.name,
  species: r.species,
  form: r.form,
  ministryId: r.ministry_id,
  xp: r.xp,
  level: r.level,
  rank: rankForLevel(r.level, rules),
  office: r.office,
  mentorId: r.mentor_id,
  status: r.status,
  currentBodyId: r.current_body_id,
  titles: JSON.parse(r.titles),
  magiculesSpent: r.magicules_spent,
});

export function getSoul(db: Db, soulId: string, rules: Rules = defaultRules): SoulView | undefined {
  const r = db.prepare("SELECT * FROM souls WHERE soul_id = ?").get(soulId) as SoulRow | undefined;
  return r ? toSoul(r, rules) : undefined;
}

export function listSouls(db: Db, rules: Rules = defaultRules): SoulView[] {
  return (db.prepare("SELECT * FROM souls ORDER BY named_at, soul_id").all() as SoulRow[]).map(
    (r) => toSoul(r, rules),
  );
}

export interface DispatchView {
  dispatchId: string;
  warbandId: string;
  soulId: string;
  skills: { name: string; digest: string }[];
  memoryIds: string[];
  bodyId: string | null;
  state: "created" | "running" | "settled";
  outcome: string | null;
}

export function getDispatch(db: Db, dispatchId: string): DispatchView | undefined {
  const r = db.prepare("SELECT * FROM dispatches WHERE dispatch_id = ?").get(dispatchId) as
    | Record<string, string | null>
    | undefined;
  if (!r) return undefined;
  return {
    dispatchId: r.dispatch_id as string,
    warbandId: r.warband_id as string,
    soulId: r.soul_id as string,
    skills: JSON.parse(r.skills as string),
    memoryIds: JSON.parse(r.memory_ids as string),
    bodyId: r.body_id ?? null,
    state: r.state as DispatchView["state"],
    outcome: r.outcome ?? null,
  };
}

export interface BodyView {
  bodyId: string;
  soulId: string;
  dispatchId: string;
  workerRef: string;
  liveness: string | null;
  disposition: string | null;
}

export function getBodyByWorkerRef(db: Db, workerRef: string): BodyView | undefined {
  const r = db.prepare("SELECT * FROM bodies WHERE worker_ref = ?").get(workerRef) as
    | Record<string, string | null>
    | undefined;
  if (!r) return undefined;
  return {
    bodyId: r.body_id as string,
    soulId: r.soul_id as string,
    dispatchId: r.dispatch_id as string,
    workerRef: r.worker_ref as string,
    liveness: r.liveness ?? null,
    disposition: r.disposition ?? null,
  };
}

export function getBody(db: Db, bodyId: string): (BodyView & { agent: string }) | undefined {
  const r = db.prepare("SELECT * FROM bodies WHERE body_id = ?").get(bodyId) as
    | Record<string, string | null>
    | undefined;
  if (!r) return undefined;
  return { ...getBodyByWorkerRef(db, r.worker_ref as string)!, agent: r.agent as string };
}

export interface SkillUsageStat {
  skill: string;
  uses: number;
  succeeded: number;
  failed: number;
  unknown: number;
  /** succeeded / (succeeded + failed); null when no outcome is known. */
  successRate: number | null;
  /** Uses recorded as "injected" only (not transcript-verified); the UI labels these. */
  injectedOnly: number;
}

const usageSql = `SELECT skill_name AS skill, COUNT(*) AS uses,
  SUM(outcome = 'succeeded') AS succeeded, SUM(outcome = 'failed') AS failed, SUM(outcome = 'unknown') AS unknown,
  SUM(evidence = 'injected') AS injectedOnly FROM skill_usage`;

type UsageRow = Omit<SkillUsageStat, "successRate">;
const withRate = (r: UsageRow): SkillUsageStat => ({
  ...r,
  successRate: r.succeeded + r.failed === 0 ? null : r.succeeded / (r.succeeded + r.failed),
});

/** Per-agent skill usage, most used first. */
export function skillUsageForSoul(db: Db, soulId: string): SkillUsageStat[] {
  return (
    db
      .prepare(`${usageSql} WHERE soul_id = ? GROUP BY skill_name ORDER BY uses DESC, skill_name`)
      .all(soulId) as UsageRow[]
  ).map(withRate);
}

/** Town-wide skill usage, most used first. */
export function townSkillUsage(db: Db): SkillUsageStat[] {
  return (
    db.prepare(`${usageSql} GROUP BY skill_name ORDER BY uses DESC, skill_name`).all() as UsageRow[]
  ).map(withRate);
}

export interface ProficiencyPoint {
  at: string;
  uses: number;
  score: number;
}

export function proficiencyOf(
  db: Db,
  soulId: string,
  skill: string,
): { score: number; uses: number } | undefined {
  return db
    .prepare("SELECT score, uses FROM proficiency WHERE soul_id = ? AND skill_name = ?")
    .get(soulId, skill) as { score: number; uses: number } | undefined;
}

/** Proficiency over time for one agent and skill. */
export function proficiencySeries(db: Db, soulId: string, skill: string): ProficiencyPoint[] {
  return db
    .prepare(
      "SELECT at, uses, score FROM proficiency_points WHERE soul_id = ? AND skill_name = ? ORDER BY seq",
    )
    .all(soulId, skill) as ProficiencyPoint[];
}

export function townBudget(db: Db): Magicules | undefined {
  const r = db
    .prepare(
      "SELECT tokens, compute_seconds AS computeSeconds, cost_usd AS costUsd FROM budgets WHERE scope = 'town'",
    )
    .get() as { tokens: number; computeSeconds: number; costUsd: number | null } | undefined;
  return r
    ? {
        tokens: r.tokens,
        computeSeconds: r.computeSeconds,
        ...(r.costUsd !== null ? { costUsd: r.costUsd } : {}),
      }
    : undefined;
}

export interface WarbandView {
  warbandId: string;
  objective: string;
  foremanSoulId: string;
  groupRef: string | null;
  status: string;
  members: { soulId: string; role: string }[];
}

interface WarbandRow {
  warband_id: string;
  objective: string;
  foreman_soul_id: string;
  group_ref: string | null;
  status: string;
}

function withMembers(db: Db, r: WarbandRow): WarbandView {
  const members = db
    .prepare(
      "SELECT soul_id AS soulId, role FROM warband_members WHERE warband_id = ? ORDER BY rowid",
    )
    .all(r.warband_id) as { soulId: string; role: string }[];
  return {
    warbandId: r.warband_id,
    objective: r.objective,
    foremanSoulId: r.foreman_soul_id,
    groupRef: r.group_ref,
    status: r.status,
    members,
  };
}

export function getWarband(db: Db, warbandId: string): WarbandView | undefined {
  const r = db.prepare("SELECT * FROM warbands WHERE warband_id = ?").get(warbandId) as
    | WarbandRow
    | undefined;
  return r ? withMembers(db, r) : undefined;
}

export function listWarbands(db: Db): WarbandView[] {
  return (db.prepare("SELECT * FROM warbands ORDER BY rowid").all() as WarbandRow[]).map((r) =>
    withMembers(db, r),
  );
}

export function listMinistries(db: Db): { ministryId: string; name: string; kind: string }[] {
  return db
    .prepare("SELECT ministry_id AS ministryId, name, kind FROM ministries ORDER BY rowid")
    .all() as {
    ministryId: string;
    name: string;
    kind: string;
  }[];
}

export interface SoulSkillView {
  name: string;
  digest: string;
  source: string;
  rank: string | null;
  proficiency: number | null;
}

/** Skills a soul has absorbed, with the skill's rank and the soul's own proficiency. */
export function listSoulSkills(db: Db, soulId: string): SoulSkillView[] {
  return db
    .prepare(
      `SELECT s.name, s.digest, s.source, r.rank AS rank, p.score AS proficiency
         FROM soul_skills s
         LEFT JOIN skill_ranks r ON r.name = s.name AND r.digest = s.digest
         LEFT JOIN proficiency p ON p.soul_id = s.soul_id AND p.skill_name = s.name
         WHERE s.soul_id = ? ORDER BY s.name`,
    )
    .all(soulId) as SoulSkillView[];
}

/** Locate the question.asked event for a question id (to answer it on the right group). */
export function getQuestion(
  db: Db,
  questionId: string,
):
  | { questionId: string; groupRef: string; messageId: string; text: string; answered: boolean }
  | undefined {
  const r = db
    .prepare(
      "SELECT payload, correlation FROM events WHERE type = 'question.asked' AND json_extract(payload, '$.questionId') = ?",
    )
    .get(questionId) as { payload: string; correlation: string } | undefined;
  if (!r) return undefined;
  const p = payloadSchemas["question.asked"].parse(JSON.parse(r.payload));
  const { groupRef } = Correlation.parse(JSON.parse(r.correlation));
  if (!p.messageId || !groupRef) return undefined;
  const answered = !!db
    .prepare(
      "SELECT 1 FROM events WHERE type = 'question.answered' AND json_extract(payload, '$.questionId') = ?",
    )
    .get(questionId);
  return { questionId, groupRef, messageId: p.messageId, text: p.text, answered };
}
