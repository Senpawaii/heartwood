# Heartwood council response to "grimoire-lab next steps for Heartwood"

Responds to `docs/proposals/heartwood-council-next-steps.md` (grimoire-lab, baseline `@grimoire/core` 0.2.0
plus the unreleased command adapter). From: Heartwood. Status: decisions and answers, ready to act on.

Heartwood currently runs `@grimoire/core` **0.1.0** (release tarball). Everything below marked *measured* was
run against that package, a real git repository, a real Orca 1.4.200 and omp 18.5.1. Things we have not
verified are listed in section 6; do not read silence as confirmation.

## 1. Decisions

| | Proposal | Decision |
|---|---|---|
| P1 | Orca-backed `AgentAdapter` | **Reject as written. Replace with an `omp` adapter in `@grimoire/adapters`** (section 3) |
| P2 | Stage, worker edits, bench | **Accept the goal; no grimoire work.** Already exported separately. Heartwood owns the worker step |
| P3 | `requireMinN` gate | **Reject as redundant.** `minTrials` already does this |
| P4 | Consumer smoke test | **Accept.** Extend with the cases in section 4 |
| P5 | Cost and latency evidence | **Defer, and drop the schema change.** `Score` already carries it; only adapter usage reporting is missing |
| P6 | Multi-adapter single run | **Defer** |
| P7 | Remote source helper | **Defer** |

Sequencing: omp adapter + P4 first, then the small fixes in section 5, then a 0.3.0 release. P3 is dropped.

## 2. Answers to the open questions

1. **Placement of the Orca adapter.** Neither option: there is no Orca adapter. The adapter that unlocks
   Heartwood is an **`omp` adapter in `@grimoire/adapters`** (next to `claude-code`). It has no Orca and no
   Heartwood dependency, so it is useful to any omp user. Heartwood injects it. Orca is used by Heartwood at a
   different granularity (section 3).
2. **Minimum `n` default.** Do not change core's default (5) and do not add a second gate. Heartwood passes its own
   `minTrials` (10 per side) and `tolerance` (0.15) on every comparison. Document the default as permissive
   for LLM agents.
3. **Evidence scope.** No Heartwood rank threshold uses cost today (rank inputs are pass rate over countable
   trials, lift over no skill, trial count, infra-error share). Add nothing to the schema. `Score` already has
   `meanTokens`, `meanDurationMs`, `meanCostUsd`, and `evidenceFor` returns the `Score`.
4. **API stability.** Stay on `0.x` until the omp adapter exists and one full Heartwood benchmark-and-promote
   cycle has run for real. Then 1.0.0. Heartwood pins an exact release tarball, so `0.x` flexibility is fine.
5. **Transcript tool events.** Orca cannot provide them (measured, section 3). The shape comes from omp's own
   JSON stream; exact mapping in section 3.

## 3. P1 replaced: why, and the omp adapter we need

### Measured: why not Orca per trial
- `orca orchestration worker-read --source transcript` on a finished omp worker fails with
  `session_not_reported`. `auto` falls back to terminal text (`sourceExact: false`, `contentComplete: false`).
  So `skill_loaded` cannot be produced from Orca for omp.
- `orca terminal create --worktree path:<dir>` on a directory Orca has not registered fails with
  `selector_not_found`. The engine creates an unregistered temp workspace per trial and asserts against it, so
  an Orca adapter would need a registered worktree plus copy-in and copy-out of the workspace.
- A worker's result is its short `worker_done` summary, not the agent's final message. We saw no token usage in
  any Orca result.
- One supervised worker took about 8 s end to end (create terminal, dispatch, done). A headless omp trial took
  about 3 s. A 10-repeat, 2-arm suite would open 20 terminals per task.
- The proposal does not mention isolation. Without it, the user's own skills, rules and extensions leak into
  the baseline arm and skill-vs-baseline measures nothing.

### Measured: headless omp gives everything needed
`omp -p --no-session --mode json ...` in the trial workspace:
- Events: `session, agent_start, turn_start, message_start, message_update, message_end, tool_execution_start,
  tool_execution_update, tool_execution_end, turn_end, agent_end`.
- `tool_execution_start` carries `{ toolCallId, toolName, args, intent }`.
- A skill placed at `<ws>/.omp/skills/<name>/SKILL.md` is discovered. Its use appears as a `read` tool call with
  `args.path = "skill://<name>"`, and it changed the result (the test skill forced the content `ZEBRA hello`).
- `message_end.message.usage` = `{ input, output, cacheRead, cacheWrite, totalTokens, cost.total }`.
  `totalTokens` equals grimoire's definition exactly (2 + 45 + 11274 + 135 = 11456).
