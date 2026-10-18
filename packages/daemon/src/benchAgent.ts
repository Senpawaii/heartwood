import type { AgentAdapter } from "@grimoire/core";

/** The configured benchmark agent cannot be used. Carries a message meant for the operator. */
export class BenchAgentError extends Error {}

/** Loads a module by specifier. Injected so tests need no real package. */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

const ADAPTERS_PACKAGE = "@grimoire/adapters";

/**
 * The agent grimoire-lab runs benchmark trials with (`omp`, `claude-code`, ...), taken from
 * `@grimoire/adapters`. That package is loaded on demand, not declared as a dependency: it is not
 * published and its release does not ship an installable tarball yet (see README). With no agent
 * configured this returns `undefined` and benchmarks answer 501, as before.
 *
 * Throws `BenchAgentError` when an agent is configured but cannot be used, so the daemon refuses to
 * start rather than silently running without benchmarks the operator asked for.
 */
export async function loadBenchAgent(
  id: string | undefined,
  load: ModuleLoader = (specifier) => import(specifier),
): Promise<AgentAdapter | undefined> {
  if (!id) return undefined;

  let mod: unknown;
  try {
    mod = await load(ADAPTERS_PACKAGE);
  } catch (err) {
    throw new BenchAgentError(
      `HEARTWOOD_BENCH_AGENT=${id} needs ${ADAPTERS_PACKAGE}, which could not be loaded (${err instanceof Error ? err.message : String(err)}). It is not published yet; see the README for how to install it.`,
    );
  }
  if (
    typeof mod !== "object" ||
    mod === null ||
    !("getAdapter" in mod) ||
    typeof mod.getAdapter !== "function"
  )
    throw new BenchAgentError(
      `${ADAPTERS_PACKAGE} does not export getAdapter(id); is it a compatible version?`,
    );

  // The export was just checked to be a function; its signature is grimoire-lab's documented one.
  const getAdapter = mod.getAdapter as (id: string) => AgentAdapter;
  let adapter: AgentAdapter;
  try {
    adapter = getAdapter(id);
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
