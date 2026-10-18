import {
  type BackendMessage,
  type Db,
  type EventLog,
  FakeBackend,
  FakeLab,
  type LabPort,
  openDb,
  type WorkerBackend,
} from "@heartwood/core";
import type { EventPayloads, EventType } from "@heartwood/protocol";
import type { FastifyInstance } from "fastify";
import { createDaemon, type Daemon } from "./daemon.js";

export interface Booted {
  daemon: Daemon;
  app: FastifyInstance;
  db: Db;
  backend: FakeBackend;
  lab: FakeLab;
}

export async function boot(
  o: {
    backend?: WorkerBackend;
    lab?: LabPort;
    token?: string;
    maxGroups?: number;
    defaultAgent?: string;
    db?: Db;
  } = {},
): Promise<Booted> {
  const db: Db = o.db ?? openDb();
  const backend = (o.backend ?? new FakeBackend()) as FakeBackend;
  const lab = (o.lab ?? new FakeLab()) as FakeLab;
  const daemon = await createDaemon({
    db,
    backend,
    lab,
    token: o.token,
    defaultAgent: o.defaultAgent,
    coordinator: {
      maxConcurrentGroups: o.maxGroups ?? 4,
      livenessIntervalMs: 1e9,
      baseBackoffMs: 5,
    },
  });
  return { daemon, app: daemon.app, db, backend, lab };
}

export const json = async (
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) => {
  const res = await app.inject({ method, url, payload: payload as object, headers });
  let body: any;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
};

export const doneMsg = (
  id: string,
  workerRef: string,
  outcome: "succeeded" | "failed" = "succeeded",
): BackendMessage => ({
  id,
  kind: "done",
  rawType: "worker_done",
  workerRef,
  outcome,
  text: "finished the task",
});

export const brief = {
  target: "the parser module",
  change: "fix unicode escape handling",
  constraints: "no new dependencies",
  ownership: "src/parser only",
  acceptance: "parser tests pass",
};

/** A town with one ministry, a foreman, and a worker soul. */
export async function seedTown(b: Booted) {
  const m = await json(b.app, "POST", "/ministries", {
    name: "Construction",
    kind: "construction",
  });
  const mk = async (name: string) =>
    (
      await json(b.app, "POST", "/souls", {
        name,
        species: "dwarf",
        ministryId: m.body.ministryId,
        persona: `${name} is careful and precise.`,
      })
    ).body.soul.soulId as string;
  const foreman = await mk("Oakhand");
  const worker = await mk("Birchfist");
  return { ministryId: m.body.ministryId as string, foreman, worker };
}

export async function formWarband(b: Booted, foreman: string, members: string[]) {
  const r = await json(b.app, "POST", "/warbands", {
    objective: "ship the parser fix",
    foremanSoulId: foreman,
    memberSoulIds: members,
  });
  return r.body.warband as { warbandId: string; groupRef: string };
}

export type { Daemon };

/** Resolves once `cond` holds, re-checking after every committed event (no polling, no timers). */
export function until(log: EventLog, cond: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (cond()) return resolve();
    const off = log.subscribe(() => {
      if (cond()) {
        off();
        resolve();
      }
    });
  });
}

/** Payloads of every event of one type, typed by that event type. */
export function payloads<T extends EventType>(log: EventLog, type: T): EventPayloads[T][] {
  // read({ types: [type] }) only returns events of that type, so each payload has that type's shape
  return log.read({ types: [type] }).map((e) => e.payload as EventPayloads[T]);
}

/** States of every dispatch, in creation order. */
export function dispatchStates(db: Db): string[] {
  const rows: { state: string }[] = db
    .prepare("SELECT state FROM dispatches ORDER BY rowid")
    .all() as { state: string }[]; // fixed SELECT shape
  return rows.map((r) => r.state);
}
