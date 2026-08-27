// The public surface of @model-regression-sentinel/watch.
//
// Hand-curated, never `export *`. A wildcard barrel publishes whatever happens to be exported today,
// which turns every internal rename into somebody else's breaking change and makes the package's API
// impossible to review in one place. THIS LIST IS THE API: a name that is not here is internal and
// may move without a major version.
//
// Ordered so it reads top to bottom: the state a watch carries between looks, then the look itself,
// then the text that tells an operating system when to take one.

// ---- the state a watch carries between looks ---------------------------------------------------------
export { initWatchFile, readWatchFile, writeWatchFile } from "./state.js";

// ---- one look, and what a look is allowed to conclude --------------------------------------------------
export { tick, tickExitCode } from "./tick.js";

// ---- scheduling, which is the operating system's job and not this package's -------------------------------
export { GITHUB_ACTIONS_HINT, LAUNCHD_HINT, cronSuggestion } from "./schedule.js";

// ---- types ------------------------------------------------------------------------------------------------
export { lineageOf, rotateWatchFile } from "./state.js";
export {
  freshLineage,
  identityOf,
  lifetimeTicks,
  planRotation,
  rotationRecord,
  worstMultiple,
  ROTATION_REASONS,
} from "./lineage.js";
export { debtReport, renderDebt } from "./debt.js";
export type { Confirmation, IdentityAlert, InitWatchInput, WatchFile } from "./state.js";
export type {
  BaselineIdentity,
  Lineage,
  PlanRotationInput,
  RotationDecision,
  RotationPlan,
  RotationReason,
  RotationRecord,
} from "./lineage.js";
export type { CaseDebt, DebtReport } from "./debt.js";
export type { TickInput, TickResult, TickStatus } from "./tick.js";
