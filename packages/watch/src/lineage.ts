// The rebaseline protocol: what a rotation is, what it costs, and what it is not allowed to erase.
//
// A watch loses sensitivity the longer it runs quietly. That is not a bug and it cannot be patched
// away: `packages/detect/src/eprocess.ts` records the measurement and the trade-off, and the short
// version is that a procedure which never false-alarms must spend a finite error budget, so it must
// eventually go quiet. The operational answer is to start again from a fresh baseline.
//
// WHICH CREATES THE HOLE THIS FILE EXISTS TO CLOSE. If starting again is the remedy, then deleting
// the state file looks like the remedy too, and it is not: it produces a watch that reports a
// healthy evidence multiple, a short history and no alarms, having learned nothing and forgotten
// everything. That watch is indistinguishable from a genuinely fresh one, and it is worse than the
// blind watch it replaced, because the blind watch at least SAID it was blind.
//
// So a rotation is a deliberate act with three properties:
//
//   1. IT REQUIRES A NEW BASELINE ARTIFACT. Not a flag, not a reset, not an empty directory. A
//      snapshot that was actually collected, captured later than the one it replaces, against the
//      same corpus. `planRotation` refuses everything else and says which rule was broken.
//
//   2. IT CARRIES THE RECORD FORWARD. Alarm history, identity alerts and every previous rotation
//      survive. The e-process wealth does NOT, and must not: a new baseline means a new `p0`, so the
//      old wealth was accumulated against a different null and carrying it would be arithmetic on
//      two different questions. What carries is the HISTORY, so that a watch on its fourth baseline
//      cannot present itself as a watch that started this morning.
//
//   3. IT IS NOT AN ALARM. Needing a rotation is a maintenance signal. It never sets a regression
//      exit code, because "my instrument has gone dull" and "the provider got worse" are different
//      claims and this project exists to keep them apart.
//
// WHAT A ROTATION DOES NOT FIX. `p0` is a Wilson lower bound, so a thin baseline sits far below the
// true rate and bleeds sensitivity fast. Rotating onto another thin baseline buys a short reprieve
// and the same decline. `planRotation` warns when the replacement is no larger than what it
// replaces, because the actual cure is more replicates, not fresher ones.

import {
  type EProcessConfig,
  type EProcessState,
  evidenceMultiple,
  worstAdvice,
} from "@model-regression-sentinel/detect";
import type { RunSnapshot } from "@model-regression-sentinel/run";

/**
 * Enough of a baseline to tell one from another, and nothing more.
 *
 * Four fields, and each one is load-bearing for a refusal below. A label alone would let two
 * different collections share an identity; a digest alone could not order them in time.
 */
export interface BaselineIdentity {
  readonly label: string;
  readonly capturedAt: string;
  readonly corpusDigest: string;
  readonly replicates: number;
  /** Empty string when no successful call was ever made, which is itself worth recording. */
  readonly fingerprintSha256: string;
}

export const identityOf = (snapshot: RunSnapshot): BaselineIdentity => ({
  label: snapshot.label,
  capturedAt: snapshot.capturedAt,
  corpusDigest: snapshot.corpusDigest,
  replicates: snapshot.replicates,
  fingerprintSha256: snapshot.fingerprint?.sha256 ?? "",
});

/** Why a rotation happened. Recorded because "we rotated" and "we rotated because it went blind"
 *  are different histories, and only one of them suggests the baseline should have been larger. */
export type RotationReason =
  | "spent_sensitivity"
  | "stale_baseline"
  | "identity_changed"
  | "operator";

/**
 * The same four values, at runtime.
 *
 * A union exists only at compile time, so `flag(...) as RotationReason` at a CLI boundary was a cast
 * over unvalidated input: `--reason banana` was written verbatim into a permanent history that every
 * later reader switches on. The `satisfies` keeps this list and the type from drifting apart -
 * adding a member to one without the other stops compiling.
 */
export const ROTATION_REASONS = [
  "spent_sensitivity",
  "stale_baseline",
  "identity_changed",
  "operator",
] as const satisfies readonly RotationReason[];

export interface RotationRecord {
  readonly at: string;
  /** The generation being closed. The new one is this plus one. */
  readonly closedGeneration: number;
  readonly reason: RotationReason;
  readonly ticksServed: number;
  readonly observationsServed: number;
  /** How dull the watch had become when it was retired. The number that justifies the rotation. */
  readonly evidenceMultipleAtClose: number;
  /** Cases alarmed at the moment of closing. A rotation discards their wealth; this remembers them. */
  readonly casesAlarmed: readonly string[];
  readonly from: BaselineIdentity;
  readonly to: BaselineIdentity;
}

/**
 * The watch's history across baselines.
 *
 * OPTIONAL ON `WatchFile`, deliberately. A watch file is a durable artifact whose `schemaVersion` is
 * a literal 1 with no migration path, exactly like `EvalCase`, so evolution is optional fields only.
 * A file written before this existed has no lineage, and `lineageOf` reads that absence as
 * generation 1 with no rotations, which is the true statement about such a file rather than a
 * default standing in for one.
 */
export interface Lineage {
  readonly generation: number;
  readonly baseline: BaselineIdentity;
  readonly rotations: readonly RotationRecord[];
}

