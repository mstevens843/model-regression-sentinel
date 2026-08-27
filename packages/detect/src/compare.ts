// The detector. Deciding whether a difference between two runs is real or is noise.
//
// This is the file whose ABSENCE a cashed corpus freeze would have to witness, and it is named as
// such in corpus/*/FREEZE.json. Everything else in this repository is plumbing around the question
// asked here.
//
// THE SHAPE OF THE ANSWER, and why it has four values rather than two.
//
//   NO_DRIFT        nothing moved, AND the suite had the power to have seen a movement of the size
//                   that matters. Both halves are required. The second half is what a diff tool
//                   silently omits.
//   INCONCLUSIVE    nothing was found and the suite could not have found it. This is not a
//                   degenerate case to be tidied into NO_DRIFT: at n = 10 an all-passing case is
//                   consistent with a true failure rate of 30 percent, so "we saw nothing" and "we
//                   checked" are different statements and only one of them is supported.
//   SUSPECTED_DRIFT a gating metric moved, significantly against the permutation null AND beyond
//                   the noise floor this provider measurably has. Reported, and does NOT fail a
//                   build on its own.
//   CONFIRMED_DRIFT the same finding reproduced on an INDEPENDENT confirmation run. Only this
//                   fails a build.
//
// WHY CONFIRMATION IS A SEPARATE ARM AND NOT A LOWER p. A drift watcher runs forever. Any fixed
// threshold applied repeatedly will eventually fire on noise, and the first time it does, someone
// investigates, finds nothing, and trusts the tool a little less. Requiring a fresh, independently
// collected run to reproduce the finding turns one test at alpha into two, which is a far stronger
// guard than moving alpha and is one a person can reason about without a statistics textbook. This
// is the same discipline the `watch` package applies over time with an e-process.
//
// TWO NULLS, BOTH REPORTED, NEVER MERGED.
//   the permutation p   asks: is this effect large relative to SAMPLING?
//   the calibrated p    asks: is this effect large relative to how much THIS PROVIDER wobbles?
// A finding must clear both. When they disagree that is information rather than a problem: a
// permutation p of 0.01 beside a calibrated p of 0.30 says the effect is real sampling-wise and
// utterly ordinary for this provider, which is precisely the case where a raw diff declares a
// regression and is wrong.
//
// CONTINUOUS METRICS ARE COMPARED IN SYMMETRIC RELATIVE TERMS, and the word symmetric is doing
// real work. Comparing raw differences is out: measured on this corpus one case averages about 5
// output tokens and another about 616, and an unweighted mean of raw differences across those is a
// statistic about the second case wearing the name of the suite. But the obvious repair, dividing by
// the baseline, is unbounded, and this corpus contains a case that breaks it. `cnt-c-003` is
// bimodal: the model usually answers in one word and sometimes writes a paragraph, so a half whose
// draws all landed on the short mode has a mean near 5 and the ratio against the long mode exceeds
// 6000 percent. One such case dominated the whole suite's noise floor.
//
// So the statistic is 2 * (c - b) / (c + b), the symmetric percent difference. It agrees with the
// naive ratio to first order for the small changes that matter, and it is BOUNDED in [-2, 2], so no
// single bimodal case can swamp the suite. A drift detector whose own summary statistic is
// unbounded is a detector waiting to report an outlier as a regression.
//
// LATENCY NEVER GATES. See GATING_METRICS in @model-regression-sentinel/spec for the measurement
// behind that, which is a single free-form case producing one sample in eight at 3.57 times the
// median.

import {
  type FingerprintChange,
  type MetadataChange,
  type ProviderMetadata,
  type RunSnapshot,
  diffMetadata,
  fingerprintDiff,
} from "@model-regression-sentinel/run";
import { type EvalCase, GATING_METRICS, type MetricKey } from "@model-regression-sentinel/spec";
import { type MdeResult, minimumDetectableEffect, minimumDetectableRelativeEffect } from "./mde.js";
import { type MetricSamples, extractMetrics, pairCases } from "./metrics.js";
import {
  type CaseSamples,
  type NullCalibration,
  calibrateNull,
  calibratedP,
  nullQuantile,
} from "./nullCalibration.js";
import { type PermutationResult, signFlipTest } from "./permutation.js";
import { type Rng, mulberry32 } from "./rng.js";
import {
  type Interval,
  type MannWhitneyResult,
  benjaminiHochberg,
  bootstrapCI,
  fisherExactTwoSided,
  hodgesLehmann,
  mannWhitneyU,
  mean,
  median,
} from "./stats.js";

