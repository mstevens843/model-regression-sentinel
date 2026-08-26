// The machine-readable report, and the reason it is canonical rather than merely valid.
//
// WHY canonicalJson AND NOT JSON.stringify. This document's main consumer is `diff`. A drift report
// is produced on a schedule, checked into a repository or an artifact store, and read by someone
// asking what changed between Tuesday and Wednesday. `JSON.stringify` emits keys in insertion
// order, so rebuilding the same logical report with two fields constructed in a different order
// changes the bytes while nothing about the run did. A report that churns on key order trains its
// reader to ignore its diffs, and the first time it does that it has destroyed the only thing it
// was for. `canonicalJson` sorts keys by code unit at every depth and emits a stable two-space
// indent, so a byte difference between two reports is a difference in a measurement.
//
// NON-FINITE NUMBERS ARE EMITTED AS null, AND THE REASON TRAVELS BESIDE THEM. `calibratedP` is NaN
// when the baseline had too few replicates to split, and `noiseFloor95` is NaN with it.
// `canonicalJson` refuses to serialize a NaN, and is right to: writing it as null silently would
// let "the second null was not measured" and "the second null came back at zero" hash the same. So
// every such field is nulled deliberately AND accompanied by `calibrated`, a boolean that says
// which of the two happened. A consumer that reads `calibratedP: null` alone still cannot conclude
// anything, and that is correct: `exceedsNoiseFloor: null` is not `false`.
//
// THE EXIT CODE IS IN THE DOCUMENT, BOTH WAYS. `exitCode` is what this result returns under the
// default `confirmed` gate; `exitCodeUnderSuspectedGate` is what a team that opted into the
// stricter gate would get. Printing both means a pipeline can be re-configured without re-running
// a comparison, and it means nobody has to reimplement `exitCodeFor` from the verdict string.
//
// WHAT WAS REJECTED. A `summary` string field duplicating the markdown prose: two renderings of the
// same finding drift apart, and the machine-readable one is the copy that gets parsed. Floats
// rounded for display: rounding belongs to the renderer that shows a human, and a rounded number in
// a machine document cannot be un-rounded. Timestamps generated at render time: this file would
// then differ on every run for a reason that is not a measurement, which is the exact failure the
// canonical form exists to prevent.
//
// WHAT THIS IS NOT: a snapshot format. It carries no raw outputs and cannot be re-graded. The
// RunSnapshot is the archive; this is a view of one comparison of two of them.

import {
  type CompareResult,
  type MetricFinding,
  exitCodeFor,
} from "@model-regression-sentinel/detect";
import { canonicalJson } from "@model-regression-sentinel/spec";
import { type ReportContext, finite } from "./format.js";
import { gatesFor } from "./ledger.js";

/** Options are context, not configuration. Nothing here can change a verdict or an exit code. */
export type JsonOptions = ReportContext;

/** Bumped when a field is removed or its meaning changes. Adding a field does not bump it. */
export const REPORT_SCHEMA_VERSION = 1;

export function renderJson(result: CompareResult, options: JsonOptions = {}): string {
  return canonicalJson({
    schemaVersion: REPORT_SCHEMA_VERSION,
    verdict: result.verdict,
    reason: result.reason,
    exitCode: exitCodeFor(result, "confirmed"),
    exitCodeUnderSuspectedGate: exitCodeFor(result, "suspected"),
    alpha: result.alpha,
    arms: {
      baseline: {
        label: result.baselineLabel,
        capturedAt: result.baselineCapturedAt,
        replicates: result.replicates.baseline,
      },
      candidate: {
        label: result.candidateLabel,
        capturedAt: result.candidateCapturedAt,
        replicates: result.replicates.candidate,
      },
      confirmation:
        options.confirmationLabel === undefined ? null : { label: options.confirmationLabel },
    },
    findings: result.findings.map(findingJson),
    identityChanges: result.identityChanges.map((c) => ({
      field: c.field,
      before: c.before,
      after: c.after,
    })),
    power: powerJson(result),
    calibration:
      result.calibration === null
        ? null
        : {
            splits: result.calibration.splits,
            replicatesPerHalf: result.calibration.replicatesPerHalf,
            cases: result.calibration.cases,
            usable: result.calibration.usable,
            // Stated in the document rather than only in the prose renderer: a consumer comparing
            // calibrated p-values across runs needs to know this null is measured at half the n.
            conservative: true,
            conservativeBecause:
              "the A/A null is measured at half the baseline's replicates, so its quantiles sit wider than the real comparison's and the calibrated p is biased toward saying no drift",
          },
    metricGroups: {
      confirmed: [...result.confirmedMetrics],
      suspected: [...result.suspectedMetrics],
      underpowered: [...result.underpoweredMetrics],
    },
    gates: gatesFor(result).map((g) => ({
      area: g.area,
      name: g.name,
      status: g.status,
      detail: g.detail,
    })),
    context: {
      corpusDigest: options.corpusDigest ?? null,
      stalenessNote: options.stalenessNote ?? null,
      notes: options.notes === undefined ? [] : [...options.notes],
      cost: {
        baseline: options.baselineCost === undefined ? null : { ...options.baselineCost },
        candidate: options.candidateCost === undefined ? null : { ...options.candidateCost },
      },
      candidateFingerprint:
        options.candidateFingerprint === undefined ? null : { ...options.candidateFingerprint },
    },
  });
}

