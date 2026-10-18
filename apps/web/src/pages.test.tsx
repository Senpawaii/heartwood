// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { type Client, createClient } from "./api/client";
import { AppProviders } from "./api/provider";
import { selectorOf } from "./components/ModelPicker";
import { SkillUsageTable } from "./components/SkillUsageTable";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type Routes = Record<string, unknown | ((req: { method: string; body: string | null }) => unknown)>;

interface FakeDaemon {
  calls: { method: string; path: string; body: string | null }[];
  client: Client;
}

/** A daemon stand-in: routes keyed by "METHOD /path" (query ignored). Unrouted calls fail the test. */
function fakeDaemon(routes: Routes): FakeDaemon {
  const calls: { method: string; path: string; body: string | null }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = url.replace(/^\/api/, "").split("?")[0];
    const body = typeof init.body === "string" ? init.body : null;
    calls.push({ method, path: path ?? "", body });
    const route = routes[`${method} ${path}`];
    if (route === undefined)
      return new Response(
        JSON.stringify({ error: "not_found", message: `no route ${method} ${path}` }),
        { status: 404 },
      );
    const out = await (typeof route === "function" ? route({ method, body }) : route);
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, client: createClient({ fetch: fetchFn }) };
}

const soul = (o: object = {}) => ({
  soulId: "s1",
  name: "Oakhand",
  species: "dwarf",
  form: "dwarf",
  ministryId: "m1",
  xp: 42,
  level: 3,
  rank: "journeyman",
  office: null,
  mentorId: null,
  status: "active",
  currentBodyId: null,
  titles: [],
  magiculesSpent: 5,
  ...o,
});
const town = {
  name: "Heartwood",
  budget: null,
  magiculesSpent: 5,
  counts: {
    souls: 1,
    ministries: 1,
    warbands: 0,
    activeWarbands: 0,
    openQuestions: 1,
    openEscalations: 0,
  },
};
const ready = {
  ok: true,
  backend: { status: "ready", info: { name: "orca", version: "1.4.200" } },
  lastSeq: 9,
  watching: [],
};
const inbox = { questions: [], escalations: [] };

function mount(d: FakeDaemon, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={d.client} live={false}>
        <App />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("SkillUsageTable", () => {
  it("labels injected-only usage as unverified and shows success rate", () => {
    render(
      <SkillUsageTable
        usage={[
          {
            skill: "tdd",
            uses: 4,
            succeeded: 3,
            failed: 1,
            unknown: 0,
            successRate: 0.75,
            injectedOnly: 4,
          },
          {
            skill: "lint",
            uses: 2,
            succeeded: 1,
            failed: 0,
            unknown: 1,
            successRate: 1,
            injectedOnly: 1,
          },
          {
            skill: "docs",
            uses: 1,
            succeeded: 1,
            failed: 0,
            unknown: 0,
            successRate: 1,
            injectedOnly: 0,
          },
        ]}
      />,
    );
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("injected, not verified")).toBeTruthy();
    expect(screen.getByText("1 of 2 injected, not verified")).toBeTruthy();
    expect(screen.getByText("verified")).toBeTruthy();
  });

  it("explains an empty table", () => {
    render(<SkillUsageTable usage={[]} />);
    expect(screen.getByText("No skill has been used yet.")).toBeTruthy();
  });
});

