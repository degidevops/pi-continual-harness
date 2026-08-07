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

## Phase 3 — autonomy (opt-in)

- **C auto-refine** — `autoRefine: { enabled, everyTurns }` behind config; reuses
  the `/refine` steering message.
  **Mitigations:** default off, frequency cap, audit entry already emitted, branch-local + rollback.

**Effort:** ~80 lines. **Risk:** medium (autonomy).

## Phase 4 — proposer quality (the big lever)

- **D. Pluggable proposer** — `DeltaProposer` interface (`propose(evidence, state)`).
  Default = current steering (visible). Opt-in alternates: a dedicated-model
  proposer (hidden call) or a rule-based proposer ("same correction twice → note").

**Effort:** ~80 lines refactor. **Risk:** medium (tradeoff: a hidden model call).

## Phase 5 — composition + outcome loop

- **E. pi-mem push** — `/harness push-mem` steering → pi-mem `save_memory`;
  soft-fail if pi-mem absent.
- **B (phase 2). Outcome loop** — `turn_end` instrumentation nudges importance
  from injected-item reference + correction signals.

**Effort:** E ~30 lines; B-phase-2 medium-high. **Risk:** low (E), medium (B-2).

## Out of scope (compose instead)

Durable storage engines (pi-mem), offline deep refinement (pi-reflect),
live sub-agent orchestration (pi-boss / pi-room).