function findingJson(finding: MetricFinding): unknown {
  return {
    metric: finding.metric,
    gating: finding.gating,
    binary: finding.binary,
    cases: finding.cases,
    baseline: finite(finding.baseline),
    candidate: finite(finding.candidate),
    /** Percentage points for a binary metric, a fraction of baseline otherwise. Never mixed. */
    effect: finite(finding.effect),
    effectUnit: finding.binary ? "proportion-difference" : "relative-fraction",
    effectCI: {
      point: finite(finding.effectCI.point),
      low: finite(finding.effectCI.low),
      high: finite(finding.effectCI.high),
      n: finding.effectCI.n,
    },
    permutation: {
      p: finite(finding.permutation.p),
      observed: finite(finding.permutation.observed),
      method: finding.permutation.method,
      assignments: finding.permutation.assignments,
      k: finding.permutation.k,
      exchangeable: finding.permutation.exchangeable,
    },
    calibratedP: finite(finding.calibratedP),
    noiseFloor95: finite(finding.noiseFloor95),
    // The disambiguator. See the header: null in the two fields above means NOT MEASURED, and a
    // consumer must be able to tell that from a measured zero without guessing.
    calibrated: Number.isFinite(finding.calibratedP),
    significant: finding.significant,
    exceedsNoiseFloor: finding.exceedsNoiseFloor,
    confirmed: finding.confirmed,
    errorCount: finding.errorCount,
    pooled:
      finding.pooled === null
        ? null
        : {
            u: finite(finding.pooled.test.u),
            p: finite(finding.pooled.test.p),
            method: finding.pooled.test.method,
            auc: finite(finding.pooled.test.auc),
            ties: finding.pooled.test.ties,
            hodgesLehmannShift: finite(finding.pooled.shift),
          },
    // `allPassCeiling` is DELIBERATELY NaN on a continuous metric, because there is no "all passed"
    // to bound, and `canonicalJson` refuses to serialize a NaN. Spreading the MdeResult raw threw
    // `uncanonicalizable_value` on every comparison that reached outputTokens, latencyMs or costUsd,
    // which is every comparison of two real runs. Nulled here for exactly the reason the header
    // gives and exactly the way `powerJson` below already nulls the same field.
    mde:
      finding.mde === null
        ? null
        : { ...finding.mde, allPassCeiling: finite(finding.mde.allPassCeiling) },
    perCase: finding.perCase.map((c) => ({
      caseId: c.caseId,
      baseline: finite(c.baseline),
      candidate: finite(c.candidate),
      delta: finite(c.delta),
      p: finite(c.p),
      flagged: c.flagged,
      // Repeated on every row on purpose. A consumer that reads only `perCase` must not be able to
      // treat a flag as a finding, and a note in the markdown does not travel with the JSON.
      interpretation: "hypothesis-generating, not confirmatory at these sample sizes",
    })),
  };
}

function powerJson(result: CompareResult): unknown {
  const withMde = result.findings.filter((f) => f.mde !== null);
  const first = withMde[0];
  const ceiling = first?.mde ?? null;
  return {
    replicates: {
      baseline: result.replicates.baseline,
      candidate: result.replicates.candidate,
    },
    // The rule of three, and null when no simulation ran rather than a number recomputed here: the
    // markdown renderer may recompute it for a reader, a machine consumer should not be handed a
    // number whose provenance it cannot see.
    allPassCeiling: ceiling === null ? null : finite(ceiling.allPassCeiling),
    allPassCeilingSource: ceiling === null ? "not computed" : "mde simulation",
    underpoweredMetrics: [...result.underpoweredMetrics],
    perMetric: withMde.map((f) => {
      const mde = f.mde;
      return {
        metric: f.metric,
        gating: f.gating,
        mde: mde === null ? null : mde.mde,
        power: mde === null ? null : finite(mde.power),
        alpha: mde === null ? null : finite(mde.alpha),
        targetPower: mde === null ? null : finite(mde.targetPower),
        targetEffect: mde === null ? null : mde.targetEffect,
        replicatesForTarget: mde === null ? null : mde.replicatesForTarget,
        cases: mde === null ? null : mde.cases,
        replicates: mde === null ? null : mde.replicates,
        simulations: mde === null ? null : mde.simulations,
        allPassCeiling: mde === null ? null : finite(mde.allPassCeiling),
      };
    }),
  };
}
