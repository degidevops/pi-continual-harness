// Continual Harness — core types.
//
// Design notes (see README for the full rationale):
//  - Four components per Continual Harness (arXiv 2605.09998): prompt, memory,
//    skill, sub-agent spec. Each item carries `evidence` grounding it in the
//    trajectory and an `importance` fitness signal (ACE-style).
//  - Mutations are expressed as structured CRUD deltas, never as prose prompt
//    rewrites. This follows ACE (arXiv 2510.04618): itemized, deterministic
//    merges prevent context collapse and brevity bias.
//  - The store is session-scoped (reset-free, online). A durable markdown
//    export is the composition seam with pi-reflect / pi-mem (see store.ts).
//  - Cross-model sharing: items can be promoted to a shared pool (ownerModel: "shared")
//    after validation. Models can opt-in via config.
//  - Outcome tracking: delta applications are correlated with task outcomes to
//    automatically demote/retire ineffective items.

/** The four Continual Harness components. */
export type ComponentKind = "prompt" | "memory" | "skill" | "subagent";

/** Model ownership policy. */
export type OwnerModel = string; // "provider/id" | "shared" | "" (orphan)

/** A single item in the unified harness store. */
export interface HarnessItem {
  id: string;
  kind: ComponentKind;
  /** Payload: a prompt note, a memory fact, a skill description, or a sub-agent spec. */
  content: string;
  /** Why this item exists, grounded in trajectory evidence. Required for every create. */
  evidence: string;
  /** Fitness signal in [0,1]. Items below a threshold can be pruned/deactivated. */
  importance: number;
  /** Whether the item is injected into the system prompt each turn. */
  active: boolean;
  /**
   * The model this item is bound to:
   *   - "provider/id" — strict per-model (default)
   *   - "shared" — cross-model promoted item, injected for all opted-in models
   *   - "" (empty) — orphan, adopted by first model to claim it
   */
  ownerModel: OwnerModel;
  createdAt: number;
  updatedAt: number;
  /** Outcome tracking (Phase 3 / B3):
   *  - deltaId: the delta that created/updated this item
   *  - applications: count of times this item was injected and the task succeeded
   *  - failures: count of times this item was injected and the task failed
   *  - lastOutcomeAt: timestamp of last outcome correlation
   *  When failures > applications * threshold, item is auto-demoted.
   */
  deltaId?: string;
  applications?: number;
  failures?: number;
  lastOutcomeAt?: number;
  /** Archived prior contents (RHI-style revision history, newest last).
   *  Filled when a content update repairs the item; bounded to the most
   *  recent MAX_REVISIONS entries. Enables "which variant worked best?"
   *  comparisons instead of judging a repair by its predecessor's record. */
  revisions?: ArchivedRevision[];
}

export interface HarnessState {
  items: HarnessItem[];
  /** Cross-model sharing config (Phase 3 / B2). */
  crossModel?: {
    /** When true, models opted-in via config share items with ownerModel="shared". */
    enabled: boolean;
    /** Models that have opted into shared pool (provider/id). */
    optedInModels: string[];
  } | undefined;
  /** Outcome tracking config (Phase 3 / B3) — for manual /harness outcome. */
  outcomeTracking?: {
    /** Minimum applications before demotion consideration. */
    minApplications: number;
    /** Failure ratio threshold for auto-demotion (failures / applications). */
    failureRatioThreshold: number;
    /** Importance penalty on demotion. */
    demotionPenalty: number;
  } | undefined;
  /** Closed-loop outcome evaluation config (B3) — for automatic outcome correlation. */
  outcomeEvaluation?: {
    enabled: boolean;
    promoteBump: number;
    demotePenalty: number;
    minApplications: number;
    failureRatioThreshold: number;
  } | undefined;
  /** Cursor for incremental evidence gathering (A1). */
  lastReviewedTurn?: number;
  lastReviewedIndex?: number;
}

/** Structured CRUD delta. The unit of self-improvement. */
export type Delta =
  | {
      op: "create";
      kind: ComponentKind;
      content: string;
      evidence: string;
      importance?: number;
      /** Owner "provider/id" | "shared". Stamped server-side from the active model when the
       *  agent omits it; set explicitly by direct-apply proposers. Absent → orphan. */
      ownerModel?: OwnerModel;
      /** Unique ID for this delta application (for outcome tracking). */
      deltaId?: string;
    }
  | {
      op: "update";
      id: string;
      content?: string;
      evidence?: string;
      importance?: number;
      active?: boolean;
      /** Reassign ownership (rare; used by migration/import). Absent → keep current. */
      ownerModel?: OwnerModel;
    }
  | { op: "delete"; id: string; reason: string };

/** Outcome event for closed-loop evaluation (Phase 3 / B3). */
export interface OutcomeEvent {
  /** The delta ID that was applied. */
  deltaId: string;
  /** Whether the task/turn succeeded. */
  success: boolean;
  /** Turn index for correlation. */
  turnIndex: number;
  /** Optional error/context. */
  error?: string;
}

/** Result of applying a single delta; returned to the model for confirmation. */
export type AppliedDelta =
  | { op: "create"; item: HarnessItem }
  | { op: "update"; before: HarnessItem; after: HarnessItem }
  | { op: "delete"; id: string; reason: string };

export const KIND_LABEL: Record<ComponentKind, string> = {
  prompt: "Supplemental prompt notes",
  memory: "Memory facts",
  skill: "Skill descriptions",
  subagent: "Sub-agent specs",
};

/** A prior content version archived when an item is repaired (RHI-style). */
export interface ArchivedRevision {
  content: string;
  importance: number;
  applications: number;
  failures: number;
  archivedAt: number;
}