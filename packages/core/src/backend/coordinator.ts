import type { Ctx } from "../context.js";
import { settleDispatch } from "../dispatch.js";
import { getBody, getBodyByWorkerRef, getDispatch } from "../queries.js";
import {
  type BackendMessage,
  type Disposition,
  type SettleResult,
  WAKE_KINDS,
  type WorkerBackend,
} from "./backend.js";

export class GroupLimitError extends Error {}

export interface CoordinatorOptions {
  /** Cap on concurrently watched groups (each holds one long poll open). */
  maxConcurrentGroups?: number;
  /** Disposition applied to a worker once its dispatch is settled. Reuse is chosen by the dispatcher, not here. */
  disposition?: (outcome: "succeeded" | "failed" | "abandoned") => Disposition;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  livenessIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
}

interface Watch {
  abort: AbortController;
  done: Promise<void>;
}

const sleepAbortable = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Sole consumer of each group's mailbox. Translates messages into Heartwood events, commits them
 * (with their consequences) in one transaction, and only then carries the batch token forward as
 * an ack. A crash before the ack makes the backend replay the batch; the (type, messageId) unique
 * index makes that idempotent. Knows nothing about any particular backend.
 */
export class BackendCoordinator {
  private watches = new Map<string, Watch>();
  private failures = new Map<string, number>();
  /** Last committed batch token per group, acknowledged on the next poll. */
  private pendingAck = new Map<string, string>();
  private readonly max: number;
  private readonly disposition: NonNullable<CoordinatorOptions["disposition"]>;
  private readonly sleep: NonNullable<CoordinatorOptions["sleep"]>;
  private readonly now: () => Date;

  constructor(
    private readonly ctx: Ctx,
    private readonly backend: WorkerBackend,
    private readonly opts: CoordinatorOptions = {},
  ) {
    this.max = opts.maxConcurrentGroups ?? 4;
    this.disposition = opts.disposition ?? (() => "release");
    this.sleep = opts.sleep ?? sleepAbortable;
    this.now = opts.now ?? (() => new Date());
  }

