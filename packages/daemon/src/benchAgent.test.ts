import type { AgentAdapter } from "@grimoire/core";
import { describe, expect, it } from "vitest";
import { type AdapterLookup, BenchAgentError, loadBenchAgent } from "./benchAgent.js";
import { loadConfig } from "./config.js";

const adapter = (available: boolean): AgentAdapter => ({
  id: "omp",
  detect: async () => ({ available, version: "18.5.1" }),
  install: async () => {},
  run: async () => {
    throw new Error("not used");
  },
});
describe("loadBenchAgent", () => {
  it("returns nothing, and looks nothing up, when no agent is configured", async () => {
    const asked: string[] = [];
    const lookup: AdapterLookup = (id) => (asked.push(id), adapter(true));
    expect(await loadBenchAgent(undefined, lookup)).toBeUndefined();
    expect(await loadBenchAgent("", lookup)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("returns the adapter grimoire-lab hands out for the configured id", async () => {
    const asked: string[] = [];
    const a = adapter(true);
    const got = await loadBenchAgent("omp", (id) => (asked.push(id), a));
    expect(got).toBe(a);
    expect(asked).toEqual(["omp"]);
  });

  it("reports an unknown agent id with grimoire-lab's own message", async () => {
    const err = await loadBenchAgent("nope", (id) => {
      throw new Error(`unknown agent "${id}"`);
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BenchAgentError);
    expect(err.message).toBe('HEARTWOOD_BENCH_AGENT=nope: unknown agent "nope"');
  });

  it("refuses an agent that is not installed on this machine instead of failing every trial later", async () => {
    const err = await loadBenchAgent("omp", () => adapter(false)).catch((e) => e);
    expect(err).toBeInstanceOf(BenchAgentError);
    expect(err.message).toMatch(/omp is not available on this machine/);
  });

  it("uses the real @grimoire/adapters by default: omp resolves, or is reported as not installed", async () => {
    // CI machines have no omp, a developer machine does; the lookup itself must work on both
    const out = await loadBenchAgent("omp").catch((e) => e);
    if (out instanceof BenchAgentError)
      expect(out.message).toMatch(/omp is not available on this machine/);
    else expect(out).toMatchObject({ id: "omp" });
  });
});

describe("benchmark configuration", () => {
  it("is off by default", () => {
    expect(loadConfig({}).bench).toEqual({});
  });

  it("reads the agent, the model with its effort suffix, and the trial count", () => {
    const c = loadConfig({
      HEARTWOOD_BENCH_AGENT: "omp",
      HEARTWOOD_BENCH_MODEL: "anthropic/claude-sonnet-5-5:low",
      HEARTWOOD_BENCH_REPEAT: "10",
    });
    expect(c.bench).toEqual({ agent: "omp", model: "anthropic/claude-sonnet-5-5:low", repeat: 10 });
  });

  it("accepts only omp as the benchmark agent, never claude directly", () => {
    expect(() => loadConfig({ HEARTWOOD_BENCH_AGENT: "claude-code" })).toThrow();
    expect(() => loadConfig({ HEARTWOOD_BENCH_AGENT: "command" })).toThrow();
  });

  it("rejects a trial count that is not a positive whole number", () => {
    for (const bad of ["0", "-3", "2.5", "many"])
      expect(() => loadConfig({ HEARTWOOD_BENCH_REPEAT: bad })).toThrow();
  });
});

describe("rewriter configuration", () => {
  it("is off by default and only accepts omp", () => {
    expect(loadConfig({}).rewriter).toEqual({});
    expect(
      loadConfig({
        HEARTWOOD_REWRITER: "omp",
        HEARTWOOD_REWRITER_MODEL: "anthropic/claude-sonnet-5-5:high",
      }).rewriter,
    ).toEqual({
      agent: "omp",
      model: "anthropic/claude-sonnet-5-5:high",
    });
    expect(() => loadConfig({ HEARTWOOD_REWRITER: "claude" })).toThrow();
  });
});
