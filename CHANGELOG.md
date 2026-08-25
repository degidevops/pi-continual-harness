# Changelog

All notable changes to **pi-continual-harness** are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

Releases are tag-driven (`vX.Y.Z`) and published by GitHub Actions via npm
Trusted Publishing. This file begins at 0.7.0; earlier releases are recorded in
the git tags (`git tag -l`) and the [GitHub release history](https://github.com/pungggi/pi-continual-harness/releases).

## [Unreleased]

### Evolution v2 — from storing facts to evolving how the model acts

- **Process heuristics in refine prompts**: the steering prompt (and signal-gate
  escalation) now instructs the refiner to encode lessons as CONDITIONAL
  DECISION RULES — "When X / Before Y → do Z" — instead of bare facts. Rules
  are actionable at decision time; the outcome fitness loop then selects rules
  that actually work.
- **Fair trials for repaired items**: a `harness_mutate` update that changes an
  item's content resets its applications/failures counters and clears
  lastOutcomeAt. A repaired skill starts unprejudiced instead of being condemned
  by pre-repair failures (paper §4.6). Importance/active-only updates keep
  history.
- **Auto-consolidation (ACE grow-and-refine)**: new opt-in config
  `{ "consolidate": { "enabled": true, "everyTurns": N } }` — every N turns run
  the dedupe proposer then decay/prune, so the store stays healthy without
  manual /harness commands. Audited + rollbackable like all mutations.
- **Injection attribution in refine evidence**: evidence now lists which harness
  items were injected during the window (recorded at before_agent_start), letting
  the refiner distinguish "failed BECAUSE note X was wrong" (update X) from
  "failed because X was missing" (create new). Also restores the previously
  lost "items flagged for repair" evidence section.

### Quiet background operation (default ON)

- **Autonomous paths are silent BY DEFAULT now**: informational messages from
  auto-refine, outcome loops, consolidation, sub-agent outcomes, and session
  restores are demoted to audited `harness-event` entries instead of chat
  popups; the every-turn gate status flash is skipped; auto-refine info
  notifications are suppressed while warnings/errors and manual command
  feedback stay visible. Opt out with `"quiet": false` for verbose mode.
- **Anti-self-trigger gate**: `detectSignals` strips refine-echo lines (prior
  steering prompts and no-op replies) before detection — the gate can no longer
  re-trigger on its own output, which was causing endless no-op refine cycles.
- **`tool_error` removed from the AUTONOMOUS gate** (`includeToolError: false`):
  ordinary dev output (vitest/tsc failures) contains "error" and lingers in the
  lookback window for dozens of turns, re-triggering refine every cycle even
  after restarts. Manual `/refine --proposer signal` still sees tool errors;
  autonomous escalation now relies on user corrections, repetition loops,
  skill failures, and explicit requests.

### Memory / skill / sub-agent systems made real

- **Progressive disclosure for skills**: executable skills render only their
  `description:` front-matter (or a derived first-line fallback) plus an
  execution pointer in the system prompt — never the code body. Cost estimation
  matches, so a 50-line skill costs ~1 line of injection budget.
- **Skill repair loop closed**: net-failing items (`getFailingItems()`)
  are always surfaced to the refiner under "items flagged for repair", and the
  signal gate fires a new `skill_failure` signature so auto-refine targets
  their repair even on otherwise-quiet turns (paper §4.6).
- **Relevance-aware memory selection**: `selectForInjection` accepts the latest
  user message; memories/notes overlapping it earn a small saturating bonus
  (≤ 0.1) on top of fitness — what gets injected now matches what is happening
  NOW without drowning authored importance.
- **Sub-agent outcome reconciliation**: launched sub-agent runs are tracked by
  runId and reconciled at turn_end against trajectory entries; completions
  resolve to success/failure recorded against the spec item's delta. Request-
  echo entries never fabricate outcomes; stale runs (>30 min) are dropped.
  Sub-agent specs are no longer evolution-blind.
- **Fixed recurring "Agent is already processing" error** (`Extension
  "<runtime>"`): steering messages sent from turn_end auto-refine and
  `/harness push-mem` now pass `{ deliverAs: "steer" }`, queuing correctly when
  the agent is still streaming instead of throwing.

### Evolution-loop effectiveness (grounded in arXiv 2605.09998 + ACE 2510.04618)

- **Failure-signature gate** (`src/signals.ts`, single source of truth): the
  signal gate now detects the paper's failure signatures — tool errors, user
  corrections, explicit refine requests, task boundaries, and a NEW
  `repetition_loop` signature (the same attempt ≥3× in a window = the
  navigation-loop analog). turn_end auto-refine calls the detector directly.
- **Targeted escalation instead of noise**: when signatures fire, the gate
  returns a steering message that NAMES them with per-signature diagnosis
  guidance — it no longer creates a generic "Signal detected" prompt note
  (store noise that violated evidence-groundedness).
- **Outcome-aware injection ranking** (`select.ts`): injected items are ranked
  by fitness = importance + up to 0.05 bonus from the applications/failures
  record (saturating at 5 outcomes). Proven items rise; failing ones sink;
  authored importance can never be drowned by outcome data.
- **Decay resistance**: items with a net-positive outcome record
  (applications > failures) skip time-based decay entirely — skills that keep
  proving themselves don't age out while they keep winning.
- **Execution→outcome loop closed**: `/harness run-skill` and yolo-path skill
  executions record success/failure against the item's deltaId, so broken
  skills are flagged for repair via the B3 fitness loop (paper §4.6: repair
  code that raised exceptions).
- **Steering follow-through nudge**: if a steering refine is sent and no
  `harness_mutate` follows within 10 minutes, turn_end surfaces it once —
  refinements can no longer be silently dropped.
- **Bootstrap compounding**: `autoRefine.commit` now defaults to `true` when
  auto-refine is enabled — each refine flushes durable state for
  `/harness import`, because a refined harness carried into the next session
  beats a frozen one (paper §4.3: bootstrap-updating > bootstrap-frozen).

## [0.8.x — safety & correctness, unreleased]

Safety-and-correctness release: execution is confirm-by-default, autonomous
mutation is opt-in again (matching the documented stance), and several latent
bugs in the outcome loop and signal gate are fixed.

### Changed (breaking)

- **`orchestration` default is now `{ enabled: true, mode: "confirm" }`
  (was `yolo`).** Model-authored `subagent`/`skill` items are stored but never
  auto-executed; run them explicitly with `/harness run-skill <id>` /
  `/harness run-subagent <id>`. Set `mode: "yolo"` to restore full-auto.
  The old confirm mode silently auto-approved — the placeholder is gone;
  confirmation is now a real user action.
- **`autoRefine.enabled` default is `false` again** (was `true`), matching the
  documented opt-in stance and every other autonomous path. Enable explicitly
  with `{ "autoRefine": { "enabled": true } }`.

### Fixed

- A1 rollback bug: a failed delta batch no longer resets the review cursor
  (`applyDeltas` snapshots cursor fields too).
- B3 tracking appends instead of overwrites: multiple `harness_mutate` calls in
  one turn are all evaluated, and signal-gate exclusions accumulate correctly.
- Signal-gate tool-error detection actually matches rendered evidence
  (`[toolResult] … error`, not just `[tool] … error`).
- Outcome-evaluation failure detection accepts any entry with `data.isError`
  (not only `customType === "tool_call"`) and recognizes English corrections
  ("sorry", "my mistake", "revert", "that's wrong") alongside Indonesian ones.
- Orchestration executors hardened: `entryPoint` must be a plain identifier;
  args cross into JS/TS wrappers as JSON-string literals and into Python via a
  side-car `args.json` file — no more string interpolation injection vectors.
- Flaky `run-skill` test no longer depends on `npx tsx` being downloadable.

### Moved

- `extensions/domain-actions` → `examples/domain-actions` (it imported a
  hypothetical package and was never loadable).

## [0.8.0] — 2026-08-10

The bounded-injection release. The harness ACCUMULATES notes, but the system
prompt is finite — so selection is now ON BY DEFAULT: injected items are
importance-ordered, capped per kind, and bounded by a total token budget. The
store itself is unchanged (nothing is ever lost — only what is *surfaced*
changes), and the whole policy is opt-out via `injection.enabled: false`.

### Added

- **Injection selection policy (on by default)** — `src/select.ts` decides
  WHICH active items for the active model get surfaced each turn, and in what
  order. Pure and fully unit-tested; `inject.ts` is now thin glue over it.
  Policy: (1) filter to active + owner-model items (strict per-model isolation,
  unchanged); (2) order by importance desc, ties stable on store index; (3) cap
  via `maxPerKind` (balanced sections — no single kind drowns the block) then
  `maxTokens` (total budget, filled round-robin across kinds by importance rank
  so one kind can't starve the others; an item that doesn't fit is *skipped*, not
  a hard stop, so a large item never blocks smaller higher-priority ones).
- **Config: `injection`** in `harness.json` — `{ enabled, maxTokens, maxPerKind,
  charsPerToken }`, always resolved by `loadConfig`. Shipped defaults: `enabled:
  true`, `maxTokens: 1500`, `maxPerKind: 10`, `charsPerToken: 4` — generous
  enough to be a NO-OP for small stores (nothing trimmed) and protective as the
  harness accumulates. Opt out with `injection.enabled: false` → legacy "all
  items, in store order".
- **Transparency footer** — when the policy drops items, the injected block ends
  with a one-line `_(N item(s) not shown — below the injection budget…)_` note,
  so a bounded block is never silently truncated.
- **Public API** — `selectForInjection`, `normalizeInjection`, `estimateTokens`,
  `DEFAULT_INJECTION`, and the `InjectionConfig` / `NormalizedInjection` types
  are re-exported from the package entry for companion packages and tests.

### Changed

- `renderHarnessBlock(ownerKey?, cfg?)` now renders the selected subset (defaults
  apply when `cfg` is omitted, so direct callers — including existing tests —
  get the new policy). `before_agent_start` reads `injection` from config and
  passes it through.
- Default injection is now importance-ordered. This reorders (and, for large
  stores, trims) the supplemental block, but changes no data: items remain in the
  store, `/tree` rollback is unaffected, and the durable round-trip is
  unchanged. Set `injection.enabled: false` to restore the pre-0.8 block exactly.

### Docs

- README: new "Injection selection (on by default)" section + `injection` in the
  config block; Status updated. MANUAL: injection-selection section. ROADMAP:
  Phase 7. 25 new tests (`test/select.test.ts` + injection/config/integration
  coverage); 137 total, typecheck clean.

## [0.7.0] — 2026-08-09

The per-model isolation release. Every item is bound to an exact `provider/id`
and injected only for the model it belongs to — a brand-new model id starts from
a blank harness, and one model's notes never leak into another's context.

### Added

- **Per-model isolation (`ownerModel`).** Every item now carries an
  `ownerModel` (`"provider/id"`, or `""` for an orphan) and is injected only for
  the model it belongs to. Binding is at the exact id by design — a new version
  is a clean slate.
  - Creates are stamped automatically: `before_agent_start` caches the active
    model (the model-facing tools receive no `ctx`), then `harness_mutate` and
    direct-apply proposers stamp creates from it.
  - **Orphan adoption** is the migration path: items with no owner (legacy
    session snapshots, old durable files, or created while the model was
    unknown) are adopted by the active model on first contact — persisted as a
    normal `harness-state` entry, so `/tree` rollback covers it.
  - `harness_list({ model? })` — defaults to the active model's items; `"*"`
    returns every model; an explicit `"provider/id"` filters.
- **`/harness push-mem --model <provider/id|active>`** — scope a pi-mem push to
  one model's items (`active` resolves to the model driving the command).

### Changed

- **Durable round-trip preserves owner** via a per-item `model:` line; an
  untagged item degrades to an orphan and is adopted on import/first contact.
- Injection, `harness_list`, and the outcome loop are model-scoped; the `dedupe`
  proposer no longer compares items across models.
- `/harness status` shows whole-store kind counts, annotated with the active
  model's share.

### Fixed

- **`harness_mutate` isolation** (PR review): `update`/`delete` are now scoped
  to the active model too — an agent on model A can no longer mutate model B's
  item by id (atomic rollback with a clear error). Cross-model maintenance paths
  (`dedupe`, `/harness keep|drop|prune`) pass no actor and are unaffected.
- **Durable owner semantics** (PR review): an absent `model:` tag on an existing
  item now orphans it (→ adopted by the active model) instead of silently
  keeping the old owner — "durable wins" now covers owner uniformly.
- `session_start` resets the cached active-model key across fork/resume.

### Docs

- README + MANUAL model-binding sections; MANUAL updated for the review fixes
  (`harness_mutate` actor scoping, model-aware `dedupe`, model-scoped outcome,
  whole-store `status`); ROADMAP Phase 6; stale `0.5.x` version strings
  corrected; this CHANGELOG introduced.
- Cross-linked the [pi-harness-model-proposer](https://github.com/pungggi/pi-harness-model-proposer)
  companion.

### Internal

- 19 files changed (+876/−52 over 0.6.2). **112 tests** (+25), typecheck clean;
  new `test/model-binding.test.ts`. Durable format and tool schemas extended
  backward-compatibly (missing `ownerModel` → orphan → adopted).
