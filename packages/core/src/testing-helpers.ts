import { settleDispatch } from "./dispatch.js";
import type { Town } from "./testing.js";

/** Create a one-soul warband, run a dispatch to the given outcome, return the dispatch.settled event id. */
export async function dispatchSettled(
  t: Town,
  soulId: string,
  outcome: "succeeded" | "failed",
): Promise<string> {
  const { warbandId } = t.formWarband(soulId);
  const d = await t.dispatch(warbandId, soulId, `w_${Math.random().toString(36).slice(2)}`);
  settleDispatch(t.ctx, { dispatchId: d.dispatchId, outcome });
  const e = t.log.read({ types: ["dispatch.settled"] }).at(-1);
  return e?.id ?? "";
}
