import type { HeartwoodEvent, NewEvent } from "@heartwood/protocol";
import type { Ctx } from "../context.js";
import { settleDispatch } from "../dispatch.js";
import { getBody, getBodyByOrcaDispatch, getDispatch } from "../queries.js";
import type { Disposition, OrcaGateway, OrcaMessage, SettleResult } from "./gateway.js";

/** Types that wake the long poll. `heartbeat` is excluded on purpose. */
export const WAKE_TYPES = ["worker_done", "escalation", "question"] as const;

export class RunLimitError extends Error {}

export interface CoordinatorOptions {
  /** Cap on concurrently watched Runs (one `check --wait` process each). */
  maxConcurrentRuns?: number;
  /** Disposition applied to a worker once its dispatch is settled. `reuse` is chosen by the dispatcher, not here. */
  disposition?: (outcome: "succeeded" | "failed" | "abandoned") => Exclude<Disposition, "reuse">;
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
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Sole consumer of each Run's Orca mailbox. Translates messages into Heartwood events, commits
 * them (with their consequences) in one transaction, and only then acks. A crash before the ack
 * makes Orca replay the batch; the (type, orcaMessageId) unique index makes that idempotent.
 */
export class OrcaCoordinator {
  private watches = new Map<string, Watch>();
  private failures = new Map<string, number>();
  /** Last committed delivery per Run, acknowledged on the next check. */
  private pendingAck = new Map<string, string>();
  private readonly max: number;
  private readonly disposition: NonNullable<CoordinatorOptions["disposition"]>;
  private readonly sleep: NonNullable<CoordinatorOptions["sleep"]>;
  private readonly now: () => Date;

  constructor(
    private readonly ctx: Ctx,
    private readonly gateway: OrcaGateway,
    private readonly opts: CoordinatorOptions = {},
  ) {
    this.max = opts.maxConcurrentRuns ?? 4;
    this.disposition = opts.disposition ?? (() => "release");
    this.sleep = opts.sleep ?? sleepAbortable;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * One poll/translate/commit cycle. Returns false if the CLI failed (recorded, not thrown).
   * Orca acks a whole delivery by id on the NEXT check, so the ack is only carried forward after
   * the batch has been durably committed; a crash or failure before then replays the delivery.
   */
  async pollOnce(
    runId: string,
    o: { wait?: boolean; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    try {
      const ack = this.pendingAck.get(runId);
      const batch = await this.gateway.check(runId, {
        types: WAKE_TYPES,
        wait: o.wait ?? false,
        ack,
        signal: o.signal,
      });
      if (ack) this.pendingAck.delete(runId);
      const settled = this.ingest(runId, batch.messages);
      if (batch.deliveryId) this.pendingAck.set(runId, batch.deliveryId);
      this.failures.set(runId, 0);
      for (const bodyId of settled) await this.applyDisposition(runId, bodyId);
      return true;
    } catch (err) {
      if (o.signal?.aborted) return true;
      const n = (this.failures.get(runId) ?? 0) + 1;
      this.failures.set(runId, n);
      this.ctx.log.append([
        {
          type: "orca.poll_failed",
          payload: {
            runId,
            consecutiveFailures: n,
            error: err instanceof Error ? err.message : String(err),
          },
          actor: { kind: "orca" },
          correlation: { runId },
        },
      ]);
      return false;
    }
  }

  /** Acknowledge the last committed delivery without waiting (used on stop). Best effort. */
  private async flushAck(runId: string): Promise<void> {
    const ack = this.pendingAck.get(runId);
    if (!ack) return;
    try {
      await this.gateway.check(runId, { types: WAKE_TYPES, wait: false, ack });
      this.pendingAck.delete(runId);
    } catch {
      // Orca replays the delivery; the (type, orcaMessageId) index makes that harmless.
    }
  }

  /** Translate + commit one batch atomically. Returns ids of bodies whose dispatch was just settled. */
  private ingest(runId: string, messages: OrcaMessage[]): string[] {
    const settledBodies: string[] = [];
    this.ctx.log.transaction(() => {
      const real = messages.filter((m) => m.type !== "heartbeat");
      const touch = this.ctx.db.prepare("INSERT OR REPLACE INTO worker_heartbeats VALUES (?, ?)");
      for (const m of messages)
        if (m.type === "heartbeat" && m.dispatchId)
          touch.run(m.dispatchId, this.now().toISOString());
      if (real.length === 0) return;
      this.ctx.log.append([
        {
          type: "orca.mailbox_batch",
          payload: {
            runId,
            messageIds: real.map((m) => m.id),
            heartbeatsDropped: messages.length - real.length,
            orcaMessageId: real[0]?.id,
          },
          actor: { kind: "orca" },
          correlation: { runId },
        },
      ]);
      for (const m of real) {
        const body = m.dispatchId ? getBodyByOrcaDispatch(this.ctx.db, m.dispatchId) : undefined;
        const correlation = {
          runId,
          ...(body ? { soulId: body.soulId, dispatchId: body.dispatchId } : {}),
        };
        const actor = { kind: "orca" as const };
        // each branch appends idempotently; duplicates (replayed messages) yield no events
        if (m.rejection) {
          // Orca refused this lifecycle message (e.g. stale/unknown dispatch): it settles nothing.
          this.ctx.log.append([
            {
              type: "orca.message_rejected",
              payload: {
                runId,
                orcaMessageId: m.id,
                messageType: m.type,
                code: m.rejection.code,
                reason: m.rejection.reason,
              },
              actor,
              correlation,
            },
          ]);
        } else if (m.type === "worker_done") {
          const appended = this.ctx.log.append([
            {
              type: "orca.worker_done",
              payload: {
                runId,
                orcaMessageId: m.id,
                orcaDispatchId: m.dispatchId ?? "",
                outcome: m.outcome ?? "failed",
                summary: m.body ?? m.subject,
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
              summary: m.body ?? m.subject,
              causedBy: done.id,
            })
          )
            settledBodies.push(body.bodyId);
        } else if (m.type === "escalation") {
          this.ctx.log.append([
            {
              type: "escalation.raised",
              payload: {
                escalationId: `esc_${m.id}`,
                dispatchId: body?.dispatchId,
                from: body ? { kind: "soul", id: body.soulId } : { kind: "orca", id: m.dispatchId },
                level: "foreman",
                reason: m.body ?? m.subject ?? "(no reason given)",
                orcaMessageId: m.id,
              },
              actor,
              correlation,
            },
          ]);
        } else if (m.type === "question") {
          this.ctx.log.append([
            {
              type: "question.asked",
              payload: {
                questionId: `q_${m.id}`,
                dispatchId: body?.dispatchId,
                text: m.body ?? m.subject ?? "",
                orcaMessageId: m.id,
              },
              actor,
              correlation,
            },
          ]);
        } else {
          const unknown: NewEvent = {
            type: "orca.unknown_message",
            payload: { runId, orcaMessageId: m.id, messageType: m.type },
            actor,
            correlation: { runId },
          };
          this.ctx.log.append([unknown]);
        }
      }
    });
    return settledBodies;
  }

  /** Settle the worker terminal and record it. Retried by reconcile() if the gateway call fails. */
  private async applyDisposition(runId: string, bodyId: string): Promise<void> {
    const body = getBody(this.ctx.db, bodyId);
    if (!body || body.disposition) return;
    const d = getDispatch(this.ctx.db, body.dispatchId);
    if (!d || d.state !== "settled") return;
    const choice = this.disposition(
      (d.outcome ?? "failed") as "succeeded" | "failed" | "abandoned",
    );
    let result: SettleResult;
    try {
      result = await this.gateway.settleWorker(body.orcaDispatchId, choice);
    } catch {
      return; // reconcile() will retry
    }
    if (result.state === "pending") return; // Orca is still releasing; settleWorker is idempotent, retry later
    const correlation = { runId, soulId: body.soulId };
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
   * Liveness + contract reconciliation for a Run. Drains the mailbox first (so a worker_done that
   * raced with exit wins), records liveness changes, abandons dispatches only on positive proof of
   * exit, and finishes any disposition that was not applied.
   */
  async reconcile(runId: string): Promise<void> {
    if (!(await this.pollOnce(runId, { wait: false }))) return;
    const workers = await this.gateway.listWorkers(runId);
    for (const w of workers) {
      const body = getBodyByOrcaDispatch(this.ctx.db, w.dispatchId);
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
            actor: { kind: "orca" },
            correlation: { runId, soulId: body.soulId },
          },
        ]);
      }
      if (w.liveness === "exited") {
        const d = getDispatch(this.ctx.db, body.dispatchId);
        if (d && d.state !== "settled") {
          settleDispatch(this.ctx, {
            dispatchId: d.dispatchId,
            outcome: "abandoned",
            summary: "worker exited without sending worker_done",
          });
        }
      }
      await this.applyDisposition(runId, body.bodyId);
    }
  }