describe("pages", () => {
  it("overview shows the town, counts what waits on the Sovereign, and warns when the backend is degraded", async () => {
    const d = fakeDaemon({
      "GET /health": {
        ...ready,
        backend: { status: "degraded", problems: ["orca is not running"] },
      },
      "GET /town": town,
      "GET /inbox": {
        questions: [
          {
            questionId: "q1",
            text: "which db?",
            dispatchId: null,
            soulId: null,
            at: "2026-10-17T00:00:00Z",
          },
        ],
        escalations: [],
      },
      "GET /ministries": {
        ministries: [{ ministryId: "m1", name: "Construction", kind: "construction" }],
      },
    });
    mount(d, "/");
    expect(await screen.findByRole("heading", { name: "Heartwood" })).toBeTruthy();
    expect(await screen.findByText(/orca is not running/)).toBeTruthy();
    expect(screen.getByText("Construction")).toBeTruthy();
    expect(screen.getByText("1 question · 0 escalations")).toBeTruthy();
  });

  it("souls page lists souls with derived rank and level", async () => {
    const d = fakeDaemon({
      "GET /health": ready,
      "GET /inbox": inbox,
      "GET /souls": {
        souls: [
          soul(),
          soul({
            soulId: "s2",
            name: "Elmwright",
            species: "elf",
            rank: "apprentice",
            level: 1,
            xp: 0,
          }),
        ],
      },
      "GET /ministries": {
        ministries: [{ ministryId: "m1", name: "Construction", kind: "construction" }],
      },
    });
    mount(d, "/souls");
    expect(await screen.findByText("Oakhand")).toBeTruthy();
    expect(screen.getByText("journeyman")).toBeTruthy();
    expect(screen.getByText("Lv 3")).toBeTruthy();
    expect(screen.getByText("Elmwright")).toBeTruthy();
  });

  it("naming a soul posts the form, including what it costs", async () => {
    const d = fakeDaemon({
      "GET /health": ready,
      "GET /inbox": inbox,
      "GET /souls": { souls: [] },
      "GET /ministries": {
        ministries: [{ ministryId: "m1", name: "Construction", kind: "construction" }],
      },
      "POST /souls": { soul: soul() },
    });
    mount(d, "/souls");
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Birchfist" } });
    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "Patient smith." } });
    fireEvent.click(screen.getByRole("button", { name: "Name soul" }));
    await waitFor(() =>
      expect(d.calls.some((c) => c.method === "POST" && c.path === "/souls")).toBe(true),
    );
    const post = d.calls.find((c) => c.method === "POST" && c.path === "/souls");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      name: "Birchfist",
      species: "dwarf",
      ministryId: "m1",
      persona: "Patient smith.",
      magiculesSpent: 5,
    });
  });

  it("soul page shows skills with rank and proficiency, unverified usage, and surfaces a refused evolution", async () => {
    const d = fakeDaemon({
      "GET /health": ready,
      "GET /inbox": inbox,
      "GET /souls/s1": {
        soul: soul(),
        skills: [
          {
            name: "tdd",
            digest: "sha256:abcdef0123456789",
            source: "grimoire",
            rank: "unique",
            proficiency: 0.62,
          },
        ],
        skillUsage: [
          {
            skill: "tdd",
            uses: 3,
            succeeded: 2,
            failed: 1,
            unknown: 0,
            successRate: 0.67,
            injectedOnly: 3,
          },
        ],
      },
      "GET /souls/s1/memory": { persona: "careful", memories: [] },
      "GET /souls/s1/skills/tdd/proficiency": {
        series: [
          { at: "t1", uses: 1, score: 0.3 },
          { at: "t2", uses: 2, score: 0.6 },
        ],
      },
    });
    mount(d, "/souls/s1");
    expect(await screen.findByRole("heading", { name: "Oakhand" })).toBeTruthy();
    expect(screen.getByText("unique")).toBeTruthy();
    expect(screen.getByText("62%")).toBeTruthy();
    expect(await screen.findByRole("img", { name: "tdd proficiency over time" })).toBeTruthy();
    expect(screen.getByText("injected, not verified")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Evolve" }));
    expect(await screen.findByRole("alert")).toBeTruthy(); // the unrouted POST fails and is shown, not swallowed
  });

  it("inbox answers a question through the daemon and clears the form", async () => {
    const d = fakeDaemon({
      "GET /health": ready,
      "GET /inbox": {
        questions: [
          {
            questionId: "q1",
            text: "which database?",
            dispatchId: null,
            soulId: null,
            at: "2026-10-17T00:00:00Z",
          },
        ],
        escalations: [],
      },
      "POST /questions/q1/answer": { answered: "q1" },
    });
    mount(d, "/inbox");
    expect(await screen.findByText("which database?")).toBeTruthy();
    const input = screen.getByLabelText("Your answer") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "postgres" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(d.calls.find((c) => c.path === "/questions/q1/answer")).toBeTruthy(),
    );
    expect(
      JSON.parse(d.calls.find((c) => c.path === "/questions/q1/answer")?.body ?? "{}"),
    ).toEqual({ answer: "postgres" });
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("warband page blocks disbanding while a dispatch is unsettled", async () => {
    const d = fakeDaemon({
      "GET /health": ready,
      "GET /inbox": inbox,
      "GET /souls": { souls: [soul()] },
      "GET /warbands/w1": {
        warband: {
          warbandId: "w1",
          objective: "Fix the parser",
          foremanSoulId: "s1",
          groupRef: "run_1",
          status: "active",
          members: [{ soulId: "s1", role: "foreman" }],
        },
        dispatches: [
          { dispatchId: "disp_ABCDEFGH", soulId: "s1", state: "running", outcome: null },
        ],
      },
    });
    mount(d, "/warbands/w1");
    expect(await screen.findByRole("heading", { name: "Fix the parser" })).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Disband" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("skills page lists one skill digest once per agent it was measured with, and marks older ranks unknown", async () => {
    const row = (agent: string, rank: string, suiteDigest = "sha256:suite1") => ({
      name: "tdd",
      digest: "sha256:abcdef0123456789",
      suiteDigest,
      agent,
      rank,
      score: 0.8,
      thresholdsVersion: "default-2",
    });
    const d = fakeDaemon({
      "GET /health": ready,
      "GET /inbox": inbox,
      "GET /skills": { skills: [], problems: [] },
      "GET /skills/usage": { usage: [] },
      "GET /skills/ranks": {
        ranks: [
          row("omp@18.5.1 anthropic/claude-sonnet-5-5:high", "ultimate"),
          row("omp@18.5.1 anthropic/claude-haiku-4-5:low", "extra"),
          row("", "unique", ""),
        ],
      },
    });
    mount(d, "/skills");
    expect(await screen.findByText("omp@18.5.1 anthropic/claude-sonnet-5-5:high")).toBeTruthy();
    expect(screen.getByText("omp@18.5.1 anthropic/claude-haiku-4-5:low")).toBeTruthy();
    expect(screen.getByText("unknown")).toBeTruthy();
    expect(screen.getAllByText("tdd")).toHaveLength(3);
    expect(screen.getByText("ultimate")).toBeTruthy();
    expect(screen.getByText("extra")).toBeTruthy();
  });

  describe("skills catalog actions", () => {
    const greeter = {
      name: "greeter",
      digest: "sha256:aaaabbbbccccdddd",
      description: "Use when asked to write a greeting file.",
      version: "1.0.0",
      source: "/skills",
    };
    const base = {
      "GET /health": ready,
      "GET /inbox": inbox,
      "GET /skills/usage": { usage: [] },
      "GET /skills/ranks": { ranks: [] },
    };
    const evidence = {
      trials: 10,
      passes: 0,
      errors: 0,
      passRate: 0,
      agent: { id: "omp", version: "18.5.1", model: "anthropic/claude-sonnet-5-5:low" },
      vsBaseline: { delta: 0 },
    };

    it("Analyze benchmarks exactly the pinned digest and reports the outcome", async () => {
      const d = fakeDaemon({
        ...base,
        "GET /skills": { skills: [greeter], problems: [] },
        "POST /skills/analyze": { evidence, rank: "common" },
      });
      mount(d, "/skills");
      fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
      expect(
        await screen.findByText(/rank common · 0\/10 trials passed · \+0 pts vs no skill/),
      ).toBeTruthy();
      const call = d.calls.find((c) => c.path === "/skills/analyze");
      expect(JSON.parse(call?.body ?? "{}")).toEqual({ name: "greeter", digest: greeter.digest });
    });

    it("says so when a benchmark was inconclusive instead of inventing a rank", async () => {
      const d = fakeDaemon({
        ...base,
        "GET /skills": { skills: [greeter], problems: [] },
        "POST /skills/analyze": { evidence: { ...evidence, errors: 6 }, rank: null },
      });
      mount(d, "/skills");
      fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
      expect(
        await screen.findByText(/inconclusive, no rank · 0\/10 trials passed · 6 errored/),
      ).toBeTruthy();
    });

    it("Evolve reports a refused proposal with its evidence, and a promotion with the new digest", async () => {
      let answer: unknown = {
        promoted: false,
        candidate: { name: "greeter", digest: "sha256:1111222233334444" },
        comparison: {
          delta: 0,
          verdict: "same",
          significant: false,
          ci: { lower: -0.28, upper: 0.28 },
        },
      };
      const d = fakeDaemon({
        ...base,
        "GET /skills": { skills: [greeter], problems: [] },
        "POST /skills/evolve": () => answer,
      });
      mount(d, "/skills");
      fireEvent.click(await screen.findByRole("button", { name: "Evolve" }));
      expect(
        await screen.findByText(
          "Kept the current version (same, +0 pts, 95% CI −28 pts to +28 pts)",
        ),
      ).toBeTruthy();

      answer = {
        promoted: true,
        candidate: { name: "greeter", digest: "sha256:9999888877776666" },
        comparison: {
          delta: 1,
          verdict: "better",
          significant: true,
          ci: { lower: 0.39, upper: 1 },
        },
      };
      fireEvent.click(screen.getByRole("button", { name: "Evolve" }));
      expect(await screen.findByText(/Promoted sha256:99998888… \(better, \+100 pts/)).toBeTruthy();
    });

    it("keeps showing the evolution result after the promotion changes the skill's digest", async () => {
      let promoted = false;
      const newer = { ...greeter, digest: "sha256:9999888877776666", version: "1.1.0" };
      const d = fakeDaemon({
        ...base,
        "GET /skills": () => ({ skills: [promoted ? newer : greeter], problems: [] }),
        "POST /skills/evolve": () => {
          promoted = true;
          return {
            promoted: true,
            candidate: { name: "greeter", digest: newer.digest },
            comparison: { delta: 1, verdict: "better", significant: true },
          };
        },
      });
      mount(d, "/skills");
      fireEvent.click(await screen.findByRole("button", { name: "Evolve" }));
      expect(await screen.findByText(/Promoted sha256:99998888…/)).toBeTruthy();
      // the catalog refetch has landed: the row now shows the new version and still the result
      expect(await screen.findByText("1.1.0")).toBeTruthy();
      expect(screen.getByText(/Promoted sha256:99998888…/)).toBeTruthy();
    });

    it("sends the model and effort picked in the UI, and nothing when none is picked", async () => {
      const d = fakeDaemon({
        ...base,
        "GET /skills": { skills: [greeter], problems: [] },
        "POST /skills/analyze": { evidence, rank: "common" },
      });
      mount(d, "/skills");
      const analyze = await screen.findByRole("button", { name: "Analyze" });
      fireEvent.click(analyze);
      await screen.findByText(/trials passed/);
      const bodyOf = (n: number) =>
        JSON.parse(d.calls.filter((c) => c.path === "/skills/analyze")[n]?.body ?? "{}");
      expect(bodyOf(0)).toEqual({ name: "greeter", digest: greeter.digest });

      fireEvent.change(screen.getByLabelText("Measure with"), {
        target: { value: "anthropic/claude-haiku-4-5" },
      });
      fireEvent.change(screen.getByLabelText("Measure with effort"), { target: { value: "high" } });
      fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
      await waitFor(() =>
        expect(d.calls.filter((c) => c.path === "/skills/analyze")).toHaveLength(2),
      );
      expect(bodyOf(1)).toEqual({
        name: "greeter",
        digest: greeter.digest,
        model: "anthropic/claude-haiku-4-5:high",
      });
    });

    it("Evolve sends both choices: what to measure with and what writes the new version", async () => {
      const d = fakeDaemon({
        ...base,
        "GET /skills": { skills: [greeter], problems: [] },
        "POST /skills/evolve": {
          promoted: false,
          candidate: { name: "greeter", digest: "sha256:1111222233334444" },
          comparison: { delta: 0, verdict: "same", significant: false },
        },
      });
      mount(d, "/skills");
      fireEvent.change(await screen.findByLabelText("Measure with"), {
        target: { value: "a/bench:low" },
      });
      fireEvent.change(screen.getByLabelText("Rewrite with (Evolve)"), {
        target: { value: "b/writer" },
      });
      fireEvent.change(screen.getByLabelText("Rewrite with (Evolve) effort"), {
        target: { value: "max" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Evolve" }));
      await screen.findByText(/Kept the current version/);
      const call = d.calls.find((c) => c.path === "/skills/evolve");
      expect(JSON.parse(call?.body ?? "{}")).toEqual({
        name: "greeter",
        digest: greeter.digest,
        model: "a/bench:low",
        rewriterModel: "b/writer:max",
      });
    });

    it("remembers the picked models after a reload", async () => {
      const routes = { ...base, "GET /skills": { skills: [greeter], problems: [] } };
      mount(fakeDaemon(routes), "/skills");
      fireEvent.change(await screen.findByLabelText("Measure with"), {
        target: { value: "a/kept" },
      });
      cleanup();
      mount(fakeDaemon(routes), "/skills");
      expect(((await screen.findByLabelText("Measure with")) as HTMLInputElement).value).toBe(
        "a/kept",
      );
    });

    it("ignores a damaged remembered choice instead of breaking the page", async () => {
      localStorage.setItem("heartwood.model.measure", "{not json");
      localStorage.setItem("heartwood.model.rewrite", JSON.stringify({ model: 5 }));
      const d = fakeDaemon({ ...base, "GET /skills": { skills: [greeter], problems: [] } });
      mount(d, "/skills");
      expect(((await screen.findByLabelText("Measure with")) as HTMLInputElement).value).toBe("");
    });

    it("lets an effort be picked only for a model that does not already carry one", async () => {
      mount(fakeDaemon({ ...base, "GET /skills": { skills: [greeter], problems: [] } }), "/skills");
      const effort = (await screen.findByLabelText("Measure with effort")) as HTMLSelectElement;
      expect(effort.disabled).toBe(true); // no model yet: an effort has nothing to attach to
      fireEvent.change(screen.getByLabelText("Measure with"), { target: { value: "a/b" } });
      expect(effort.disabled).toBe(false);
      fireEvent.change(screen.getByLabelText("Measure with"), { target: { value: "a/b:xhigh" } });
      expect(effort.disabled).toBe(true); // it names its own level
    });

    it("disables both buttons while a benchmark runs, so one skill is never benchmarked twice at once", async () => {
      let finish: (v: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        finish = resolve;
      });
      const d = fakeDaemon({
        ...base,
        "GET /skills": { skills: [greeter], problems: [] },
        "POST /skills/analyze": () => pending,
      });
      mount(d, "/skills");
      fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
      const running = await screen.findByRole("button", { name: "Benchmarking…" });
      expect((running as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Evolve" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      finish({ evidence, rank: "common" });
      expect(await screen.findByText(/rank common/)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Analyze" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    it("shows the daemon's refusal when benchmarks are not configured", async () => {
      const fetchFn = (async (url: string, init: RequestInit = {}) => {
        const path = url.replace(/^\/api/, "");
        const refused = init.method === "POST";
        const body = refused
          ? {
              error: "lab_unavailable",
              message: "analyze: no AgentAdapter is configured, so benchmarks cannot run",
            }
          : (
              { ...base, "GET /skills": { skills: [greeter], problems: [] } } as Record<
                string,
                unknown
              >
            )[`GET ${path}`];
        return new Response(JSON.stringify(body), { status: refused ? 501 : 200 });
      }) as typeof fetch;
      render(
        <MemoryRouter initialEntries={["/skills"]}>
          <AppProviders client={createClient({ fetch: fetchFn })} live={false}>
            <App />
          </AppProviders>
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Analyze" }));
      expect(await screen.findByText(/benchmarks cannot run \(lab_unavailable\)/)).toBeTruthy();
    });

    it("warns about a catalog source that is down, and still lists the others", async () => {
      const d = fakeDaemon({
        ...base,
        "GET /skills": {
          skills: [greeter],
          problems: [{ source: "flaky", operation: "list", message: "network down" }],
        },
      });
      mount(d, "/skills");
      expect(await screen.findByText(/Source flaky is unavailable \(network down\)/)).toBeTruthy();
      expect(screen.getByText("greeter")).toBeTruthy();
    });
  });

  it("tells apart ranks of one skill and agent that were measured on different suites", async () => {
    const row = (suiteDigest: string, rank: string) => ({
      name: "summarizer",
      digest: "sha256:abcdef0123456789",
      suiteDigest,
      agent: "omp@18.5.1 anthropic/claude-sonnet-5-5:low",
      rank,
      score: 0,
      thresholdsVersion: "default-2",
    });
    const d = fakeDaemon({
      "GET /health": ready,
      "GET /inbox": inbox,
      "GET /skills": { skills: [], problems: [] },
      "GET /skills/usage": { usage: [] },
      "GET /skills/ranks": {
        ranks: [
          row("sha256:1f547c6dAAAA", "common"),
          row("sha256:c379f2a4BBBB", "common"),
          row("", "common"),
        ],
      },
    });
    mount(d, "/skills");
    expect(await screen.findByText("suite 1f547c6d")).toBeTruthy();
    expect(screen.getByText("suite c379f2a4")).toBeTruthy();
    expect(screen.getByText("suite not recorded")).toBeTruthy();
  });

  it("shows a token hint when the daemon answers 401", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "unauthorized", message: "missing or invalid token" }), {
        status: 401,
      })) as typeof fetch;
    render(
      <MemoryRouter>
        <AppProviders client={createClient({ fetch: fetchFn })} live={false}>
          <App />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/requires an access token/)).toBeTruthy();
  });
});

describe("selectorOf", () => {
  it("is undefined without a model, appends the effort, and leaves a model that names its own level alone", () => {
    expect(selectorOf({ model: "", effort: "high" })).toBeUndefined();
    expect(selectorOf({ model: "  ", effort: "" })).toBeUndefined();
    expect(selectorOf({ model: " a/b ", effort: "" })).toBe("a/b");
    expect(selectorOf({ model: "a/b", effort: "high" })).toBe("a/b:high");
    expect(selectorOf({ model: "a/b:low", effort: "high" })).toBe("a/b:low");
  });
});
