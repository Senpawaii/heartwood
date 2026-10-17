import { BackendError, MemoryKv, WorkerStartError } from "@heartwood/core";
import { describe, expect, it } from "vitest";
import { OrcaBackend } from "./orcaBackend.js";
import type { OrcaRunner } from "./runner.js";

const ok = (result: unknown) => ({
  exitCode: 0,
  stdout: JSON.stringify({ id: "x", ok: true, result }),
  stderr: "",
});
const fail = (code: string, message: string, exitCode = 1, result?: unknown) => ({
  exitCode,
  stdout: JSON.stringify({
    id: "x",
    ok: false,
    error: { code, message },
    ...(result ? { result } : {}),
  }),
  stderr: "",
});

/** Records argv and replies from a queue. */
function scripted(...replies: ReturnType<typeof ok>[]) {
  const calls: string[][] = [];
  const runner: OrcaRunner = async (argv) => {
    calls.push([...argv]);
    const r = replies.shift();
    if (!r) throw new Error("no scripted reply");
    return r;
  };
  return { calls, runner };
}

const outside = {};

// Shapes below were captured from `orca` 1.4.200 (trimmed).
const rejectedBatch = {
  runId: "run_1",
  deliveryId: "delivery_6d78a492eecb",
  messages: [
    {
      id: "msg_9b15",
      type: "status",
      subject: "Rejected escalation: Blocked: probe",
      body: "Orca rejected this escalation",
      payload:
        '{"taskId":"task_x","dispatchId":"disp_x","_orcaLifecycleRejection":{"code":"sender_not_assignee","reason":"No active Dispatch belongs to this message sender."}}',
    },
    {
      id: "msg_690a",
      type: "worker_done",
      subject: "done",
      body: "three sentences.",
      payload: '{"taskId":"task_1","dispatchId":"ctx_1","outcome":"succeeded"}',
    },
    { id: "msg_q", type: "question", subject: "which db?", payload: '{"dispatchId":"ctx_1"}' },
    {
      id: "msg_h",
      type: "heartbeat",
      subject: "alive",
      payload: '{"dispatchId":"ctx_1","phase":"implementing"}',
    },
    { id: "msg_s", type: "status", subject: "fyi" },
  ],
};

const polling = (runner: OrcaRunner, extra = {}) => {
  const identity = new MemoryKv();
  for (const g of ["run_1", "r"]) identity.set(`group:${g}`, "term_c");
  return new OrcaBackend({ runner, identity, ...extra });
};

describe("OrcaBackend.poll", () => {
  it("translates Orca types to neutral kinds, including lifecycle rejections", async () => {
    const { calls, runner } = scripted(ok(rejectedBatch));
    const be = polling(runner, { pollTimeoutMs: 5000 });
    const batch = await be.poll("run_1", {
      wake: ["done", "escalation", "question"],
      wait: true,
      ack: "delivery_prev",
    });

    expect(calls[0]).toEqual([
      "orchestration",
      "check",
      "--run",
      "run_1",
      "--terminal",
      "term_c",
      "--types",
      "worker_done,escalation,question",
      "--ack",
      "delivery_prev",
      "--wait",
      "--timeout-ms",
      "5000",
      "--json",
    ]);
    expect(batch.token).toBe("delivery_6d78a492eecb");
    expect(batch.messages.map((m) => [m.id, m.kind, m.rawType])).toEqual([
      ["msg_9b15", "rejected", "status"],
      ["msg_690a", "done", "worker_done"],
      ["msg_q", "question", "question"],
      ["msg_h", "heartbeat", "heartbeat"],
      ["msg_s", "other", "status"],
    ]);
    expect(batch.messages[0]).toMatchObject({
      workerRef: "disp_x",
      rejection: { code: "sender_not_assignee" },
    });
    expect(batch.messages[1]).toMatchObject({
      workerRef: "ctx_1",
      taskRef: "task_1",
      outcome: "succeeded",
      text: "three sentences.",
    });
    expect(batch.messages[1]?.rejection).toBeUndefined();
  });

  it("a rejected worker_done is never reported as done", async () => {
    const { runner } = scripted(
      ok({
        deliveryId: "d",
        messages: [
          {
            id: "m",
            type: "worker_done",
            payload:
              '{"dispatchId":"x","outcome":"succeeded","_orcaLifecycleRejection":{"code":"unknown_task"}}',
          },
        ],
      }),
    );
    const b = await polling(runner).poll("r", {
      wake: ["done"],
      wait: false,
    });
    expect(b.messages[0]).toMatchObject({ kind: "rejected", rawType: "worker_done" });
  });

  it("returns a null token for an empty poll and does not wait without wait", async () => {
    const { calls, runner } = scripted(
      ok({ runId: "run_1", deliveryId: null, messages: [], timedOut: true }),
    );
    const batch = await polling(runner).poll("run_1", {
      wake: ["done"],
      wait: false,
    });
    expect(batch).toEqual({ token: null, messages: [] });
    expect(calls[0]).not.toContain("--wait");
  });

  it("treats a lost runtime connection as a failure so nothing is acked", async () => {
    const { runner } = scripted(ok({ ...rejectedBatch, connectionLost: true }));
    await expect(polling(runner).poll("run_1", { wake: [], wait: false })).rejects.toMatchObject({
      code: "connection_lost",
    });
  });

  it("tolerates unknown fields and an unparsable payload", async () => {
    const { runner } = scripted(
      ok({
        deliveryId: "d",
        future: 1,
        messages: [{ id: "m", type: "worker_done", payload: "{not json", newField: true }],
      }),
    );
    const b = await polling(runner).poll("r", { wake: [], wait: false });
    expect(b.messages[0]).toMatchObject({ id: "m", kind: "done" });
    expect(b.messages[0]?.workerRef).toBeUndefined();
  });
});

