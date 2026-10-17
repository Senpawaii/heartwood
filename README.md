# Heartwood

A tree-themed software factory: a coordinator daemon that runs AI agents as persistent characters
(souls) inside a town hierarchy, spawning and tracking their disposable workers (bodies) in
[Orca](https://github.com/stablyai/orca) and using [grimoire-lab](https://github.com/Senpawaii/grimoire-lab) as its skill Lab.

The character mechanics borrow vocabulary only; all names and lore are original.

## Status

| Package | State |
|---|---|
| `@heartwood/protocol` | Zod event schemas (town, soul, body, warband, dispatch, backend, memory, skill) and domain enums |
| `@heartwood/core` | Append-only SQLite event log + projections, XP/level/rank rules, skill usage + proficiency, memory (FTS5, top-k injection, Markdown view, reflection), the `LabPort` and `WorkerBackend` ports with fakes, and the backend-agnostic `BackendCoordinator` |
| `@heartwood/integrations` | `OrcaBackend`: the Orca adapter over `orca … --json` (execa, argv, no shell), with contract tests built from captured Orca output and an opt-in live smoke test |
| `daemon`, grimoire-lab adapter, `cli`, `apps/web` | not started |

## Design notes

- **The event log is the source of truth.** Read models are projections written in the same transaction as the append and can be rebuilt (`rebuildProjections`).
- **Rank is derived from level**, never stored. `soul.ranked` is a notification only.
- **Heartbeats are not events.** The coordinator drops them at translation and keeps only the last heartbeat time.
- **Orca is an adapter, not the architecture.** The daemon, coordinator and domain depend only on the `WorkerBackend` port (`@heartwood/core`): groups, tasks, workers, a polled mailbox with batch-token acks, neutral message kinds (`done`, `escalation`, `question`, `heartbeat`, `rejected`, `other`). Events are `backend.*` and carry opaque refs. Everything vendor-specific lives in `OrcaBackend`; swapping Orca means writing another adapter.
- **Orca facts (verified against Orca 1.4.200), all contained in `OrcaBackend`.** Workers are addressed by Dispatch id (`ctx_…`). `check` returns a whole FIFO *delivery*, replayed until its id is passed as `--ack` on the **next** `check`. Refused lifecycle messages arrive as ordinary messages carrying `_orcaLifecycleRejection`; the adapter maps them to kind `rejected` and they never settle anything. A `worker-start` receipt of `outcome_unknown` means the first turn was not observed, not that it failed. Mutating commands need a sender terminal (`--from`), and Orca binds a terminal to its **most recent Run**, so the adapter provisions one idle coordinator terminal **per group** (`terminal create`), remembers it in the `KeyValueStore` it is given, names it as `--terminal` on every `check` (otherwise a daemon started inside an Orca terminal gets `consumer_fenced`), and closes it in `closeGroup`. The daemon needs no terminal of its own.
- **Backends are pull-based.** `BackendCoordinator` is the sole mailbox consumer per group: translate, commit, *then* carry the batch token forward as the ack. Replays are idempotent via a unique `(type, messageId)` index. A missing `done` never proves death; only `liveness: exited` does.
- **Skill usage** is recorded with `evidence: "injected" | "loaded"`. Today only `injected` (skill was in the spec and the dispatch settled) is produced, which can overcount; the UI must label it.
- **Foreman** is daemon logic; a member soul holds the role and earns a separate, capped bonus (never credited for decisions it didn't make).
- **The Lab boundary** is `LabPort` in `@heartwood/core`; Heartwood owns rank thresholds and the promotion rule. Open grimoire-lab prerequisites: [#14](https://github.com/Senpawaii/grimoire-lab/issues/14) [#15](https://github.com/Senpawaii/grimoire-lab/issues/15) [#16](https://github.com/Senpawaii/grimoire-lab/issues/16) [#17](https://github.com/Senpawaii/grimoire-lab/issues/17) [#18](https://github.com/Senpawaii/grimoire-lab/issues/18).
- **Windows:** spawn `orca.exe` (or `orca` resolving to it) with an argv array and no shell. `orca.cmd` shims fail with `EINVAL` without a shell.

## Develop

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

Live Orca smoke test (creates a throwaway Run with its coordinator terminal and a task, closes the terminal, never starts a worker):

```
HEARTWOOD_ORCA_LIVE=1 pnpm test
```

Node 22+, pnpm.