export type Verdict =
  | "NO_DRIFT"
  | "INCONCLUSIVE"
  | "SUSPECTED_DRIFT"
  | "CONFIRMED_DRIFT"
  | "NOT_COMPARABLE";

export interface PerCaseFinding {
  readonly caseId: string;
  readonly baseline: number;
  readonly candidate: number;
  readonly delta: number;
  readonly p: number;
  /** Survived Benjamini-Hochberg at q. Triage only, never confirmatory at these sample sizes. */
  readonly flagged: boolean;
}

export interface MetricFinding {
  readonly metric: MetricKey;
  readonly gating: boolean;
  readonly binary: boolean;
  readonly cases: number;
  readonly baseline: number;
  readonly candidate: number;
  /** Mean per-case difference. A proportion for binary metrics, a fraction of baseline otherwise. */
  readonly effect: number;
  readonly effectCI: Interval;
  readonly permutation: PermutationResult;
  /**
   * NULL when the baseline had too few replicates to calibrate, never NaN.
   *
   * The distinction is not cosmetic. `canonicalJson` refuses NaN by design, because
   * `JSON.stringify` would silently write `null` and let two different objects hash the same. This
   * field was NaN until an adversarial pass found that `compare --format json` threw on any run
   * with fewer than four replicates per case, which is exactly the underpowered run a user is most
   * likely to be inspecting. Null is both the honest value and the serializable one.
   */
  readonly calibratedP: number | null;
  /**
   * The 95th percentile of this provider's own A/A wobble, in THE SAME UNITS AS `effect`.
   *
   * For a binary metric that is percentage points. For a continuous metric it is a relative
   * fraction, recomputed on relative differences so the two are actually comparable. An earlier
   * version reported the absolute calibration here while `calibratedP` used the relative one, which
   * made a latency noise floor render as several hundred thousand percent.
   */
  readonly noiseFloor95: number | null;
  readonly mde: MdeResult | null;
  readonly significant: boolean;
  /** Null when no calibration was possible. Null is not the same as false and does not confirm. */
  readonly exceedsNoiseFloor: boolean | null;
  readonly confirmed: boolean;
  /** Set for continuous metrics only: a rank test on the pooled samples plus a robust shift. */
  readonly pooled: { readonly test: MannWhitneyResult; readonly shift: number } | null;
  readonly perCase: readonly PerCaseFinding[];
  readonly errorCount: number;
}

export interface CompareOptions {
  readonly alpha?: number;
  readonly fdrQ?: number;
  readonly seed?: number;
  readonly calibrationSplits?: number;
  /** An effect the user cares about, used to compute the replicate count that would reach it. */
  readonly targetEffect?: number;
  /** Skip the MDE simulation. Only for tests and for the watcher's hot path. */
  readonly skipMde?: boolean;
  /** An independent second candidate run. Findings that reproduce here become CONFIRMED. */
  readonly confirmation?: RunSnapshot;
}

export interface CompareResult {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly alpha: number;
  readonly findings: readonly MetricFinding[];
  readonly identityChanges: readonly FingerprintChange[];
  /**
   * Provider metadata differences: endpoint, adapter, harness version, token source, and the
   * capability fields, each classified by whether it is a real difference or a gap in what was
   * captured.
   *
   * SEPARATE FROM `findings` ON PURPOSE, and never folded into a verdict. Metadata carries no
   * p-value: a field either moved or it did not, and no sampling is involved. A changed endpoint or
   * a changed token source alters what the numbers MEAN without being a behaviour change, and
   * scoring it as quality drift would be the same category error this project exists to avoid.
   */
  readonly metadataChanges: readonly MetadataChange[];
  readonly baselineLabel: string;
  readonly candidateLabel: string;
  readonly baselineCapturedAt: string;
  readonly candidateCapturedAt: string;
  readonly replicates: { readonly baseline: number; readonly candidate: number };
  readonly calibration: NullCalibration | null;
  readonly confirmedMetrics: readonly MetricKey[];
  readonly suspectedMetrics: readonly MetricKey[];
  /** Metrics where nothing was found and nothing could have been. */
  readonly underpoweredMetrics: readonly MetricKey[];
}

