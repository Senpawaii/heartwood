import { describe, expect, it } from "vitest";
import { getBodyByOrcaDispatch, getDispatch, getSoul } from "../queries.js";
import { makeTown } from "../testing.js";
import { OrcaCoordinator, RunLimitError } from "./coordinator.js";
import { FakeOrcaGateway } from "./fakeGateway.js";
import { OrcaCliError } from "./gateway.js";

async function setup(opts: ConstructorParameters<typeof OrcaCoordinator>[2] = {}) {
  const t = makeTown();
  const gw = new FakeOrcaGateway();
  const co = new OrcaCoordinator(t.ctx, gw, opts);
  const soul = t.addSoul("Oak");
  const { runId } = await gw.createRun("ship");
  const { warbandId } = t.formWarband(soul, [], runId);
  const start = async () => {
    const { dispatchId: workerId } = await gw.startWorker(runId, {
      spec: "s",
      agent: "claude",
      worktree: "new-child",
    });
    const d = await t.dispatch(warbandId, soul, workerId);
    return { workerId, ...d };
  };
  return { t, gw, co, soul, runId, warbandId, start };
}

const done = (id: string, dispatchId: string, outcome: "succeeded" | "failed" = "succeeded") => ({
  id,
  type: "worker_done",
  dispatchId,
  outcome,
  body: "all good",
});