  /** One poll/translate/commit cycle. Returns false if the backend failed (recorded, not thrown). */
  async pollOnce(
    groupRef: string,
    o: { wait?: boolean; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    try {
      const ack = this.pendingAck.get(groupRef);
      const batch = await this.backend.poll(groupRef, {
        wake: WAKE_KINDS,
        wait: o.wait ?? false,
        ack,
        signal: o.signal,
      });
      if (ack) this.pendingAck.delete(groupRef);
      const settled = this.ingest(groupRef, batch.messages);
      if (batch.token) this.pendingAck.set(groupRef, batch.token);
      this.failures.set(groupRef, 0);
      for (const bodyId of settled) await this.applyDisposition(groupRef, bodyId);
      return true;
    } catch (err) {
      if (o.signal?.aborted) return true;
      const n = (this.failures.get(groupRef) ?? 0) + 1;
      this.failures.set(groupRef, n);
      this.ctx.log.append([
        {
          type: "backend.poll_failed",
          payload: {
            groupRef,
            consecutiveFailures: n,
            error: err instanceof Error ? err.message : String(err),
          },
          actor: { kind: "backend" },
          correlation: { groupRef },
        },
      ]);
      return false;
    }
  }

  /** Acknowledge the last committed batch without waiting (used on stop). Best effort. */
  private async flushAck(groupRef: string): Promise<void> {
    const ack = this.pendingAck.get(groupRef);
    if (!ack) return;
    try {
      await this.backend.poll(groupRef, { wake: WAKE_KINDS, wait: false, ack });
      this.pendingAck.delete(groupRef);
    } catch {
      // The backend replays the batch; the (type, messageId) index makes that harmless.
    }
  }

  /** Translate + commit one batch atomically. Returns ids of bodies whose dispatch was just settled. */
  private ingest(groupRef: string, messages: BackendMessage[]): string[] {
    const settledBodies: string[] = [];
    this.ctx.log.transaction(() => {
      const real = messages.filter((m) => m.kind !== "heartbeat");
      const touch = this.ctx.db.prepare("INSERT OR REPLACE INTO worker_heartbeats VALUES (?, ?)");
      for (const m of messages)
        if (m.kind === "heartbeat" && m.workerRef) touch.run(m.workerRef, this.now().toISOString());
      if (real.length === 0) return;
      this.ctx.log.append([
        {
          type: "backend.mailbox_batch",
          payload: {
            groupRef,
            messageIds: real.map((m) => m.id),
            heartbeatsDropped: messages.length - real.length,
            messageId: real[0]?.id,
          },
          actor: { kind: "backend" },
          correlation: { groupRef },
        },
      ]);
      for (const m of real) {
        const body = m.workerRef ? getBodyByWorkerRef(this.ctx.db, m.workerRef) : undefined;
        const correlation = {
          groupRef,
          ...(body ? { soulId: body.soulId, dispatchId: body.dispatchId } : {}),
        };
        const actor = { kind: "backend" as const };
        // Each branch appends idempotently; replayed messages yield no events.
        if (m.kind === "rejected" && m.rejection) {
          // The backend refused this lifecycle message (e.g. stale/unknown worker): it settles nothing.
          this.ctx.log.append([
            {
              type: "backend.message_rejected",
              payload: {
                groupRef,
                messageId: m.id,
                messageType: m.rawType,
                code: m.rejection.code,
                reason: m.rejection.reason,
              },
              actor,
              correlation,
            },
          ]);
        } else if (m.kind === "done") {
          const appended = this.ctx.log.append([
            {
              type: "backend.worker_done",
              payload: {
                groupRef,
                messageId: m.id,
                workerRef: m.workerRef ?? "",
                outcome: m.outcome ?? "failed",
                summary: m.text,
              },
              actor,
              correlation,
            },
          ]);
          const done = appended[0];
          if (
            done &&
            body &&
            settleDispatch(this.ctx, {
              dispatchId: body.dispatchId,
              outcome: m.outcome === "succeeded" ? "succeeded" : "failed",
              summary: m.text,
              causedBy: done.id,
            })
          )
            settledBodies.push(body.bodyId);
        } else if (m.kind === "escalation") {
          this.ctx.log.append([
            {
              type: "escalation.raised",
              payload: {
                escalationId: `esc_${m.id}`,
                dispatchId: body?.dispatchId,
                from: body
                  ? { kind: "soul", id: body.soulId }
                  : { kind: "backend", id: m.workerRef },
                level: "foreman",
                reason: m.text ?? "(no reason given)",
                messageId: m.id,
              },
              actor,
              correlation,
            },
          ]);
        } else if (m.kind === "question") {
          this.ctx.log.append([
            {
              type: "question.asked",
              payload: {
                questionId: `q_${m.id}`,
                dispatchId: body?.dispatchId,
                text: m.text ?? "",
                messageId: m.id,
              },
              actor,
              correlation,
            },
          ]);
        } else {
          this.ctx.log.append([
            {
              type: "backend.unknown_message",
              payload: { groupRef, messageId: m.id, messageType: m.rawType },
              actor,
              correlation: { groupRef },
            },
          ]);
        }
      }
    });
    return settledBodies;
  }

  /** Settle the worker and record what the backend actually did. Retried by reconcile() on failure. */
  private async applyDisposition(groupRef: string, bodyId: string): Promise<void> {
    const body = getBody(this.ctx.db, bodyId);
    if (!body || body.disposition) return;
    const d = getDispatch(this.ctx.db, body.dispatchId);
    if (!d || d.state !== "settled") return;
    const choice = this.disposition(
      (d.outcome ?? "failed") as "succeeded" | "failed" | "abandoned",
    );
    let result: SettleResult;
    try {
      result = await this.backend.settleWorker(body.workerRef, choice);
    } catch {
      return; // reconcile() will retry
    }
    if (result.state === "pending") return; // still releasing; settleWorker is idempotent, retry later
    const correlation = { groupRef, soulId: body.soulId };
    this.ctx.log.append([
      result.state === "released"
        ? { type: "body.released", payload: { bodyId }, actor: { kind: "daemon" }, correlation }
        : {
            type: "body.retained",
            payload: { bodyId, reason: result.reason },
            actor: { kind: "daemon" },
            correlation,
          },
    ]);
  }

  /**
   * Liveness + contract reconciliation for a group. Drains the mailbox first (so a `done` that
   * raced with exit wins), records liveness changes, abandons dispatches only on positive proof
   * of exit, and finishes any disposition that was not applied.
   */
  async reconcile(groupRef: string): Promise<void> {
    if (!(await this.pollOnce(groupRef, { wait: false }))) return;
    const workers = await this.backend.listWorkers(groupRef);
    for (const w of workers) {
      const body = getBodyByWorkerRef(this.ctx.db, w.workerRef);
      if (!body) continue;
      if (body.liveness !== w.liveness) {
        this.ctx.log.append([
          {
            type: "body.liveness_changed",
            payload: {
              bodyId: body.bodyId,
              from: (body.liveness ?? undefined) as never,
              to: w.liveness,
            },
            actor: { kind: "backend" },
            correlation: { groupRef, soulId: body.soulId },
          },
        ]);
      }
      if (w.liveness === "exited") {
        const d = getDispatch(this.ctx.db, body.dispatchId);
        if (d && d.state !== "settled") {
          settleDispatch(this.ctx, {
            dispatchId: d.dispatchId,
            outcome: "abandoned",
            summary: "worker exited without reporting done",
          });
        }
      }
      await this.applyDisposition(groupRef, body.bodyId);
    }
  }

  /** Begin watching a group (long-poll loop with backoff). Throws GroupLimitError at the cap. */
  start(groupRef: string): void {
    if (this.watches.has(groupRef)) return;
    if (this.watches.size >= this.max)
      throw new GroupLimitError(`already watching ${this.max} groups`);
    const abort = new AbortController();
    this.watches.set(groupRef, { abort, done: this.loop(groupRef, abort.signal) });
  }

  async stop(groupRef: string): Promise<void> {
    const w = this.watches.get(groupRef);
    if (!w) return;
    w.abort.abort();
    await w.done;
    await this.flushAck(groupRef);
    this.watches.delete(groupRef);
  }

  /** A group is finished: stop watching it and let the backend release its group-level resources. */
  async close(groupRef: string): Promise<void> {
    await this.stop(groupRef);
    await this.backend.closeGroup(groupRef);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.watches.keys()].map((g) => this.stop(g)));
  }

  get watching(): string[] {
    return [...this.watches.keys()];
  }

  /**
   * After a daemon restart: resume watching every active warband's group, up to the cap.
   * Unacked batches replay on the first poll. Returns the groups that did not fit under the cap.
   */
  resume(): { started: string[]; deferred: string[] } {
    const groups = this.ctx.db
      .prepare(
        "SELECT group_ref AS g FROM warbands WHERE status = 'active' AND group_ref IS NOT NULL ORDER BY rowid",
      )
      .all() as { g: string }[];
    const started: string[] = [];
    const deferred: string[] = [];
    for (const { g } of groups) {
      if (this.watches.size >= this.max && !this.watches.has(g)) deferred.push(g);
      else {
        this.start(g);
        started.push(g);
      }
    }
    return { started, deferred };
  }

  private async loop(groupRef: string, signal: AbortSignal): Promise<void> {
    const every = this.opts.livenessIntervalMs ?? 15_000;
    let lastReconcile = 0;
    while (!signal.aborted) {
      const ok = await this.pollOnce(groupRef, { wait: true, signal });
      if (signal.aborted) break;
      if (!ok) {
        const n = this.failures.get(groupRef) ?? 1;
        const delay = Math.min(
          this.opts.maxBackoffMs ?? 30_000,
          (this.opts.baseBackoffMs ?? 500) * 2 ** (n - 1),
        );
        await this.sleep(delay, signal);
        continue;
      }
      if (Date.now() - lastReconcile >= every) {
        lastReconcile = Date.now();
        await this.reconcile(groupRef);
      }
    }
  }
}
