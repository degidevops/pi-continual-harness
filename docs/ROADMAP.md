# Roadmap — pi-continual-harness

Living implementation plan for the self-improvement loop. Phased so each phase
is independently shippable, fully tested, and low-risk before the next begins.

## Guiding constraints (do not regress)

- **Manual by default** — no autonomous mutation unless explicitly opt-in.
- **Structured, evidence-backed deltas** — every mutation is visible in the transcript.
- **Branch-local state + `/tree` rollback** is the safety net.
- **Compose, don't reinvent** — pi-reflect (offline), pi-mem (storage).

## Phase 0 — DONE (0.2.0)

Two-way durable seam: `parseDurable()` + `reconstructFromDurable()` +
`/harness import|export|status`. The pi-reflect round-trip closes:
`/refine --commit → harness-state.md → /reflect edits → /harness import → store`.

## Phase 1 — DONE (main; unreleased)

- **A. Prune** — `/harness prune [--decay <days>]`; `decayAndPrune()` first ages
  importance (−step for items older than N days) then drops below floor.
- **B (phase 1). Human signal** — `/harness keep|drop <id>` via `bumpImportance()`.

Shipped: store unit tests + `/harness` command smoke tests. **Effort:** ~70 lines. **Risk:** low.

## Phase 2 — DONE (main; unreleased)

- Config at `~/.pi/agent/harness.json` + a `loadConfig()` reader (`src/config.ts`).
- **F. Project-local durable path** — `durableScope: "global"|"project"`;
  `resolveDurablePath()` derives a stable slug from `cwd`.
- **C-reminder.** Opt-in `turn_end` reminder (`src/remind.ts`) every N turns —
  notify only, never mutates.

Shipped: config loader + slug derivation + reminder cadence tests (14 new). **Effort:** ~190 lines. **Risk:** low.

## Phase 3 — DONE (main; unreleased)

- **C auto-refine** — opt-in `turn_end` auto-refine (`src/auto-refine.ts`), behind
  `autoRefine: { enabled, everyTurns, commit }` in config (default off, 100).
  Reuses the exact `runRefine()` routine (extracted from `/refine`), so it
  inherits all safety props: audited `REFINE_ENTRY` tagged `source: "auto"`,
  branch-local snapshots, `/tree` rollback. Visible: notifies before firing.
  **Effort:** ~110 lines. **Risk:** medium (autonomy) — mitigated by opt-in +
  cadence + audit + visibility + rollback.

## Phase 4 — DONE (main; unreleased)

- **D. Pluggable proposer** — `DeltaProposer` interface + registry
  (`src/proposer.ts`). `runRefine()` is now proposer-driven: it resolves a
  proposer, calls `propose({ evidence, state, lookback })`, then either applies
  returned deltas directly (persisted via `harness-state` entries, so `/tree`
  rollback covers them) or sends a steering message. Two proposers shipped:
  `steering` (default, behavior-preserving) and `dedupe` (rule-based: drops
  near-duplicate active items by token Jaccard, keeping higher-importance).
  Selectable via `/refine --proposer <name>` or `proposer` in config; the
  registry is re-exported from the package entry (`registerProposer`).
  **Effort:** ~230 lines (proposer.ts + runRefine refactor + tests). **Risk:**
  medium — mitigated by keeping the default behavior-preserving and the
  hidden-model-spend variant out of scope (documented as a future decision).

## Phase 5 — DONE (main; unreleased)

- **E. pi-mem push** — `/harness push-mem [--all|--kind <kind>]` composes with
  pi-mem by **steering** the agent to call pi-mem's `save_memory` for each
  active item. No dependency on pi-mem — tool-agnostic and soft-fail (the agent
  says "install pi-mem" if no memory tool is present). Default scope is the
  memory kind (the clean 1:1 mapping); `--all` / `--kind` override. The harness
  store is read-only for a push. **Effort:** ~55 lines. **Risk:** low.
- **B (phase 2). Outcome loop** — opt-in `turn_end` reference-promotion hook
  (`src/outcome.ts`) behind `outcomeImportance: { enabled, bump }` in config
  (default off, 0.03). When the agent cites an active item by its `[h_xxxx]`
  tag, importance is bumped (+bump, clamped, persisted via the same
  `harness-state` entries → branch-local / `/tree` rollback) and `updatedAt` is
  touched (so promoted items survive time-based decay). This closes the outcome
  half of the fitness loop: useful items rise, ignored items keep decaying.
  **Hard scope cut:** CORRECTION/demotion from outcomes is genuinely fuzzy and
  high-false-positive, so it is intentionally NOT autonomized — demotion stays
  with the existing audited primitives (`/harness drop`, `prune --decay`, the
  `dedupe` proposer); a fuzzy `corrections` proposer is the natural future
  extension via the Phase 4 registry.
  **Effort:** ~95 lines. **Risk:** medium (autonomy) — mitigated by opt-in +
  promotion-only + persist/rollback + visibility.

## Out of scope (compose instead)

Durable storage engines (pi-mem), offline deep refinement (pi-reflect),
live sub-agent orchestration (pi-boss / pi-room).
