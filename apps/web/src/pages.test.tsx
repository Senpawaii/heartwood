// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { createClient } from "./api/client";
import { AppProviders } from "./api/provider";
import { SkillUsageTable } from "./components/SkillUsageTable";

afterEach(cleanup);

type Routes = Record<string, unknown | ((req: { method: string; body: string | null }) => unknown)>;

/** A daemon stand-in: routes keyed by "METHOD /path" (query ignored). Unrouted calls fail the test. */
function fakeDaemon(routes: Routes) {
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
    const out = typeof route === "function" ? route({ method, body }) : route;
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

function mount(d: ReturnType<typeof fakeDaemon>, path: string) {
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