describe("OrcaBackend coordinator identity", () => {
  const created = (handle: string) => ok({ terminal: { handle, title: "heartwood-coordinator" } });

  it("gives every group its own idle coordinator terminal (Orca binds a terminal to one Run)", async () => {
    const kv = new MemoryKv();
    const { calls, runner } = scripted(
      created("term_a"),
      ok({ run: { id: "run_a" } }),
      created("term_b"),
      ok({ run: { id: "run_b" } }),
      ok({ task: { id: "task_a" } }),
      ok({ task: { id: "task_b" } }),
    );
    const be = new OrcaBackend({ runner, identity: kv });
    expect((await be.createGroup("A")).groupRef).toBe("run_a");
    expect((await be.createGroup("B")).groupRef).toBe("run_b");
    await be.createTask("run_a", { spec: "s" });
    await be.createTask("run_b", { spec: "s" });

    expect(calls[0]).toEqual([
      "terminal",
      "create",
      "--worktree",
      "active",
      "--title",
      "heartwood-coordinator",
      "--json",
    ]);
    expect(calls[1]).toEqual([
      "orchestration",
      "run-create",
      "--objective",
      "A",
      "--from",
      "term_a",
      "--json",
    ]);
    expect(calls[4]).toContain("term_a"); // run_a's task is sent from run_a's terminal, not the newest one
    expect(calls[5]).toContain("term_b");
    expect(kv.get("group:run_a")).toBe("term_a");
    expect(kv.get("group:run_b")).toBe("term_b");
  });

  it("a restarted adapter keeps mutating existing groups through the remembered terminal", async () => {
    const kv = new MemoryKv();
    kv.set("group:run_a", "term_a");
    const { calls, runner } = scripted(ok({ task: { id: "task_1" } }));
    await new OrcaBackend({ runner, identity: kv }).createTask("run_a", { spec: "s" });
    expect(calls).toHaveLength(1); // no new terminal
    expect(calls[0]).toContain("term_a");
  });

  it("fails clearly for a group whose coordinator terminal is unknown", async () => {
    const { runner } = scripted();
    await expect(
      new OrcaBackend({ runner }).createTask("run_x", { spec: "s" }),
    ).rejects.toMatchObject({
      code: "group_identity_missing",
    });
  });

  it("closes the terminal if run-create fails, so nothing leaks", async () => {
    const { calls, runner } = scripted(created("term_a"), fail("boom", "no"), ok({ close: {} }));
    await expect(new OrcaBackend({ runner }).createGroup("A")).rejects.toMatchObject({
      code: "boom",
    });
    expect(calls[2]).toEqual(["terminal", "close", "--terminal", "term_a", "--json"]);
  });

  it("closeGroup closes the terminal, forgets it, and is idempotent", async () => {
    const kv = new MemoryKv();
    kv.set("group:run_a", "term_a");
    const { calls, runner } = scripted(ok({ close: {} }));
    const be = new OrcaBackend({ runner, identity: kv });
    await be.closeGroup("run_a");
    await be.closeGroup("run_a");
    expect(calls).toEqual([["terminal", "close", "--terminal", "term_a", "--json"]]);
    expect(kv.get("group:run_a")).toBeUndefined();
  });

  it("provisions nothing and sends no --from for read/settle commands; check names the group's terminal", async () => {
    const { calls, runner } = scripted(
      ok({ workers: [] }),
      ok({ state: "released" }),
      ok({ deliveryId: null, messages: [] }),
    );
    const kv = new MemoryKv();
    kv.set("group:r", "term_r");
    const be = new OrcaBackend({ runner, identity: kv });
    await be.listWorkers("r");
    await be.settleWorker("ctx_1", "release");
    await be.poll("r", { wake: [], wait: false });
    expect(calls.some((c) => c[0] === "terminal")).toBe(false);
    expect(calls.flat()).not.toContain("--from");
    expect(calls[2]).toContain("--terminal");
    expect(calls[2]).toContain("term_r");
  });

  it("open() reports the version and flags a missing orchestration contract", async () => {
    const good = scripted(
      ok({ runtime: { appVersion: "1.4.200", capabilities: ["orchestration.contract.v1"] } }),
    );
    expect(await new OrcaBackend({ runner: good.runner }).open()).toEqual({
      name: "orca",
      version: "1.4.200",
      compatible: true,
      problems: [],
    });
    const old = scripted(ok({ runtime: { appVersion: "0.9", capabilities: [] } }));
    const info = await new OrcaBackend({ runner: old.runner }).open();
    expect(info.compatible).toBe(false);
    expect(info.problems[0]).toMatch(/orchestration\.contract\.v1/);
  });
});