describe("OrcaCoordinator.pollOnce", () => {
  it("translates worker_done into events, settles the dispatch, acks, then releases the worker", async () => {
    const { t, gw, co, runId, soul, start } = await setup();
    const w = await start();
    gw.pushMessage(runId, done("m1", w.workerId));

    expect(await co.pollOnce(runId)).toBe(true);

    expect(getDispatch(t.db, w.dispatchId)).toMatchObject({
      state: "settled",
      outcome: "succeeded",
    });
    expect(getSoul(t.db, soul, t.rules)?.xp).toBe(t.rules.xp.taskSuccess);
    expect(gw.pending(runId)).toHaveLength(1); // acked on the next check
    expect(gw.dispositions.get(w.workerId)).toBe("release");
    expect(getBodyByOrcaDispatch(t.db, w.workerId)?.disposition).toBe("release");
    const types = t.log.read().map((e) => e.type);
    expect(types).toContain("orca.worker_done");
    expect(types).toContain("body.released");
    // the worker is released only after the commit, and the delivery is not acked by the same call
    expect(gw.calls.some((c) => c.method === "settleWorker")).toBe(true);
  });

  it("drops heartbeats: acked and tracked in a projection, but never appended as events", async () => {
    const { t, gw, co, runId, start } = await setup();
    const w = await start();
    gw.pushMessage(runId, { id: "h1", type: "heartbeat", dispatchId: w.workerId });
    gw.pushMessage(runId, { id: "h2", type: "heartbeat", dispatchId: w.workerId });
    const before = t.log.lastSeq();
    await co.pollOnce(runId);
    expect(t.log.lastSeq()).toBe(before);
    await co.pollOnce(runId); // carries the ack of the heartbeat-only delivery
    expect(gw.pending(runId)).toEqual([]);
    expect(
      t.db
        .prepare("SELECT COUNT(*) AS c FROM worker_heartbeats WHERE orca_dispatch_id = ?")
        .get(w.workerId),
    ).toEqual({ c: 1 });
  });

  it("only wakes on worker_done, escalation and question", async () => {
    const { gw, co, runId } = await setup();
    await co.pollOnce(runId);
    const call = gw.calls.find((c) => c.method === "check");
    expect((call?.args[1] as { types: string[] }).types).toEqual([
      "worker_done",
      "escalation",
      "question",
    ]);
  });

  it("acks a delivery only on the next check, after its effects were committed", async () => {
    const { t, gw, co, runId, start } = await setup();
    const w = await start();
    gw.pushMessage(runId, done("m1", w.workerId));
    await co.pollOnce(runId);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("settled");
    expect(gw.pending(runId)).toHaveLength(1); // delivered, not yet acked
    await co.pollOnce(runId);
    const checks = gw.calls
      .filter((c) => c.method === "check")
      .map((c) => c.args[1] as { ack?: string });
    expect(checks[0]?.ack).toBeUndefined();
    expect(checks[1]?.ack).toMatch(/^delivery_/);
    expect(gw.pending(runId)).toEqual([]);
  });

  it("is idempotent when the daemon restarts before acking and Orca replays the delivery", async () => {
    const { t, gw, co, runId, soul, start } = await setup();
    const w = await start();
    gw.pushMessage(runId, done("m1", w.workerId));
    await co.pollOnce(runId);
    const restarted = new OrcaCoordinator(t.ctx, gw); // loses the in-memory pending ack
    expect(await restarted.pollOnce(runId)).toBe(true); // replay of the same delivery
    expect(getSoul(t.db, soul, t.rules)?.xp).toBe(t.rules.xp.taskSuccess); // not doubled
    expect(t.log.read({ types: ["orca.worker_done"] })).toHaveLength(1);
    expect(t.log.read({ types: ["dispatch.settled"] })).toHaveLength(1);
    expect(t.log.read({ types: ["orca.mailbox_batch"] })).toHaveLength(1);
    await restarted.pollOnce(runId);
    expect(gw.pending(runId)).toEqual([]);
  });

  it("stop() flushes the pending ack", async () => {
    const { t, gw, co, runId, start } = await setup({ livenessIntervalMs: 1e9 });
    const w = await start();
    co.start(runId);
    gw.pushMessage(runId, done("m1", w.workerId));
    await vi_waitFor(() => getDispatch(t.db, w.dispatchId)?.state === "settled");
    await co.stop(runId);
    expect(gw.pending(runId)).toEqual([]);
  });

  it("does not carry an ack forward when committing the batch fails", async () => {
    const { t, gw, co, runId, start } = await setup();
    const w = await start();
    gw.pushMessage(runId, done("m1", w.workerId));
    t.db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON xp_ledger BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    expect(await co.pollOnce(runId)).toBe(false);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("running"); // whole batch rolled back
    t.db.exec("DROP TRIGGER boom");
    expect(await co.pollOnce(runId)).toBe(true); // same delivery replayed
    const checks = gw.calls
      .filter((c) => c.method === "check")
      .map((c) => c.args[1] as { ack?: string });
    expect(checks.every((c) => c.ack === undefined)).toBe(true);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("settled");
  });

  it("never settles on a worker_done Orca rejected", async () => {
    const { t, gw, co, runId, soul, start } = await setup();
    const w = await start();
    gw.pushMessage(runId, {
      ...done("m1", w.workerId),
      rejection: { code: "unknown_task", reason: "stale" },
    });
    gw.pushMessage(runId, {
      id: "m2",
      type: "status",
      subject: "x",
      rejection: { code: "sender_not_assignee" },
    });
    await co.pollOnce(runId);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("running");
    expect(getSoul(t.db, soul, t.rules)?.xp).toBe(0);
    expect(t.log.read({ types: ["orca.worker_done"] })).toEqual([]);
    expect(t.log.read({ types: ["orca.message_rejected"] }).map((e) => e.payload)).toMatchObject([
      { orcaMessageId: "m1", code: "unknown_task", messageType: "worker_done" },
      { orcaMessageId: "m2", code: "sender_not_assignee" },
    ]);
  });

  it("records CLI failures with a consecutive count and resets on success", async () => {
    const { t, gw, co, runId } = await setup();
    gw.failNext("check", new OrcaCliError("exit 1", "internal", 1));
    gw.failNext("check", new OrcaCliError("exit 1", "internal", 1));
    expect(await co.pollOnce(runId)).toBe(false);
    expect(await co.pollOnce(runId)).toBe(false);
    expect(await co.pollOnce(runId)).toBe(true);
    gw.failNext("check");
    await co.pollOnce(runId);
    const counts = t.log
      .read({ types: ["orca.poll_failed"] })
      .map((e) => (e.payload as { consecutiveFailures: number }).consecutiveFailures);
    expect(counts).toEqual([1, 2, 1]);
  });

  it("records escalations, questions and unknown message types", async () => {
    const { t, gw, co, runId, start } = await setup();
    const w = await start();
    gw.pushMessage(runId, {
      id: "e1",
      type: "escalation",
      dispatchId: w.workerId,
      body: "blocked on creds",
    });
    gw.pushMessage(runId, {
      id: "q1",
      type: "question",
      dispatchId: w.workerId,
      body: "which db?",
    });
    gw.pushMessage(runId, { id: "x1", type: "telepathy" });
    await co.pollOnce(runId);
    expect(t.log.read({ types: ["escalation.raised"] })[0]?.payload).toMatchObject({
      level: "foreman",
      reason: "blocked on creds",
      dispatchId: w.dispatchId,
    });
    expect(t.log.read({ types: ["question.asked"] })[0]?.payload).toMatchObject({
      text: "which db?",
    });
    expect(t.log.read({ types: ["orca.unknown_message"] })[0]?.payload).toMatchObject({
      messageType: "telepathy",
    });
  });

  it("applies the configured disposition and retries a failed settleWorker on reconcile", async () => {
    const { t, gw, co, runId, start } = await setup({
      disposition: (o) => (o === "succeeded" ? "retain" : "release"),
    });
    const w = await start();
    gw.pushMessage(runId, done("m1", w.workerId));
    gw.failNext("settleWorker");
    await co.pollOnce(runId);
    expect(getBodyByOrcaDispatch(t.db, w.workerId)?.disposition).toBeNull();
    await co.reconcile(runId);
    expect(gw.dispositions.get(w.workerId)).toBe("retain");
    expect(getBodyByOrcaDispatch(t.db, w.workerId)?.disposition).toBe("retain");
  });
});

