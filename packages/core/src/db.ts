import Database from "better-sqlite3";

export type Db = Database.Database;

/** Ordered migrations; index+1 = schema version stored in `PRAGMA user_version`. */
const migrations: string[] = [
  `
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    v INTEGER NOT NULL,
    actor TEXT NOT NULL,
    correlation TEXT NOT NULL,
    caused_by TEXT,
    message_id TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX events_type ON events(type, seq);
  -- replayed backend batches must not produce duplicate events
  CREATE UNIQUE INDEX events_message ON events(type, message_id) WHERE message_id IS NOT NULL;

  CREATE TABLE souls (
    soul_id TEXT PRIMARY KEY, name TEXT NOT NULL, species TEXT NOT NULL, ministry_id TEXT NOT NULL,
    persona TEXT NOT NULL, form TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1,
    office TEXT, mentor_id TEXT, status TEXT NOT NULL DEFAULT 'active', current_body_id TEXT,
    magicules_spent REAL NOT NULL DEFAULT 0, titles TEXT NOT NULL DEFAULT '[]', named_at TEXT NOT NULL
  );
  CREATE TABLE ministries (ministry_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE TABLE xp_ledger (
    seq INTEGER PRIMARY KEY, soul_id TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL,
    dispatch_id TEXT, warband_id TEXT
  );
  CREATE TABLE budgets (scope TEXT NOT NULL, soul_id TEXT NOT NULL DEFAULT '', tokens REAL NOT NULL,
    compute_seconds REAL NOT NULL, cost_usd REAL, at TEXT NOT NULL, PRIMARY KEY (scope, soul_id));

  CREATE TABLE bodies (
    body_id TEXT PRIMARY KEY, soul_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, worker_ref TEXT NOT NULL, worker_locator TEXT,
    agent TEXT NOT NULL, model TEXT, worktree TEXT NOT NULL, liveness TEXT, disposition TEXT, spawned_at TEXT NOT NULL
  );
  CREATE INDEX bodies_worker ON bodies(worker_ref);

  CREATE TABLE warbands (
    warband_id TEXT PRIMARY KEY, objective TEXT NOT NULL, foreman_soul_id TEXT NOT NULL,
    group_ref TEXT, status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE warband_members (warband_id TEXT NOT NULL, soul_id TEXT NOT NULL, role TEXT NOT NULL,
    PRIMARY KEY (warband_id, soul_id));

  CREATE TABLE dispatches (
    dispatch_id TEXT PRIMARY KEY, warband_id TEXT NOT NULL, soul_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
    skills TEXT NOT NULL, memory_ids TEXT NOT NULL, task_ref TEXT, body_id TEXT,
    state TEXT NOT NULL DEFAULT 'created', outcome TEXT, summary TEXT, created_at TEXT NOT NULL
  );

  CREATE TABLE soul_skills (soul_id TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL, source TEXT NOT NULL,
    absorbed_at TEXT NOT NULL, PRIMARY KEY (soul_id, name));
  CREATE TABLE skill_results (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL, result_ref TEXT NOT NULL,
    score REAL NOT NULL);
  CREATE TABLE skill_ranks (name TEXT NOT NULL, digest TEXT NOT NULL, rank TEXT NOT NULL, score REAL NOT NULL,
    thresholds_version TEXT NOT NULL, PRIMARY KEY (name, digest));
  CREATE TABLE skill_usage (
    seq INTEGER PRIMARY KEY, at TEXT NOT NULL, soul_id TEXT NOT NULL, skill_name TEXT NOT NULL, digest TEXT NOT NULL,
    dispatch_id TEXT NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL
  );
  CREATE INDEX skill_usage_soul ON skill_usage(soul_id, skill_name);
  CREATE TABLE proficiency (soul_id TEXT NOT NULL, skill_name TEXT NOT NULL, ewma REAL NOT NULL, known INTEGER NOT NULL,
    uses INTEGER NOT NULL, successes INTEGER NOT NULL, score REAL NOT NULL, PRIMARY KEY (soul_id, skill_name));
  CREATE TABLE proficiency_points (seq INTEGER NOT NULL, at TEXT NOT NULL, soul_id TEXT NOT NULL, skill_name TEXT NOT NULL,
    uses INTEGER NOT NULL, score REAL NOT NULL, PRIMARY KEY (seq, soul_id, skill_name));

  -- small durable adapter state (e.g. a provisioned identity); not event-sourced
  CREATE TABLE kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));

  -- ephemeral: heartbeats are not events
  CREATE TABLE worker_heartbeats (worker_ref TEXT PRIMARY KEY, at TEXT NOT NULL);

  CREATE TABLE memories (
    memory_id TEXT PRIMARY KEY, layer TEXT NOT NULL, owner_soul_id TEXT, text TEXT NOT NULL, tags TEXT NOT NULL,
    provenance TEXT NOT NULL, created_at TEXT NOT NULL, pruned_at TEXT, pruned_reason TEXT, distilled_at TEXT
  );
  CREATE INDEX memories_owner ON memories(owner_soul_id, layer);
  CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, tokenize='porter unicode61');
  `,
];

export function openDb(path = ":memory:"): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v] as string);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Tables that are rebuilt from the event log (everything except `events` and ephemeral state). */
export const projectionTables = [
  "souls",
  "ministries",
  "xp_ledger",
  "budgets",
  "bodies",
  "warbands",
  "warband_members",
  "dispatches",
  "soul_skills",
  "skill_results",
  "skill_ranks",
  "skill_usage",
  "proficiency",
  "proficiency_points",
  "memories",
  "memories_fts",
] as const;