- `--no-skills --no-rules --no-extensions --approval-mode yolo` ran cleanly and the agent wrote the file in the
  workspace.
- Model and effort are controllable and verified with omp's own RPC `get_state` and its recorded session:
  `--model <provider/id>` and `--thinking <off|minimal|low|medium|high|xhigh|max|auto>`, or a `:level` suffix on
  the model id. omp's default level is `medium`. A level the model does not support is clamped (`minimal` became
  `low` on Sonnet 5.5).

### Requested adapter contract
- `id: "omp"`; `detect()` runs `omp --version`; report that as the agent version.
- `install(skill, ws)`: copy the skill to `<ws.dir>/.omp/skills/<skill.name>/`.
- `run(req, ws)`: spawn omp **without a shell** (argv array; kill the whole process tree on timeout, which
  matters on Windows) with `-p --no-session --mode json --approval-mode yolo --no-rules --no-extensions`,
  `--model <req.model>` and, when configured, `--thinking <level>`.
- Isolation: baseline arm `--no-skills`. Skill arm must expose **only** the installed skill: use
  `--skills <name>`. **We did not test `--skills`; please verify it filters out user-level skills.**
- Transcript mapping: `message_end` -> `message`; `tool_execution_start` -> `tool_call { id: toolCallId,
  name: toolName, input: args }`; `tool_execution_end` -> `tool_result`; a `read` whose path matches
  `^skill://<name>` additionally yields `skill_loaded { skill: <name> }`. Use `message_end`, not
  `message_update` (updates omit full snapshots).
- Usage: sum `totalTokens` and `cost.total` over the run's `message_end` events.
- Status: `completed` on exit 0 and an `agent_end`; `timeout` on timeout; `error` with
  `errorKind: "infrastructure"` on spawn failure or a provider/rate-limit error; `errorKind: "agent"` when the
  agent ran and failed.
- **Record the effort in the arm's `agent.model`** as the full selector (`anthropic/claude-sonnet-5-5:high`).
  The result's agent identity has no effort field, so two runs differing only in thinking level would otherwise
  look identical to `deriveKind`. No schema change needed.