describe("OrcaCoordinator release outcomes", () => {
  it("records body.retained, not released, when Orca could not prove the terminal identity", async () => {
    const { t, gw, co, runId, start } = await setup();
    const w = await start();
    gw.settleOverride = "retained";
    gw.pushMessage(runId, done("m1", w.workerId));
    await co.pollOnce(runId);
    expect(getBodyByOrcaDispatch(t.db, w.workerId)?.disposition).toBe("retain");
    expect(t.log.read({ types: ["body.released"] })).toEqual([]);
  });

  it("records nothing while Orca is still releasing, then records the release once", async () => {
    const { t, gw, co, runId, start } = await setup();
    const w = await start();
    gw.settleOverride = "pending";
    gw.pushMessage(runId, done("m1", w.workerId));
    await co.pollOnce(runId);
    expect(getBodyByOrcaDispatch(t.db, w.workerId)?.disposition).toBeNull();
    gw.settleOverride = undefined;
    await co.reconcile(runId);
    await co.reconcile(runId);
    expect(t.log.read({ types: ["body.released"] })).toHaveLength(1);
  });
});

describe("OrcaCoordinator.reconcile", () => {
  it("never treats a missing worker_done or unverifiable liveness as death", async () => {
    const { t, gw, co, runId, start } = await setup();
    const w = await start();
    gw.setLiveness(w.workerId, "unverifiable");
    await co.reconcile(runId);
    expect(getDispatch(t.db, w.dispatchId)?.state).toBe("running");
    expect(getBodyByOrcaDispatch(t.db, w.workerId)?.liveness).toBe("unverifiable");
    expect(gw.stopped).toEqual([]);
  });

  it("abandons a dispatch only on positive proof of exit, and releases the body", async () => {
    const { t, gw, co, runId, soul, start } = await setup();
    const w = await start();
    gw.setLiveness(w.workerId, "exited");
    await co.reconcile(runId);
    expect(getDispatch(t.db, w.dispatchId)).toMatchObject({
      state: "settled",
      outcome: "abandoned",
    });
    expect(getSoul(t.db, soul, t.rules)?.xp).toBe(0);
    expect(getBodyByOrcaDispatch(t.db, w.workerId)).toMatchObject({
      liveness: "exited",
      disposition: "release",
    });
    // liveness change emitted once only
    await co.reconcile(runId);
    expect(t.log.read({ types: ["body.liveness_changed"] })).toHaveLength(1);
  });

  it("a worker_done that raced with exit wins over abandonment", async () => {
    const { t, gw, co, runId, start } = await setup();
    const w = await start();
    gw.pushMessage(runId, done("m1", w.workerId, "failed"));
    gw.setLiveness(w.workerId, "exited");
    await co.reconcile(runId);
    expect(getDispatch(t.db, w.dispatchId)).toMatchObject({ outcome: "failed" });
  });
});

describe("OrcaCoordinator run watching", () => {
  it("caps concurrently watched runs", async () => {
    const { co } = await setup({ maxConcurrentRuns: 2 });
    co.start("r1");
    co.start("r2");
    co.start("r2"); // idempotent
    expect(() => co.start("r3")).toThrow(RunLimitError);
    await co.stopAll();
    expect(co.watching).toEqual([]);
  });

  it("long-polls: processes a message as it arrives and stops cleanly", async () => {
    const { t, gw, co, runId, start } = await setup({ livenessIntervalMs: 1e9 });
    const w = await start();
    co.start(runId);
    gw.pushMessage(runId, done("m1", w.workerId));
    await vi_waitFor(() => getDispatch(t.db, w.dispatchId)?.state === "settled");
    await co.stop(runId);
    expect(co.watching).toEqual([]);
  });

  it("backs off exponentially after failures", async () => {
    const delays: number[] = [];
    const { gw, co, runId } = await setup({
      baseBackoffMs: 100,
      maxBackoffMs: 350,
      livenessIntervalMs: 1e9,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    for (let i = 0; i < 4; i++) gw.failNext("check");
    co.start(runId);
    await vi_waitFor(() => delays.length >= 4);
    expect(delays.slice(0, 4)).toEqual([100, 200, 350, 350]);
    await co.stopAll();
  });

  it("resume() restarts active runs up to the cap and reports the rest as deferred", async () => {
    const t = makeTown();
    const gw = new FakeOrcaGateway();
    const co = new OrcaCoordinator(t.ctx, gw, { maxConcurrentRuns: 2 });
    const soul = t.addSoul("Oak");
    t.formWarband(soul, [], "r1");
    t.formWarband(soul, [], "r2");
    t.formWarband(soul, [], "r3");
    expect(co.resume()).toEqual({ started: ["r1", "r2"], deferred: ["r3"] });
    await co.stopAll();
  });
});

async function vi_waitFor(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}