export function compare(
  cases: readonly EvalCase[],
  baseline: RunSnapshot,
  candidate: RunSnapshot,
  options: CompareOptions = {},
): CompareResult {
  const alpha = options.alpha ?? 0.05;
  const fdrQ = options.fdrQ ?? 0.1;
  const rng: Rng = mulberry32(options.seed ?? 20260826);

  const shell = (verdict: Verdict, reason: string): CompareResult => ({
    verdict,
    reason,
    alpha,
    findings: [],
    identityChanges: identityChangesOf(baseline, candidate),
    metadataChanges: metadataChangesOf(baseline, candidate),
    baselineLabel: baseline.label,
    candidateLabel: candidate.label,
    baselineCapturedAt: baseline.capturedAt,
    candidateCapturedAt: candidate.capturedAt,
    replicates: { baseline: baseline.replicates, candidate: candidate.replicates },
    calibration: null,
    confirmedMetrics: [],
    suspectedMetrics: [],
    underpoweredMetrics: [],
  });

  // Comparing two runs of different corpora is a category error, not a measurement. The digest is
  // over the rendered requests, so this also catches a prompt-template edit that left the case ids
  // alone, which is the failure mode most likely to be mistaken for drift.
  if (baseline.corpusDigest !== candidate.corpusDigest) {
    return shell(
      "NOT_COMPARABLE",
      "the two runs were collected against different rendered corpora, so any difference between them is a difference of experiment rather than of provider. Re-run both arms against one frozen corpus.",
    );
  }
  if (baseline.replicates < 2 || candidate.replicates < 2) {
    return shell(
      "INCONCLUSIVE",
      `replicates are ${baseline.replicates} and ${candidate.replicates}. With fewer than two draws per case there is nothing to estimate run-to-run variability from, so drift and noise cannot be separated even in principle.`,
    );
  }

  const exchangeable = baseline.replicates === candidate.replicates;
  const baseMetrics = extractMetrics(cases, baseline);
  const candMetrics = extractMetrics(cases, candidate);
  const confirmMetrics =
    options.confirmation === undefined ? null : extractMetrics(cases, options.confirmation);

  const findings: MetricFinding[] = [];
  let qualityCalibration: NullCalibration | null = null;

  for (const metric of orderedMetrics(baseMetrics)) {
    const b = baseMetrics.get(metric);
    const c = candMetrics.get(metric);
    if (b === undefined || c === undefined) continue;

    const finding = analyse(metric, b, c, rng, {
      alpha,
      fdrQ,
      exchangeable,
      replicates: baseline.replicates,
      calibrationSplits: options.calibrationSplits ?? 500,
      skipMde: options.skipMde === true,
      ...(options.targetEffect === undefined ? {} : { targetEffect: options.targetEffect }),
    });
    if (metric === "quality") qualityCalibration = finding.calibration;

    // Confirmation: the same metric must clear both nulls again on an independently collected run.
    let confirmed = false;
    if (finding.result.significant && finding.result.exceedsNoiseFloor === true) {
      if (confirmMetrics === null) {
        confirmed = false;
      } else {
        const cc = confirmMetrics.get(metric);
        if (cc !== undefined) {
          const again = analyse(metric, b, cc, rng, {
            alpha,
            fdrQ,
            exchangeable,
            replicates: baseline.replicates,
            calibrationSplits: options.calibrationSplits ?? 500,
            skipMde: true,
          });
          // Same direction as well as significant. A finding that reproduces with the opposite sign
          // is two contradictory observations, not a confirmation.
          confirmed =
            again.result.significant &&
            again.result.exceedsNoiseFloor === true &&
            Math.sign(again.result.effect) === Math.sign(finding.result.effect);
        }
      }
    }
    findings.push({ ...finding.result, confirmed });
  }

  const gating = findings.filter((f) => f.gating);
  const confirmedMetrics = gating.filter((f) => f.confirmed).map((f) => f.metric);
  const suspectedMetrics = gating
    .filter((f) => f.significant && f.exceedsNoiseFloor === true && !f.confirmed)
    .map((f) => f.metric);
  const underpowered = gating
    .filter((f) => !f.significant && (f.mde === null || f.mde.mde === null))
    .map((f) => f.metric);

  const identityChanges = identityChangesOf(baseline, candidate);

  let verdict: Verdict;
  let reason: string;
  if (confirmedMetrics.length > 0) {
    verdict = "CONFIRMED_DRIFT";
    reason = `${confirmedMetrics.join(", ")} moved beyond both the permutation null and this provider's measured noise floor, and reproduced on an independent confirmation run.`;
  } else if (suspectedMetrics.length > 0) {
    verdict = "SUSPECTED_DRIFT";
    reason =
      options.confirmation === undefined
        ? `${suspectedMetrics.join(", ")} cleared both nulls on a single comparison. That is not yet a confirmed regression: collect an independent candidate run and pass it as the confirmation arm. A single crossing is exactly what noise produces on the run where it happens to.`
        : `${suspectedMetrics.join(", ")} cleared both nulls but did not reproduce on the confirmation run, which is what a false alarm looks like.`;
  } else if (underpowered.length === gating.length && gating.length > 0) {
    verdict = "INCONCLUSIVE";
    reason = `no gating metric moved detectably, and at ${baseline.replicates} replicates across ${gating[0]?.cases ?? 0} cases the suite could not have detected the effects it searched for. This is not evidence that nothing changed.`;
  } else if (underpowered.length > 0) {
    verdict = "INCONCLUSIVE";
    reason = `nothing was confirmed, but ${underpowered.join(", ")} had no resolvable minimum detectable effect at this sample size, so those metrics were not actually checked.`;
  } else {
    verdict = "NO_DRIFT";
    reason = `no gating metric moved beyond the permutation null or this provider's measured noise floor, and the suite had the power to detect the effect sizes it searched for.`;
  }

  return {
    verdict,
    reason,
    alpha,
    findings,
    identityChanges,
    metadataChanges: metadataChangesOf(baseline, candidate),
    baselineLabel: baseline.label,
    candidateLabel: candidate.label,
    baselineCapturedAt: baseline.capturedAt,
    candidateCapturedAt: candidate.capturedAt,
    replicates: { baseline: baseline.replicates, candidate: candidate.replicates },
    calibration: qualityCalibration,
    confirmedMetrics,
    suspectedMetrics,
    underpoweredMetrics: underpowered,
  };
}

