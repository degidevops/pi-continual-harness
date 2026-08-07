# pi-continual-harness

Online self-improvement layer for the [pi](https://pi.dev) coding agent.

This package owns **only the online optimizer layer**: a unified, in-trajectory
harness-state store (prompt notes, memory, skill descriptions, sub-agent specs)
plus a manual `/refine` that proposes **evidence-backed structured CRUD deltas**.

It deliberately does **not** reinvent storage or offline refinement. It composes
with:

- **[pi-reflect](https://github.com/jo-inc/pi-reflect)** — offline transcript
  → behavioral-file refinement (the "deep" path).
- **pi-mem / pi-memory** — durable memory storage.

The durable markdown file (`.pi/harness-state.md`) is the composition seam,
and it is **two-way**: `/refine --commit` and `/harness export` write it;
`/harness import` parses it back and merges into the live store (offline edits
win on conflict), so refinements pi-reflect makes flow back online. pi-mem
ingestion is a future/manual step.

## Why

Grounded in two lines of research:

- **Continual Harness** (arXiv [2605.09998](https://arxiv.org/abs/2605.09998)) —
  reset-free online CRUD over prompt / sub-agents / skills / memory drawn from
  the trajectory. Distinct from prompt-optimization methods that need episode
  resets.
- **ACE — Agentic Context Engineering** (arXiv
  [2510.04618](https://arxiv.org/abs/2510.04618)) — context as an evolving
  playbook. Key design lesson applied here: the optimizer emits **structured,
  itemized deltas**, never prose prompt rewrites, to prevent context collapse
  and brevity bias.

Prime Intellect's Prime Agent ships a Continual Harness built on pi; this
package is a minimal, package-shaped take on the same idea — **online only**,
leaving offline and storage to the packages that already do them well.

## Install

```
pi install git:github.com/<owner>/pi-continual-harness
```

Or drop `src/index.ts` into `~/.pi/agent/extensions/`.

## Usage

```
/refine              # review last 25 turns, propose deltas
/refine 50           # review last 50 turns
/refine 25 --commit  # also export durable state to ~/.pi/agent/harness-state.md
```

Durable I/O (round-trip with pi-reflect):

```
/harness status                  # counts + durable file presence/mtime
/harness export [path]           # write active items to a markdown file
/harness import [--prune] [path] # parse it back and merge (offline edits win)
/harness prune [--decay <days>]  # drop items below the importance floor
/harness keep <id>               # nudge importance up (+0.1)
/harness drop <id>               # nudge importance down (−0.1)
```

`import` reconciles the file into the live store: items whose id matches an
existing entry are updated (offline edits win on content/evidence/importance),
new entries are created. By default nothing is deleted — `--prune` also drops
active items whose id is no longer in the file (inactive items are always
preserved). Point pi-reflect at the same file to refine it offline:

```
/reflect ~/.pi/agent/harness-state.md
```

The model-facing tools:

- `harness_list [kind]` — read current state (optionally filtered by kind).
- `harness_mutate { deltas: [...] }` — apply a batch of `create` / `update` /
  `delete` deltas. Every `create` requires `evidence`.

Active items are injected into the system prompt each turn as a structured
block, appended to (never replacing) the base prompt.

## Configuration

Optional config at `~/.pi/agent/harness.json` (missing or malformed → defaults):

```json
{
  "durableScope": "global",
  "remindRefine": { "enabled": false, "everyTurns": 50 }
}
```

- **`durableScope`** — `"global"` (default) writes the durable markdown to
  `~/.pi/agent/harness-state.md`; `"project"` writes to
  `~/.pi/agent/harness-state/<slug>.md` (slug derived from `cwd`) so each
  project keeps separate state for pi-reflect.
- **`remindRefine`** — opt-in `turn_end` nudge. `{ "enabled": true,
  "everyTurns": 50 }` notifies you to run `/refine` on a cadence. It is
  informational only — it never mutates state.

## How it works

1. `/refine` gathers recent trajectory evidence from the current session branch.
2. It sends a steering user message asking the agent to propose evidence-backed
   CRUD deltas via `harness_mutate`.
3. The agent calls the tools; each accepted delta updates the in-memory state,
   which is snapshotted to the session via `appendEntry("harness-state", ...)`.
4. Because pi's session tree branches at any entry, `/tree` navigation gives
   rollback to any pre-refinement point for free — no bespoke snapshot system.

This reuses the existing agent loop (no nested/hidden model calls), is
model-agnostic, and keeps every delta visible and reviewable in the transcript.

## Scope and non-goals

- **In scope:** unified state store, online `/refine`, structured deltas,
  prompt injection, branching rollback, durable markdown export.
- **Out of scope (compose instead):** durable storage engines (pi-mem), offline
  deep refinement of behavioral files (pi-reflect), live sub-agent
  orchestration (pi-boss / pi-room). Sub-agent *specs* are stored as data only.

## Status

0.2.x. Implemented:

- Unified harness-state store with branch-local snapshots (`/tree` rollback).
- Online `/refine` + `harness_mutate` / `harness_list` tools.
- Two-way durable round-trip with pi-reflect (`/harness import|export|status`).
- Importance hygiene: `/harness prune [--decay <days>]` and `/harness keep|drop
  <id>`.
- Optional config (`~/.pi/agent/harness.json`): project-local durable scope and
  an opt-in `turn_end` reminder.

Open extension points (see `docs/ROADMAP.md`):

- A pluggable delta proposer (currently the agent itself, via steering).
- Opt-in `turn_end` auto-refine (reminder is wired; autonomous self-mutation is
  a sharp edge, so the trigger is off by default).
- pi-mem ingestion of the durable export.
- Outcome-driven importance (currently model-set + manual nudges).

## License

MIT
