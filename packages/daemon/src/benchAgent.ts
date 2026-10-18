import { getAdapter } from "@grimoire/adapters";
import type { AgentAdapter } from "@grimoire/core";

/** The configured benchmark agent cannot be used. Carries a message meant for the operator. */
export class BenchAgentError extends Error {}

/** Looks an adapter up by id. Injected so tests need no real agent. */
export type AdapterLookup = (id: string) => AgentAdapter;

/**
 * The agent grimoire-lab runs benchmark trials with, from `@grimoire/adapters`. With no agent configured
 * this returns `undefined` and benchmarks answer 501.
 *
 * Throws `BenchAgentError` when an agent is configured but cannot be used, so the daemon refuses to
 * start rather than silently running without the benchmarks the operator asked for.
 */
export async function loadBenchAgent(
  id: string | undefined,
  lookup: AdapterLookup = getAdapter,
): Promise<AgentAdapter | undefined> {
  if (!id) return undefined;

  let adapter: AgentAdapter;
  try {
    adapter = lookup(id);
  } catch (err) {
    throw new BenchAgentError(
      `HEARTWOOD_BENCH_AGENT=${id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const found = await adapter.detect();
  if (!found.available)
    throw new BenchAgentError(
      `HEARTWOOD_BENCH_AGENT=${id}: ${id} is not available on this machine (is it on PATH?)`,
    );
  return adapter;
}