/**
 * Exit code.
 *
 * NON-ZERO ONLY ON A CONFIRMED REGRESSION, by default. A suspected finding is printed and returns
 * zero, because a build that fails on a single crossing of a threshold is a build that fails on
 * noise, and the second time that happens the gate gets removed. `gate: "suspected"` is available
 * for a team that would rather investigate a false alarm than miss a real one, and it is opt-in so
 * that choice is made deliberately.
 *
 * NOT_COMPARABLE returns 2, distinct from a regression, because it means the tool was misused
 * rather than that the provider moved.
 */
export function exitCodeFor(
  result: CompareResult,
  gate: "confirmed" | "suspected" = "confirmed",
): number {
  if (result.verdict === "NOT_COMPARABLE") return 2;
  if (result.verdict === "CONFIRMED_DRIFT") return 1;
  if (gate === "suspected" && result.verdict === "SUSPECTED_DRIFT") return 1;
  return 0;
}

/**
 * Metadata differences between two runs, including the case where one of them never captured any.
 *
 * The four real runs in `results/runs/` were collected in v0.1, before metadata existed. Comparing
 * them must not silently report "no metadata drift", which is what an empty array would say. It
 * reports one indeterminate row instead, because "we did not capture this" is a fact about us and
 * never evidence about the provider.
 */