describe("OrcaBackend commands", () => {
  const be = (runner: OrcaRunner) => {
    const identity = new MemoryKv();
    for (const g of ["run_1", "r"]) identity.set(`group:${g}`, "term_s");
    return new OrcaBackend({ runner, identity });
  };

  it("creates tasks with a JSON deps array", async () => {
    const { calls, runner } = scripted(ok({ task: { id: "task_2" } }));
    const r = await be(runner).createTask("run_1", { spec: "do it", deps: ["task_1"] });
    expect(r).toEqual({ taskRef: "task_2" });
    expect(calls[0]).toEqual([
      "orchestration",
      "task-create",
      "--run",
      "run_1",
      "--spec",
      "do it",
      "--from",
      "term_s",
      "--deps",
      '["task_1"]',
      "--json",
    ]);
  });

  it("starts a worker; an unobserved first turn is a started worker, not a failure", async () => {
    const { calls, runner } = scripted(
      ok({
        runId: "run_1",
        taskId: "task_1",
        dispatchId: "ctx_028b",
        state: "outcome_unknown",
        effects: [
          { kind: "worktree", action: "reused", id: "wt" },
          { kind: "terminal", role: "agent", action: "created", id: "term_d4de" },
          { kind: "dispatch_input", role: "agent", id: "term_d4de", state: "accepted" },
        ],
      }),
    );
    const w = await be(runner).startWorker("run_1", {
      taskRef: "task_1",
      agent: "claude",
      model: "opus",
      effort: "high",
      placement: "new-child",
      name: "n",
      environment: "devbox",
    });
    expect(w).toEqual({
      workerRef: "ctx_028b",
      taskRef: "task_1",
      locator: "term_d4de",
      state: "outcome_unknown",
    });
    expect(calls[0]).toEqual([
      "orchestration",
      "worker-start",
      "--run",
      "run_1",
      "--task",
      "task_1",
      "--worktree",
      "new-child",
      "--agent",
      "claude",
      "--model",
      "opus",
      "--effort",
      "high",
      "--name",
      "n",
      "--on",
      "devbox",
      "--from",
      "term_s",
      "--json",
    ]);
  });

  it("reuses a worker instead of launching an agent, and validates input", async () => {
    const { calls, runner } = scripted(ok({ taskId: "t", dispatchId: "ctx_2" }));
    const b = be(runner);
    await b.startWorker("r", { spec: "s", agent: "claude", placement: "current", reuse: "term_a" });
    expect(calls[0]).toContain("--terminal");
    expect(calls[0]).not.toContain("--agent");
    await expect(b.startWorker("r", { agent: "claude", placement: "current" })).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      b.startWorker("r", { spec: "s", taskRef: "t", agent: "claude", placement: "current" }),
    ).rejects.toThrow(/exactly one/);
    await expect(
      b.startWorker("r", { spec: "s", agent: "claude", placement: "current", effort: "high" }),
    ).rejects.toThrow(/effort requires model/);
  });

  it("carries the backend's receipt when worker-start fails, so the caller never relaunches blindly", async () => {
    const { runner } = scripted(
      fail("worker_start_failed", "terminal did not start", 1, {
        failedStage: "terminal_create",
        residualResources: [{ kind: "worktree", id: "wt" }],
      }),
    );
    const err = await be(runner)
      .startWorker("r", { spec: "s", agent: "claude", placement: "new-child" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WorkerStartError);
    expect(err).toMatchObject({
      code: "worker_start_failed",
      failedStage: "terminal_create",
      residualResources: [{ kind: "worktree", id: "wt" }],
    });
  });

  const row = (id: string, verdict?: string) => ({
    dispatchId: id,
    taskId: "t",
    agentTerminalHandle: `term_${id}`,
    projection: {
      liveness: verdict ? { verdict, reason: "x" } : undefined,
      attention: { categories: ["unverifiable"], requiresAction: true },
    },
  });

  it("maps liveness; anything unreadable is unverifiable, never exited; follows pagination", async () => {
    const { calls, runner } = scripted(
      ok({
        workers: [row("ctx_1", "live"), row("ctx_2", "exited")],
        page: { hasMore: true, nextCursor: "c2" },
      }),
      ok({
        workers: [row("ctx_3", "weird-new-verdict"), row("ctx_4")],
        page: { hasMore: false, nextCursor: null },
      }),
    );
    const ws = await be(runner).listWorkers("run_1");
    expect(ws.map((w) => [w.workerRef, w.liveness])).toEqual([
      ["ctx_1", "live"],
      ["ctx_2", "exited"],
      ["ctx_3", "unverifiable"],
      ["ctx_4", "unverifiable"],
    ]);
    expect(ws[0]).toMatchObject({
      locator: "term_ctx_1",
      attention: { categories: ["unverifiable"], requiresAction: true },
    });
    expect(calls[1]).toContain("c2");
  });

  it("reports what Orca actually did on release/retain", async () => {
    const run = async (state: string, extra = {}) => {
      const { runner } = scripted(ok({ dispatchId: "d", state, ...extra }));
      return be(runner).settleWorker("d", "release");
    };
    expect(await run("released")).toEqual({ state: "released" });
    expect(await run("already_released")).toEqual({ state: "released" });
    expect(await run("release_pending")).toEqual({ state: "pending" });
    expect(await run("retained", { reason: "identity_unproven" })).toEqual({
      state: "retained",
      reason: "identity_unproven",
    });
    await expect(run("release_unknown")).rejects.toMatchObject({ code: "unexpected_state" });
    const { calls, runner } = scripted(ok({ state: "retained" }));
    await be(runner).settleWorker("d", "retain");
    expect(calls[0]).toEqual(["orchestration", "worker-retain", "--dispatch", "d", "--json"]);
  });

  it("propagates Orca error codes and rejects non-JSON output", async () => {
    await expect(
      be(scripted(fail("dispatch_not_found", "nope")).runner).stopWorker("ctx_x"),
    ).rejects.toMatchObject({
      code: "dispatch_not_found",
      exitCode: 1,
    });
    const bad: OrcaRunner = async () => ({ exitCode: 2, stdout: "Usage: orca ...", stderr: "" });
    await expect(be(bad).abandonWorker("x")).rejects.toBeInstanceOf(BackendError);
  });

  it("replies to a worker question on the group, from the group's terminal", async () => {
    const { calls, runner } = scripted(ok({ message: { id: "msg_r" } }));
    await be(runner).reply("run_1", "msg_q", "use postgres");
    expect(calls[0]).toEqual([
      "orchestration",
      "reply",
      "--id",
      "msg_q",
      "--body",
      "use postgres",
      "--run",
      "run_1",
      "--from",
      "term_s",
      "--json",
    ]);
  });

  it("reads terminal output", async () => {
    const { runner } = scripted(ok({ cursor: "c9", terminal: { tail: ["a", "b"] } }));
    expect(await be(runner).readWorker("d")).toEqual({ text: "a\nb", cursor: "c9" });
  });
});