- Tests: a stub `omp` script (as the command adapter's tests do) for CI, plus one gated live test.
- Must tolerate `concurrency > 1`: every trial gets its own workspace and its own `--no-session` process.

### Where Orca still belongs
At the granularity of one supervised worker per **rewrite** (P2) or per **benchmark run**, owned by Heartwood.
Not per trial.

## 4. P2, P3, P4 detail

- **P2.** `stageCandidate`, `benchProposal` and `proposeVersion` are already separate exports. Heartwood has a
  working `SkillRewriter` integration tested against the real library. One friction, see 5.3.
- **P3.** `compare` already gates `significant` on `minTrials` countable trials per side (default 5, recorded in
  `comparison.gate`); Heartwood passes its own `minTrials`/`tolerance` through it. Against the real library we
  only exercised a clear win (promoted) and no change (rejected); the "too few trials" rejection is tested
  against Heartwood's fake Lab, not yours.
  A second `requireMinN` would duplicate it. The proposal's title says "drift gate" but the body specifies none.
  Defer cross-run drift until a consumer compares arms across runs; Heartwood compares within one run.
- **P4.** Accept. Please include in the smoke test: a `gitSource` with a tagged historical version, a custom
  `SkillSource`, a refused digest mismatch, and a Windows runner. Heartwood already exercises
  `dirSource -> resolveSkill -> loadSkillByDigest -> benchSkill / benchProposal -> evidenceFor -> compare ->
  proposeVersion` against the real library in 12 tests, so the value here is packaging regressions only.

## 5. Additional requests, from what we found (ordered by value)

### 5.1 `gitSource.list()` cost grows with every tag and is repeated after every commit
*Measured:* 40 tagged versions, cold `list()` 3082 ms, warm 71 ms, and **2973 ms again after one unrelated empty
commit** (the cache key is HEAD plus the tag set). That is about 75 ms per tag, linear. Tags are immutable:
cache `tag object id -> digest` (in memory, or persisted by the caller) so only a changed HEAD re-hashes.

### 5.2 One failing source breaks `resolveSkill` and `listSkills` for all sources
*Measured:* with `[sourceThatThrows, gitSource]`, `resolveSkill("demo@1.0.0", ...)` rejects with the first
source's error, while `loadSkillByDigest` correctly falls through to the next source. A remote or flaky source
should not take the catalog down. Either skip-and-report per source or accept an `onSourceError` option;
document whichever you pick. Heartwood will isolate per source on its side regardless.

### 5.3 A staged candidate carries no suite, so a promoted skill cannot be benchmarked again
`stageCandidate` excludes `grimoire.bench.yaml` and `fixtures/` (correct for the digest), but promoting a
candidate then requires copying the suite alongside by hand. Heartwood does this in its own store today.
Add an additive `StageOptions.withSuite` (or a documented helper).

### 5.4 OS junk files change a skill's digest
*Measured:* adding `Thumbs.db` or `.DS_Store` to a skill folder changes its digest; adding an empty directory
does not. Browsing a folder in Explorer or Finder therefore produces a spurious "new version". Exclude
`.DS_Store`, `Thumbs.db`, `desktop.ini` from the digest. It is non-breaking for folders that do not contain
them. (A UTF-8 BOM also changes the digest; that is defensible as byte identity, but worth a line in the docs.)

### 5.5 Clarify `Comparison.gate.delta` vs `deltas.passRate`
Heartwood uses `gate.delta` (infra errors excluded) as the lift over no skill and `deltas.passRate` as a
fallback. The README should say which one is the rank-relevant lift.

### 5.6 Release hygiene
Please confirm the **v0.2.0** release has its tarball asset (we upgrade next) and keep release assets
immutable: Heartwood installs from the release URL with an integrity hash in its lockfile, not from npm.

## 6. What Heartwood verified, and what it did not

*Verified (0.1.0, real library):* installable ESM package (fields, integrity-pinned install, one shared
`zod`/`execa`); content digest behaviour: CRLF and LF text equal, suite and fixtures excluded, body/script/rename
changes detected, binary files that differ only by `\r\n` stay distinct, folder name irrelevant, empty
directories ignored; `loadSkillByDigest` refuses tampered content and a source that returns the wrong content;
`gitSource` HEAD, tags, de-duplication, historical load, temp-dir cleanup, uncommitted changes ignored;
`AmbiguousSkill` for one name with two digests across sources; a custom `SkillSource` (Heartwood's own
content-addressed store); `benchSkill`, `benchProposal`, `proposeVersion`, `compare`, `evidenceFor` with an injected
adapter.

*Not verified by us:* anything new in 0.2.0 (`Comparison.ci`, `requireCiExcludesZero`, `concurrency`,
`resumeBench`); the generic command adapter (read from source only); symlinks inside a skill folder (could not
create one on Windows); identical digests across Windows and Linux; omp's `--skills` filter; `gitSource` on very
large repositories or remote clones.

## 7. What Heartwood does on its side

Status: items 1 to 3 are done and pushed (0.2.0 is installed with an integrity-pinned lockfile entry; the
interval gate is on by default; ranks are keyed by suite and agent; a failing source is isolated, with a
refusal for bare names while one is down). Item 5 for grimoire 0.3.0: Heartwood runs on `@grimoire/core` 0.3.0 (all tests pass), and the omp adapter was exercised end to end from a local build of the `v0.3.0` tag (a real benchmark, then a full evolve and promotion with a stand-in rewriter). It is not installable from the release: **please attach a tarball of `@grimoire/adapters` to releases and replace its `workspace:*` dependency on core by the exact version** (a packed tarball already pins `@grimoire/core` to 0.3.0). Item 4 is done differently from what we proposed: the `SkillRewriter` runs one headless omp in the staged directory (smoke-tested with a real model: 9 s), not a supervised Orca worker, because a rewrite needs no worktree, terminal or review and Orca adds latency (measured 8 s versus 3 s per run) without adding information. Orca stays the backend for coordinator work.

1. Upgrade to 0.2.0, pass `requireCiExcludesZero: true` in promotion, and add a `requireCi` knob to its gate.
2. Key stored skill ranks by (skill digest, suite digest, agent + model + effort). Today they are keyed by
   (name, digest) only, so a different suite or model overwrites a rank.
3. Isolate sources per source when listing and resolving, regardless of 5.2.
4. Provide the `SkillRewriter` (an omp worker supervised through Orca on a registered worktree) and the
   promotion rule. Heartwood owns every rank and promotion decision.
5. Wire the omp adapter as soon as it exists, then run the first real benchmark and promotion end to end.

## 8. Proposed order

1. grimoire-lab: omp adapter (section 3) and P4 (section 4).
2. grimoire-lab: 5.1 and 5.4, then 5.2, 5.3, 5.5 as time allows.
3. Heartwood: section 7 items 1 to 3 in parallel with step 1.
4. Release 0.3.0; Heartwood runs the first real benchmark and promotion.
5. 1.0.0 after that cycle has run. P5 to P7 only on a concrete request.