function metadataChangesOf(a: RunSnapshot, b: RunSnapshot): readonly MetadataChange[] {
  const before: ProviderMetadata | undefined = a.metadata;
  const after: ProviderMetadata | undefined = b.metadata;
  if (before === undefined || after === undefined) {
    const missing = [before === undefined ? a.label : null, after === undefined ? b.label : null]
      .filter((x): x is string => x !== null)
      .join(" and ");
    return [
      {
        field: "adapter",
        kind: "indeterminate",
        before: before === undefined ? "(unknown)" : "(captured)",
        after: after === undefined ? "(unknown)" : "(captured)",
        note: `no provider metadata was recorded on ${missing}, so none of it could be compared. This is not evidence that the provider setup held still.`,
      },
    ];
  }
  return diffMetadata(before, after);
}

function identityChangesOf(a: RunSnapshot, b: RunSnapshot): readonly FingerprintChange[] {
  if (a.fingerprint === null || b.fingerprint === null) return [];
  return fingerprintDiff(a.fingerprint, b.fingerprint);
}

/** Deterministic metric order, so two reports of the same run read the same way. */
function orderedMetrics(m: ReadonlyMap<MetricKey, MetricSamples>): readonly MetricKey[] {
  const order: MetricKey[] = [
    "quality",
    "schemaValid",
    "refusal",
    "outputTokens",
    "latencyMs",
    "costUsd",
  ];
  return order.filter((k) => m.has(k));
}

interface AnalyseOptions {
  readonly alpha: number;
  readonly fdrQ: number;
  readonly exchangeable: boolean;
  readonly replicates: number;
  readonly calibrationSplits: number;
  readonly skipMde: boolean;
  readonly targetEffect?: number;
}

function analyse(
  metric: MetricKey,
  b: MetricSamples,
  c: MetricSamples,
  rng: Rng,
  options: AnalyseOptions,
): { result: Omit<MetricFinding, "confirmed">; calibration: NullCalibration } {
  const paired = pairCases(b.perCase, c.perCase);
  const binary = b.binary;

  // Binary metrics compare rates directly. Continuous metrics compare RELATIVE change, because an
  // unweighted mean of raw differences across cases whose scales differ by an order of magnitude is
  // a statistic about the largest case wearing the name of the suite.
  const deltas = paired.map((p) => {
    const mb = mean(p.baseline);
    const mc = mean(p.candidate);
    return binary ? mc - mb : symmetricRelative(mc, mb);
  });

  const calibration = calibrateNull(
    b.perCase as readonly CaseSamples[],
    rng,
    options.calibrationSplits,
  );
  const permutation = signFlipTest(deltas, {
    rng,
    exchangeable: options.exchangeable,
  });
  const effectCI = bootstrapCI(deltas, (xs) => mean(xs), rng, 2000);
  const relative = binary
    ? null
    : relativeCalibration(calibration, b.perCase, rng, options.calibrationSplits);
  const calP =
    relative === null
      ? calibratedP(calibration, permutation.observed)
      : relative.p(permutation.observed);

  // Per-case screening. Triage only, and labelled as such everywhere it is printed.
  const perCaseP = paired.map((p) => {
    if (binary) {
      const bs = p.baseline.reduce((a, x) => a + x, 0);
      const cs = p.candidate.reduce((a, x) => a + x, 0);
      return fisherExactTwoSided(cs, p.candidate.length - cs, bs, p.baseline.length - bs);
    }
    return mannWhitneyU(p.candidate, p.baseline).p;
  });
  const fdr = benjaminiHochberg(perCaseP, options.fdrQ);

  const perCase: PerCaseFinding[] = paired.map((p, i) => ({
    caseId: p.caseId,
    baseline: binary ? mean(p.baseline) : median(p.baseline),
    candidate: binary ? mean(p.candidate) : median(p.candidate),
    delta: deltas[i] as number,
    p: perCaseP[i] as number,
    flagged: fdr.rejected[i] === true,
  }));

  const pooled = binary
    ? null
    : {
        test: mannWhitneyU(
          paired.flatMap((p) => [...p.candidate]),
          paired.flatMap((p) => [...p.baseline]),
        ),
        shift: hodgesLehmann(
          paired.flatMap((p) => [...p.candidate]),
          paired.flatMap((p) => [...p.baseline]),
        ),
      };

  // Both metric kinds get a power analysis. Without the continuous one, every continuous gating
  // metric that did not move counts as unchecked, and the suite verdict can never reach NO_DRIFT.
  const mde = options.skipMde
    ? null
    : binary
      ? minimumDetectableEffect(
          paired.map((p) => p.baseline.reduce((a, x) => a + x, 0)),
          options.replicates,
          {
            alpha: options.alpha,
            seed: 20260826,
            ...(options.targetEffect === undefined ? {} : { targetEffect: options.targetEffect }),
          },
        )
      : minimumDetectableRelativeEffect(
          paired.map((p) => p.baseline),
          { alpha: options.alpha, seed: 20260826 },
        );

  const significant = permutation.p <= options.alpha;
  // Null propagates. No calibration means no second opinion, and a finding cannot be confirmed on
  // one null alone, so an uncalibrated run can never produce a confirmed regression.
  const exceedsNoiseFloor =
    calibration.usable && calP !== null && Number.isFinite(calP) ? calP <= options.alpha : null;

  return {
    calibration,
    result: {
      metric,
      gating: GATING_METRICS.includes(metric),
      binary,
      cases: paired.length,
      baseline: mean(paired.map((p) => mean(p.baseline))),
      candidate: mean(paired.map((p) => mean(p.candidate))),
      effect: permutation.observed,
      effectCI,
      permutation,
      calibratedP: calP,
      noiseFloor95: relative === null ? nullQuantile(calibration, 0.95) : relative.q95,
      mde,
      significant,
      exceedsNoiseFloor,
      pooled,
      perCase,
      errorCount: b.errorCount + c.errorCount,
    },
  };
}