  /** Begin watching a Run (long-poll loop with backoff). Throws RunLimitError at the cap. */
  start(runId: string): void {
    if (this.watches.has(runId)) return;
    if (this.watches.size >= this.max) throw new RunLimitError(`already watching ${this.max} runs`);
    const abort = new AbortController();
    this.watches.set(runId, { abort, done: this.loop(runId, abort.signal) });
  }

  async stop(runId: string): Promise<void> {
    const w = this.watches.get(runId);
    if (!w) return;
    w.abort.abort();
    await w.done;
    await this.flushAck(runId);
    this.watches.delete(runId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.watches.keys()].map((r) => this.stop(r)));
  }

  get watching(): string[] {
    return [...this.watches.keys()];
  }

  /**
   * After a daemon restart: resume watching every active warband's Run, up to the cap. Unacked
   * batches replay on the first poll. Returns Runs that did not fit under the cap.
   */
  resume(): { started: string[]; deferred: string[] } {
    const runs = this.ctx.db
      .prepare(
        "SELECT run_id AS r FROM warbands WHERE status = 'active' AND run_id IS NOT NULL ORDER BY rowid",
      )
      .all() as { r: string }[];
    const started: string[] = [];
    const deferred: string[] = [];
    for (const { r } of runs) {
      if (this.watches.size >= this.max && !this.watches.has(r)) deferred.push(r);
      else {
        this.start(r);
        started.push(r);
      }
    }
    return { started, deferred };
  }

  private async loop(runId: string, signal: AbortSignal): Promise<void> {
    const every = this.opts.livenessIntervalMs ?? 15_000;
    let lastReconcile = 0;
    while (!signal.aborted) {
      const ok = await this.pollOnce(runId, { wait: true, signal });
      if (signal.aborted) break;
      if (!ok) {
        const n = this.failures.get(runId) ?? 1;
        const delay = Math.min(
          this.opts.maxBackoffMs ?? 30_000,
          (this.opts.baseBackoffMs ?? 500) * 2 ** (n - 1),
        );
        await this.sleep(delay, signal);
        continue;
      }
      if (Date.now() - lastReconcile >= every) {
        lastReconcile = Date.now();
        await this.reconcile(runId);
      }
    }
  }
}
