# Changelog

All notable changes to **pi-continual-harness** are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

Releases are tag-driven (`vX.Y.Z`) and published by GitHub Actions via npm
Trusted Publishing. This file begins at 0.7.0; earlier releases are recorded in
the git tags (`git tag -l`) and the [GitHub release history](https://github.com/pungggi/pi-continual-harness/releases).

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
