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

The durable markdown file (`~/.pi/agent/harness-state.md`) is the composition seam,
and it is **two-way**: `/refine --commit` and `/harness export` write it;
`/harness import` parses it back and merges into the live store (offline edits
win on conflict), so refinements pi-reflect makes flow back online. `/harness push-mem`
pushes active items into pi-mem's semantic store (see
[Composing with pi-mem](#composing-with-pi-mem)).

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
pi install npm:pi-continual-harness
```

Or drop `src/index.ts` into `~/.pi/agent/extensions/`.

## Usage

```
/refine              # review last 25 turns, propose deltas
/refine 50           # review last 50 turns
/refine 25 --commit  # also export durable state to ~/.pi/agent/harness-state.md
/refine --proposer dedupe  # run the rule-based dedupe proposer instead of steering
/refine --proposer signal  # run the cheap gate proposer (detects tool errors, user corrections, task boundaries)
```

Durable I/O (round-trip with pi-reflect):

```
/harness status                  # counts + durable file presence/mtime
/harness export [path]           # write active items to a markdown file
/harness import [--prune] [path] # parse it back and merge (offline edits win)
/harness prune [--decay <days>]  # drop items below the importance floor
/harness keep <id>               # nudge importance up (+0.1)
/harness drop <id>               # nudge importance down (−0.1)
/harness push-mem [--all|--kind <kind>|--model <provider/id|active>]  # persist active items to pi-mem (save_memory)
/harness run-subagent <id>       # execute a subagent spec from harness
/harness run-skill <id>          # execute an executable skill from harness
/harness cross-model <on|off>    # enable/disable cross-model shared pool
/harness cross-model-optin       # opt current model into shared pool
/harness cross-model-optout      # opt current model out of shared pool
/harness promote <id>            # promote item to shared pool
/harness demote <id>             # demote item from shared pool
/harness outcome <deltaId> <success|failure>  # record outcome for delta
/harness promotion-candidates    # list items eligible for promotion
/harness demotion-candidates     # list items eligible for demotion
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

- `harness_list({ kind?, model? })` — read current state. `model` defaults to
  the active model's items (what gets injected this turn); `"*"` returns every
  model.
- `harness_mutate { deltas: [...] }` — apply a batch of `create` / `update` /
  `delete` deltas. Every `create` requires `evidence`. New items are stamped
  automatically with the active model (see [Model binding](#model-binding-per-model-isolation)).
  **When creating/updating `subagent` or `skill` items, they are automatically executed** (see [Live sub-agent orchestration](#live-sub-agent-orchestration-a4)).

Active items are injected into the system prompt each turn as a structured
block, appended to (never replacing) the base prompt.

## Composing with pi-mem

`/harness push-mem` copies active harness items into
[pi-mem](https://github.com/georgebashi/pi-mem)'s semantic memory store, so they
become searchable across sessions. It works by **steering** the agent to call
pi-mem's `save_memory` tool — there is **no dependency** on pi-mem: it is a
soft-fail composition. If pi-mem (or any memory tool) is not installed, the
agent tells you so rather than fabricating one.

```
pi install npm:pi-mem        # optional companion
```

By default only **memory**-kind items are pushed (the clean 1:1 mapping); use
`--all` for every active item, `--kind prompt|skill|subagent` for a specific
kind, or `--model <provider/id|active>` to scope the push to one model's items
(`--model active` = the model driving the command). The harness store itself is
unchanged by a push — pi-mem gets a separate copy.

## Configuration

Optional config at `~/.pi/agent/harness.json` (missing or malformed → defaults):

```json
{
  "durableScope": "global",
  "proposer": "signal",
  "injection": { "enabled": true, "maxTokens": 1500, "maxPerKind": 10, "charsPerToken": 4 },
  "remindRefine": { "enabled": false, "everyTurns": 50 },
  "autoRefine": { "enabled": true, "everyTurns": 1, "commit": false },
  "outcomeImportance": { "enabled": false, "bump": 0.03 },
  "outcomeEvaluation": {
    "enabled": false,
    "promoteBump": 0.02,
    "demotePenalty": 0.05,
    "minApplications": 3,
    "failureRatioThreshold": 0.5
  },
  "crossModel": { "enabled": false }
}
```

- **`durableScope`** — `"global"` (default) writes the durable markdown to
  `~/.pi/agent/harness-state.md`; `"project"` writes to
  `~/.pi/agent/harness-state/<slug>.md` (slug derived from `cwd`) so each
  project keeps separate state for pi-reflect.
- **`injection`** — the selection policy for WHAT gets surfaced in the system
  prompt each turn (see [Injection selection](#injection-selection-on-by-default)).
  ON by default: items are importance-ordered, capped at `maxPerKind` (default
  10) per kind and `maxTokens` (default 1500) total. Set `enabled: false` to
  restore the legacy "inject all items, in store order" behaviour.
- **`proposer`** — which delta proposer `/refine` and auto-refine use. Defaults
  to `signal` (cheap gate: detects tool errors, user corrections, task boundaries,
  explicit refine requests; escalates to steering only when signals fire).
  `steering` delegates reasoning to the agent. `dedupe` applies a rule-based
  dedupe directly. See [Proposers](#proposers).
- **`remindRefine`** — opt-in `turn_end` nudge. `{ "enabled": true,
  "everyTurns": 50 }` notifies you to run `/refine` on a cadence. It is
  informational only — it never mutates state.
- **`autoRefine`** — autonomous self-improvement (**on by default**, every turn).
  Runs a two-stage gate: (1) CHEAP `signal` proposer detects HIGH-SIGNAL turns
  (tool errors, user corrections, task boundaries, explicit refine requests);
  (2) Only if signals detected, ESCALATE to the configured proposer
  (default: `signal` which applies the signal note directly, or `steering` for
  full agent reasoning). This avoids noise from running expensive steering on
  low-signal turns while being genuinely online/reset-free. Reuses the exact
  `/refine` routine (audited `REFINE_ENTRY` tagged `source: "auto"`, branch-local,
  `/tree` rollback). Notifies before firing. `commit: true` also flushes durable
  state on each run.
- **`outcomeImportance`** — opt-in autonomous **promotion** loop (off by
  default). When `enabled`, a `turn_end` hook bumps (+`bump`, default 0.03)
  the importance of any active item the agent cited by its `[h_xxxx]` tag in the
  turn's output. Referenced items gain importance and get their `updatedAt`
  touched (so they survive time-based decay); ignored items keep decaying.
  Promotion only, never deletes, persisted/branchable like `harness_mutate`.
  Autonomous demotion from citations is intentionally NOT done (high false-positive);
  use `/harness drop`, `prune --decay`, or the `dedupe` proposer for that.
- **`outcomeEvaluation`** — opt-in **closed-loop outcome evaluation (B3)** (off
  by default). When `enabled`, automatically correlates applied deltas with
  task outcomes at `turn_end`: detects success/failure from tool errors and
  explicit user corrections ("salah", "sebenarnya", "harusnya", "perbaiki",
  "ulang"), then promotes (`promoteBump`, default 0.02) on success or demotes
  (`demotePenalty`, default 0.05) on failure. Items with failure ratio ≥
  `failureRatioThreshold` (default 0.5) after `minApplications` (default 3)
  are auto-demoted further. This closes the fitness loop: useful deltas rise,
  harmful ones retire. All mutations are audited, branch-local, and rollbackable
  via `/tree`.
- **`crossModel`** — enable cross-model shared pool (off by default). When
  enabled, models can opt-in to share items with `ownerModel="shared"`.

## How it works

1. `/refine` gathers recent trajectory evidence from the current session branch.
2. A **proposer** decides what to do. The default (`signal`) is a cheap rule-based
   gate that detects high-signal turns (tool errors, user corrections, task
   boundaries, explicit refine requests). When signals fire, it applies a signal
   note directly; alternatively, `steering` delegates to the agent via a steering
   message, and `dedupe` drops near-duplicate items. See [Proposers](#proposers).
3. The agent calls the tools (steering path) or deltas are applied directly;
   each mutation updates the in-memory state, snapshotted to the session via
   `appendEntry("harness-state", ...)`. New items are stamped with the active
   model (see [Model binding](#model-binding-per-model-isolation)).
   **When `subagent` or `skill` items are created/updated, they are automatically
   executed via the registered orchestrator**, closing the spec→execution→evidence loop.
4. Because pi's session tree branches at any entry, `/tree` navigation gives
   rollback to any pre-refinement point for free — no bespoke snapshot system.

This reuses the existing agent loop (no nested/hidden model calls), is
model-agnostic, and keeps every delta visible and reviewable in the transcript.

## Live sub-agent orchestration (A4)

`subagent` and `skill` items in the harness are not just static specs — they can
be **executed live**, closing the loop from self-improved knowledge to action
to outcome evidence.

### Sub-agent specs (`kind: "subagent"`)

Create a `subagent` item with a spec in one of these formats:

**YAML front-matter:**
```yaml
---
agent: "coder"
task: "Refactor the authentication module to use dependency injection"
async: true
limits:
  maxTurns: 20
  maxTokens: 10000
---
```

**JSON:**
```json
{
  "agent": "coder",
  "task": "Refactor the authentication module to use dependency injection",
  "async": true,
  "limits": { "maxTurns": 20, "maxTokens": 10000 }
}
```

**Plain text:** first line = agent name, rest = task.

When the item is created/updated via `harness_mutate`, the spec is parsed and
executed via the registered orchestrator (default: **pi-subagents** via steering
message to the `subagent` tool). Execution result is tracked and available in
the tool response.

### Executable skills (`kind: "skill"`)

Create a `skill` item with executable code in YAML front-matter:

```yaml
---
language: typescript
entryPoint: main
---
export async function main(args: { input: string }): Promise<{ output: string }> {
  return { output: args.input.toUpperCase() };
}
```

Supported languages: `typescript`/`ts`, `javascript`/`js`, `python`/`py`,
`shell`/`bash`/`sh`. Executed in a sandboxed temp directory with `tsx`/`node`/
`python3`/`bash`.

### Orchestrator backends

The orchestration layer is pluggable via `registerOrchestrator()`:

| Orchestrator | Description |
|---|---|
| `pi-subagents` (default) | Uses pi-subagents' `subagent` tool via steering message. Requires pi-subagents extension. |
| Custom | Implement `SubagentOrchestrator` interface and register. |

**Candidates for custom orchestrators:**
- **pi-boss + pi-room** (tmux-based, auto-register to room for peek/steer)
- **pi-dispatch** (deterministic fan-out/join/race as code)
- **pi-subagents** (async, resource-bounded, FleetView observability)

Glue code to wire harness `subagent` items to these backends is the responsibility
of the framework built on top of this package.

## Model binding (per-model isolation)

Every item is bound to exactly one model as `ownerModel` (`"provider/id"`). An
item is **only injected for the model it belongs to** — so switching to a
brand-new model id starts from a **blank harness**, and one model's notes never
leak into another's context. Binding is at the *exact* model id (not family or
vendor): a new version id is a clean slate, by design.

How the binding is set and respected:

- **Created items are stamped automatically** with the model driving the turn.
  The model-facing tools cannot read the active model, so `before_agent_start`
  (which always fires first in a turn, with the model) caches it; `harness_mutate`
  stamps creates from that cache, and direct-apply proposers stamp from their
  `ctx.model`. You never name the model yourself.
- **Injection filters by owner.** Only items whose `ownerModel` matches the
  active model are appended to the system prompt. An unknown model injects
  nothing.
- **`harness_list` defaults to the active model** (pass `model: "*"` for every
  model, or an explicit `"provider/id"`).
- **Orphan adoption.** Items with no owner — from a legacy session snapshot, an
  old durable file, or created while the model was unknown — are adopted by the
  active model on first contact (the next `before_agent_start`). This is the
  migration path: existing harnesses transition cleanly with no manual steps,
  and it's persisted as a normal `harness-state` entry (so `/tree` rollback
  covers it).
- **Durable round-trip preserves owner.** `/harness export` tags each item with
  `model: provider/id`; `/harness import` restores it. An item whose tag
  pi-reflect stripped becomes an orphan and is adopted by the active model.

Manual commands (`export`, `import`, `keep`, `drop`, `prune`, `push-mem`,
`status`) operate on the **whole store** by design — they are explicit human
actions with full control. Isolation is enforced only where pollution would
leak automatically: injection, listing, create-stamping, and the outcome loop.
In particular, `/harness push-mem` pushes *every* model's active items into
pi-mem by default (which can yield near-duplicate memories across models); pass
`--model <provider/id|active>` to scope it to one model.

## Injection selection (on by default)

The harness ACCUMULATES notes (create / refine / auto-refine / outcome-promotion),
but the system prompt is finite. So since 0.8 the block appended each turn is the
result of a **selection policy**, not the whole store — and it is **on by
default**. The store itself is never changed by selection (nothing is lost);
only what is *surfaced* changes.

The policy (pure, deterministic; `src/select.ts`):

1. **Filter** — only active items bound to the active model (strict per-model
   isolation, unchanged).
2. **Order** — importance desc; ties keep store/insertion order (stable). The
   highest-fitness notes lead each section.
3. **Cap** — `maxPerKind` (default 10: balanced sections, no single kind drowns
   the block), then `maxTokens` (default 1500: total budget). The budget is
   filled **round-robin across kinds by importance rank**, so one kind cannot
   starve the others; within that order an item that doesn't fit is **skipped**
   (not a hard stop), so a large item never blocks smaller higher-priority ones.

The defaults are deliberately generous — a **no-op for small stores** (nothing
trimmed) and protective as the harness grows. When the policy drops items, the
block ends with a one-line transparency note:

```
_(3 item(s) not shown — below the injection budget. Raise `injection.maxTokens`/`maxPerKind` in harness.json or run `/harness prune`.)_
```

Tune or disable it in `harness.json`:

```json
{ "injection": { "maxTokens": 3000, "maxPerKind": 20 } }   // raise the ceiling
{ "injection": { "maxPerKind": 5 } }                        // trim harder, per kind
{ "injection": { "enabled": false } }                       // opt out: legacy "all, in order"
```

Selection is factored into a pure function (`selectForInjection`) and
re-exported from the package entry, so a companion package can layer richer
policies (e.g. relevance to the current turn, via the shared `tokenize` /
`tokenOverlap` helpers) without touching `inject.ts`.

## Proposers

`/refine` is split into two stages: **propose** (given evidence + state, decide
what deltas to pursue) and **apply** (send a steering message, or apply returned
deltas directly). The propose stage is pluggable via a registry
(`src/proposer.ts`).

| Name | What it does |
|---|---|
| `signal` (default) | **Cheap gate**: detects HIGH-SIGNAL turns (tool errors, user corrections "sebenarnya/salah/bukan/kurang/harusnya", explicit refine requests "refine/perbaiki/catat", task boundaries). When signals fire, applies a signal note directly. No model call. |
| `steering` | Delegates reasoning to the agent via a steering message — reuses the agent loop, model-agnostic, fully visible. |
| `dedupe` | Rule-based: drops near-duplicate active items (token-overlap ≥ 0.6), keeping the higher-importance one. No model call. |

Select a proposer per run with `/refine --proposer <name>`, or set the default
for auto-refine via `proposer` in the [config](#configuration). Both paths are
audited: the `harness-refinement` entry records which proposer ran and how many
deltas it applied directly.

A dedicated-model proposer — one that makes its own (hidden) LLM call to
produce deltas directly — is the obvious next alternate. This package still
does **not** ship one (hidden model spend is a tradeoff kept as a separate
decision; see `docs/ROADMAP.md`), but it now **enables** one: when a model is
available, `/refine` injects a one-shot `complete(prompt, opts?)` into
`ProposeInput` and records any `modelCall` telemetry a proposer returns
(model, tokens, latency, ok/error) in the `harness-refinement` audit entry —
so a companion package can ship a dedicated-model proposer whose spend stays
**audited, not hidden**. One ships as a companion: **[pi-harness-model-proposer](https://github.com/pungggi/pi-harness-model-proposer)**
(`pi install npm:pi-harness-model-proposer`). Both `complete` and `modelCall` are optional;
`steering` and `dedupe` ignore them, so the default behavior is unchanged.

Register your own proposer from another extension (the registry is re-exported
from the package entry):

```ts
import { registerProposer } from "pi-continual-harness";

registerProposer({
  name: "my-proposer",
  async propose({ evidence, state, complete }) {
    // `complete` is injected when a model is available (undefined otherwise);
    // a dedicated-model proposer calls it and returns deltas + modelCall telemetry.
    /* inspect evidence + state, return deltas (and/or a steering message) */
    return { deltas: [/* { delta, rationale } */] };
  },
});
```

Then `"my-proposer"` is selectable via `/refine --proposer my-proposer` or
`"proposer": "my-proposer"` in the config.

## Scope and non-goals

- **In scope:** unified state store, online `/refine`, structured deltas,
  prompt injection, branching rollback, durable markdown export, live sub-agent
  orchestration, closed-loop outcome evaluation.
- **Out of scope (compose instead):** durable storage engines (pi-mem), offline
  deep refinement of behavioral files (pi-reflect), orchestrator backends
  (pi-boss / pi-room / pi-dispatch / pi-subagents — pick one and wire it).

## Status

0.8.x. Implemented:

- Unified harness-state store with branch-local snapshots (`/tree` rollback).
- Online `/refine` + `harness_mutate` / `harness_list` tools.
- Two-way durable round-trip with pi-reflect (`/harness import|export|status`).
- Importance hygiene: `/harness prune [--decay <days>]` and `/harness keep|drop
  <id>`.
- **pi-mem composition**: `/harness push-mem [--all|--kind|--model]` steers the agent
  to persist active items into pi-mem (soft-fail; no dependency).
- Optional config (`~/.pi/agent/harness.json`): project-local durable scope,
  remind, **auto-refine (on by default, every turn with signal gate)**,
  citation-based outcome promotion, **closed-loop outcome evaluation (opt-in)**,
  cross-model sharing.
- **Pluggable delta proposers** with a registry: `signal` (default gate),
  `steering`, `dedupe` shipped; `registerProposer()` for custom ones.
- **Per-model isolation**: every item is bound to a `provider/id` and injected
  only for that model; new items are stamped automatically and orphans adopted
  on first contact. A new model id starts from a blank harness, and the durable
  round-trip preserves the owner tag.
- **Bounded injection (on by default)**: the supplemental block is
  importance-ordered and capped per kind + by a total token budget.
- **Incremental evidence cursor (A1)**: only processes new trajectory since last refine.
- **Signal gate (A2)**: cheap rule-based proposer detects high-signal turns before escalating.
- **Default-on autonomy (A3)**: auto-refine runs every turn, but only escalates when signals detected.
- **Live sub-agent orchestration (A4)**: `subagent`/`skill` items auto-executed on create/update.
- **Closed-loop outcome evaluation (B3)**: automatic promote/demote based on tool errors and user corrections.

Open extension points (see `docs/ROADMAP.md`):

- A dedicated-model proposer (the enabler landed: `complete` injection +
  `modelCall` telemetry; the proposer logic itself is left to a companion
  package — the hidden-model-spend tradeoff is resolved by making the spend
  audited rather than shipping it invisible).
- Correction-side outcome signals (promotion is shipped; autonomous demotion
  is high-false-positive, so it is served by `/harness drop`, `prune --decay`,
  and the `dedupe` proposer — a fuzzy `corrections` proposer is the natural
  future extension).
- Domain action surface (B1) — separate extension for primitive actions.
- Cross-model knowledge transfer policy (B2) — isolate vs. shared pool.

## License

MIT