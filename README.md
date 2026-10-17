# Heartwood

A tree-themed software factory: a coordinator daemon that runs AI agents as persistent characters
(souls) inside a town hierarchy, spawning and tracking their disposable workers (bodies) in
[Orca](https://github.com/stablyai/orca) and using [grimoire-lab](https://github.com/Senpawaii/grimoire-lab) as its skill Lab.

The character mechanics borrow vocabulary only; all names and lore are original.

## Status

| Package | State |
|---|---|
| `@heartwood/protocol` | Zod event schemas (town, soul, body, warband, dispatch, orca, memory, skill) and domain enums |
| `@heartwood/core` | Append-only SQLite event log + projections, XP/level/rank rules, skill usage + proficiency, memory (FTS5, top-k injection, Markdown view, reflection), `LabPort` + `FakeLab`, `OrcaGateway` + `FakeOrcaGateway`, `OrcaCoordinator` |
| `daemon`, `integrations` (real Orca CLI gateway, grimoire-lab adapter), `cli`, `apps/web` | not started |

## Design notes

- **The event log is the source of truth.** Read models are projections written in the same transaction as the append and can be rebuilt (`rebuildProjections`).
- **Rank is derived from level**, never stored. `soul.ranked` is a notification only.
- **Heartbeats are not events.** The coordinator drops them at translation and keeps only the last heartbeat time.
- **Orca is pull-based.** `OrcaCoordinator` is the sole mailbox consumer per Run: translate, commit, *then* ack. Replays are idempotent via a unique `(type, orcaMessageId)` index. A missing `worker_done` never proves death; only `liveness: exited` does.
- **Skill usage** is recorded with `evidence: "injected" | "loaded"`. Today only `injected` (skill was in the spec and the dispatch settled) is produced, which can overcount; the UI must label it.
- **Foreman** is daemon logic; a member soul holds the role and earns a separate, capped bonus (never credited for decisions it didn't make).
- **The Lab boundary** is `LabPort` in `@heartwood/core`; Heartwood owns rank thresholds and the promotion rule. Open grimoire-lab prerequisites: [#14](https://github.com/Senpawaii/grimoire-lab/issues/14) [#15](https://github.com/Senpawaii/grimoire-lab/issues/15) [#16](https://github.com/Senpawaii/grimoire-lab/issues/16) [#17](https://github.com/Senpawaii/grimoire-lab/issues/17) [#18](https://github.com/Senpawaii/grimoire-lab/issues/18).
- **Windows:** spawn `orca.exe` (or `orca` resolving to it) with an argv array and no shell. `orca.cmd` shims fail with `EINVAL` without a shell.

## Develop

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

Node 22+, pnpm.
