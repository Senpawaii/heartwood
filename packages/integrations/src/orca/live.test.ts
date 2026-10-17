import { describe, expect, it } from "vitest";
import { OrcaCliGateway } from "./cliGateway.js";

/**
 * Opt-in smoke test against a real, running Orca: `HEARTWOOD_ORCA_LIVE=1 pnpm test`.
 * Creates a throwaway Run and Task. Outside an Orca terminal also set HEARTWOOD_ORCA_SENDER.
 * It never starts a worker.
 */
describe.skipIf(!process.env.HEARTWOOD_ORCA_LIVE)("live Orca", () => {
  const gw = new OrcaCliGateway({
    senderTerminal: process.env.HEARTWOOD_ORCA_SENDER,
    pollTimeoutMs: 1000,
  });

  it("advertises the orchestration contract", async () => {
    const c = await gw.capabilities();
    expect(c.capabilities).toContain("orchestration.contract.v1");
  });

  it("creates a run and task, long-polls an empty mailbox, lists no workers", async () => {
    const { runId } = await gw.createRun("heartwood live smoke (safe to delete)");
    expect(runId).toMatch(/^run_/);
    const { taskId } = await gw.createTask(runId, { spec: "smoke: nothing to do" });
    expect(taskId).toMatch(/^task_/);
    const batch = await gw.check(runId, {
      types: ["worker_done", "escalation", "question"],
      wait: true,
    });
    expect(batch).toEqual({ deliveryId: null, messages: [] });
    expect(await gw.listWorkers(runId)).toEqual([]);
  });
});
