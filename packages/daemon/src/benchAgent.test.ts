import type { AgentAdapter } from "@grimoire/core";
import { describe, expect, it } from "vitest";
import { BenchAgentError, loadBenchAgent, type ModuleLoader } from "./benchAgent.js";
import { loadConfig } from "./config.js";

const adapter = (available: boolean): AgentAdapter => ({
  id: "omp",
  detect: async () => ({ available, version: "18.5.1" }),
  install: async () => {},
  run: async () => {
    throw new Error("not used");
  },
});
const moduleWith =
  (getAdapter: unknown): ModuleLoader =>
  async () => ({ getAdapter });

describe("loadBenchAgent", () => {
  it("returns nothing, and loads nothing, when no agent is configured", async () => {
    let loaded = false;
    const load: ModuleLoader = async () => {
      loaded = true;
      return {};
    };
    expect(await loadBenchAgent(undefined, load)).toBeUndefined();
    expect(await loadBenchAgent("", load)).toBeUndefined();
    expect(loaded).toBe(false);
  });

  it("returns the adapter grimoire-lab hands out for the configured id", async () => {
    const asked: string[] = [];
    const a = adapter(true);
    const got = await loadBenchAgent(
      "omp",
      moduleWith((id: string) => (asked.push(id), a)),
    );
    expect(got).toBe(a);
    expect(asked).toEqual(["omp"]);
  });

  it("refuses to start when the adapters package cannot be loaded, saying what to do", async () => {
    const err = await loadBenchAgent("omp", async () => {
      throw new Error("Cannot find package '@grimoire/adapters'");
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BenchAgentError);
    expect(err.message).toMatch(/HEARTWOOD_BENCH_AGENT=omp needs @grimoire\/adapters/);
    expect(err.message).toMatch(/Cannot find package/);
    expect(err.message).toMatch(/README/);
  });

  it("refuses a package that is not the adapters package it expects", async () => {
    await expect(loadBenchAgent("omp", async () => ({ other: 1 }))).rejects.toThrow(
      /does not export getAdapter/,
    );
    await expect(loadBenchAgent("omp", async () => "nope")).rejects.toBeInstanceOf(BenchAgentError);
    await expect(loadBenchAgent("omp", moduleWith("not a function"))).rejects.toBeInstanceOf(
      BenchAgentError,
    );
  });

  it("reports an unknown agent id with grimoire-lab's own message", async () => {
    const load = moduleWith((id: string) => {
      throw new Error(`unknown agent "${id}"`);
    });
    const err = await loadBenchAgent("nope", load).catch((e) => e);
    expect(err).toBeInstanceOf(BenchAgentError);
    expect(err.message).toBe('HEARTWOOD_BENCH_AGENT=nope: unknown agent "nope"');
  });

  it("refuses an agent that is not installed on this machine instead of failing every trial later", async () => {
    const err = await loadBenchAgent(
      "omp",
      moduleWith(() => adapter(false)),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BenchAgentError);
    expect(err.message).toMatch(/omp is not available on this machine/);
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