/**
 * The A/A calibration for a continuous metric, in RELATIVE units.
 *
 * The splits have to be scored in the same units the observed effect uses, otherwise a token-count
 * effect of "3 percent" is compared against a noise floor measured in tokens. Both the p-value and
 * the reported 95th percentile come from here, so the two can never disagree about units, which is
 * exactly how an earlier version came to print a latency noise floor of several hundred thousand
 * percent.
 */
/**
 * The symmetric percent difference, bounded in [-2, 2].
 *
 * Zero when both sides are zero, which is the right answer rather than a guard: two arms that both
 * produced nothing did not differ.
 */
export function symmetricRelative(candidate: number, baseline: number): number {
  const total = candidate + baseline;
  return total === 0 ? 0 : (2 * (candidate - baseline)) / total;
}

function relativeCalibration(
  absolute: NullCalibration,
  perCase: readonly CaseSamples[],
  rng: Rng,
  splits: number,
): { readonly p: (observed: number) => number; readonly q95: number } | null {
  if (!absolute.usable) return null;
  const usable = perCase.filter((s) => s.values.length >= 4);
  if (usable.length === 0) return null;

  // EACH CASE SPLITS ITS OWN REPLICATES, rather than every case being cut down to the smallest
  // case's half. A global minimum sounds tidier and is badly wrong here: one case in this corpus
  // errored on 6 of its 10 calls, which dragged the shared half-size to 2 and threw away 80 percent
  // of the data for every OTHER case. The statistic averages per-case deltas, so symmetry has to
  // hold within a case and does not have to hold across them.
  const stats: number[] = [];
  for (let s = 0; s < splits; s += 1) {
    let total = 0;
    for (const c of usable) {
      const half = Math.floor(c.values.length / 2);
      const shuffled = [...c.values];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        const t = shuffled[i] as number;
        shuffled[i] = shuffled[j] as number;
        shuffled[j] = t;
      }
      total += symmetricRelative(
        mean(shuffled.slice(0, half)),
        mean(shuffled.slice(half, half * 2)),
      );
    }
    stats.push(Math.abs(total / usable.length));
  }
  stats.sort((x, y) => x - y);

  return {
    p: (observed: number): number => {
      const target = Math.abs(observed);
      let atLeast = 0;
      for (const v of stats) if (v >= target - 1e-12) atLeast += 1;
      return (atLeast + 1) / (stats.length + 1);
    },
    q95: stats[Math.min(stats.length - 1, Math.floor(0.95 * (stats.length - 1)))] as number,
  };
}