export const freshLineage = (baseline: BaselineIdentity): Lineage => ({
  generation: 1,
  baseline,
  rotations: [],
});

/** Ticks across every generation. What stops a rotated watch presenting itself as a new one. */
export const lifetimeTicks = (lineage: Lineage | undefined, currentTicks: number): number =>
  currentTicks + (lineage?.rotations ?? []).reduce((total, r) => total + r.ticksServed, 0);

export interface RotationPlan {
  readonly from: BaselineIdentity;
  readonly to: BaselineIdentity;
  readonly reason: RotationReason;
  readonly closingGeneration: number;
  readonly evidenceMultipleAtClose: number;
  readonly casesAlarmed: readonly string[];
  /** Non-fatal. A rotation that is legal and still a bad idea, said out loud. */
  readonly warnings: readonly string[];
}

export type RotationDecision =
  | { readonly ok: true; readonly plan: RotationPlan }
  | { readonly ok: false; readonly refusals: readonly string[] };

export interface PlanRotationInput {
  readonly current: BaselineIdentity;
  readonly lineage: Lineage | undefined;
  readonly states: readonly EProcessState[];
  readonly candidate: RunSnapshot;
  /** How many cases the candidate can actually seed. Computed by the caller, which does the grading. */
  readonly seedableCases: number;
  readonly reason: RotationReason;
  readonly config?: EProcessConfig;
}

/**
 * Decide whether a proposed rotation is legal, and say precisely why not when it is not.
 *
 * Pure: no clock, no filesystem. Returns EVERY refusal rather than the first, because a caller who
 * fixes one and re-runs only to hit the next learns to distrust the tool.
 */
export function planRotation(input: PlanRotationInput): RotationDecision {
  const to = identityOf(input.candidate);
  const from = input.current;
  const refusals: string[] = [];
  const warnings: string[] = [];

  // THE CENTRAL GUARD. Rotating onto the baseline already being watched would clear the debt while
  // changing nothing about what the watch is measuring, which is precisely the silent reset this
  // protocol exists to prevent.
  if (
    to.label === from.label &&
    to.capturedAt === from.capturedAt &&
    to.corpusDigest === from.corpusDigest
  ) {
    refusals.push(
      "the proposed baseline IS the one already being watched. A rotation needs a newly collected snapshot; clearing the debt without changing the reference would reset the instrument and measure nothing new.",
    );
  }

  if (to.capturedAt <= from.capturedAt) {
    refusals.push(
      `the proposed baseline was captured at ${to.capturedAt}, no later than the current one at ${from.capturedAt}. A rotation moves forward in time; adopting an older reference is a different operation and this command will not do it silently.`,
    );
  }

  if (to.corpusDigest !== from.corpusDigest) {
    refusals.push(
      `the proposed baseline was collected against corpus ${to.corpusDigest.slice(0, 16)} and this watch is pinned to ${from.corpusDigest.slice(0, 16)}. That is a different question, not a fresher answer to the same one. Start a new watch instead.`,
    );
  }

  if (input.seedableCases === 0) {
    refusals.push(
      "the proposed baseline grades no case, so there is nothing to seed an e-process from. A watch built on it would bet against a rate nobody measured.",
    );
  }

  if (refusals.length > 0) return { ok: false, refusals };

  if (to.replicates <= from.replicates) {
    warnings.push(
      `the replacement carries ${to.replicates} replicates against the previous ${from.replicates}. p0 is a Wilson lower bound, so a baseline this size will bleed sensitivity at the same rate and be blind again on the same schedule. More replicates is the cure; fresher ones are a reprieve.`,
    );
  }
  if (to.fingerprintSha256 !== from.fingerprintSha256 && from.fingerprintSha256 !== "") {
    warnings.push(
      "the provider identity differs between the two baselines. That is a fact worth recording and it also means the new reference describes a different served model, so alarm history from before the rotation is about something else.",
    );
  }

  const advice = worstAdvice(input.states, input.config);
  return {
    ok: true,
    plan: {
      from,
      to,
      reason: input.reason,
      closingGeneration: input.lineage?.generation ?? 1,
      evidenceMultipleAtClose: advice?.evidenceMultiple ?? 1,
      casesAlarmed: input.states
        .filter((s) => s.alarmed)
        .map((s) => s.caseId)
        .sort(),
      warnings,
    },
  };
}

/** The record a completed rotation leaves behind. */
export function rotationRecord(
  plan: RotationPlan,
  states: readonly EProcessState[],
  ticksServed: number,
  at: string,
): RotationRecord {
  return {
    at,
    closedGeneration: plan.closingGeneration,
    reason: plan.reason,
    ticksServed,
    observationsServed: states.reduce((total, s) => total + s.observations, 0),
    evidenceMultipleAtClose: plan.evidenceMultipleAtClose,
    casesAlarmed: plan.casesAlarmed,
    from: plan.from,
    to: plan.to,
  };
}

/** The evidence multiple of the dullest case, for a report. Null when the watch has no cases. */
export const worstMultiple = (
  states: readonly EProcessState[],
  config?: EProcessConfig,
): number | null =>
  states.length === 0
    ? null
    : states.reduce((worst, s) => Math.max(worst, evidenceMultiple(s, config)), 0);
