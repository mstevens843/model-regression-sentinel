// The minimum detectable effect, computed rather than quoted.
//
// THE SINGLE MOST IMPORTANT OUTPUT IN THIS PACKAGE, and the one that separates a drift detector
// from a diff. A comparison that finds nothing has two possible meanings and they are opposites:
// nothing moved, or the instrument cannot see a movement of this size. A tool that reports the
// first when the truth is the second is not neutral, it is actively harmful, because it converts
// "we did not look hard enough" into "we checked".
//
// So when the observed effect is smaller than the MDE, this project reports INCONCLUSIVE and prints
// the replicate count that would be needed. It does not report NO_DRIFT.
//
// COMPUTED FROM THE OBSERVED BASELINE, NOT FROM A FORMULA. A closed-form power calculation needs a
// per-case variance, and this corpus does not have one number for that: measured on this machine,
// some cases returned 8/8 identical answers, meaning zero observed variance, while a free-form case
// had an output-token CV of 18.5 percent. A textbook formula fed the average of those describes no
// case in the corpus. So the simulator draws from the ACTUAL per-case baseline rates, at the ACTUAL
// replicate count, and runs the ACTUAL test, including the permutation step. What comes back is the
// power of this suite rather than the power of an idealized one.
//
// THE ZERO-VARIANCE TRAP IS HANDLED EXPLICITLY. A case observed at 10/10 has an estimated rate of
// exactly 1, and simulating from p = 1 gives a case that can never fail, which would make the MDE
// look better than it is. Rates are therefore shrunk toward one half by the Jeffreys prior,
// (successes + 0.5) / (n + 1), before simulation. That is not cosmetic: at n = 10 it turns an
// estimate of 1.000 into 0.955, which is much closer to what the rule of three says the data
// actually support, namely a true failure rate anywhere up to 30 percent.

import { signFlipTest } from "./permutation.js";
import { type Rng, binomial, mulberry32 } from "./rng.js";
import { ruleOfThree } from "./stats.js";

export interface MdeResult {
  /** Smallest drop in mean pass rate detectable at the target power, or null if none was found. */
  readonly mde: number | null;
  readonly power: number;
  readonly alpha: number;
  readonly targetPower: number;
  readonly cases: number;
  readonly replicates: number;
  readonly simulations: number;
  /**
   * With every replicate passing, the largest true failure rate still consistent with the data.
   * The rule of three, and the honest floor no amount of testing at this n gets under.
   */
  readonly allPassCeiling: number;
  /** Replicates needed to reach `targetEffect`, when the caller names one. */
  readonly replicatesForTarget: number | null;
  readonly targetEffect: number | null;
}

export interface MdeOptions {
  readonly alpha?: number;
  readonly targetPower?: number;
  readonly simulations?: number;
  /** Permutation draws inside each simulation. Sampling, not enumeration, for speed. */
  readonly permutationDraws?: number;
  readonly seed?: number;
  /** An effect the user cares about. When set, the result says what n would reach it. */
  readonly targetEffect?: number;
  /** Candidate effect sizes to search, in rate points. */
  readonly grid?: readonly number[];
}

const DEFAULT_GRID = [
  0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6,
];

/** The Jeffreys-smoothed rate. See the header: this is what keeps a perfect score from lying. */
export const smoothedRate = (successes: number, n: number): number =>
  n === 0 ? 0.5 : (successes + 0.5) / (n + 1);

/**
 * Power of this suite against a uniform drop of `effect` in every case's pass rate.
 *
 * A uniform drop is a modelling choice and a conservative one for a DRIFT detector specifically: a
 * provider update that degrades everything a little is both the most plausible shape and the
 * hardest to see, because it has no single case that collapses to point at. A detector tuned on the
 * easy shape, one case falling off a cliff, would report a far better MDE than it deserves.
 */
export function simulatePower(
  baselineRates: readonly number[],
  replicates: number,
  effect: number,
  options: MdeOptions = {},
): number {
  const alpha = options.alpha ?? 0.05;
  const sims = options.simulations ?? 400;
  const draws = options.permutationDraws ?? 400;
  const rng: Rng = mulberry32(options.seed ?? 20260826);
  const k = baselineRates.length;
  if (k === 0) return 0;

  let rejected = 0;
  for (let s = 0; s < sims; s += 1) {
    const deltas: number[] = [];
    for (const p of baselineRates) {
      const candidateP = Math.min(1, Math.max(0, p - effect));
      const b = binomial(rng, replicates, p) / replicates;
      const c = binomial(rng, replicates, candidateP) / replicates;
      deltas.push(c - b);
    }
    const test = signFlipTest(deltas, { rng, draws, forceMonteCarlo: true });
    if (test.p <= alpha) rejected += 1;
  }
  return rejected / sims;
}

/** Search the grid for the smallest effect reaching the target power. */
export function minimumDetectableEffect(
  baselineSuccesses: readonly number[],
  replicates: number,
  options: MdeOptions = {},
): MdeResult {
  const alpha = options.alpha ?? 0.05;
  const targetPower = options.targetPower ?? 0.8;
  const sims = options.simulations ?? 400;
  const grid = options.grid ?? DEFAULT_GRID;
  const rates = baselineSuccesses.map((s) => smoothedRate(s, replicates));

  let found: number | null = null;
  let powerAtFound = 0;
  for (const effect of grid) {
    const power = simulatePower(rates, replicates, effect, {
      ...options,
      alpha,
      simulations: sims,
    });
    if (power >= targetPower) {
      found = effect;
      powerAtFound = power;
      break;
    }
    powerAtFound = power;
  }

  const targetEffect = options.targetEffect ?? null;
  let replicatesForTarget: number | null = null;
  if (targetEffect !== null && targetEffect > 0) {
    // Climb through plausible replicate counts rather than inverting a formula, for the same reason
    // the MDE itself is simulated. Capped, so that an effect this corpus simply cannot resolve
    // reports null rather than a number nobody would ever run.
    for (const n of [5, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200]) {
      if (n < replicates) continue;
      const scaled = baselineSuccesses.map((s) => smoothedRate(s, replicates));
      if (
        simulatePower(scaled, n, targetEffect, { ...options, alpha, simulations: sims }) >=
        targetPower
      ) {
        replicatesForTarget = n;
        break;
      }
    }
  }

  return {
    mde: found,
    power: powerAtFound,
    alpha,
    targetPower,
    cases: baselineSuccesses.length,
    replicates,
    simulations: sims,
    allPassCeiling: ruleOfThree(replicates),
    replicatesForTarget,
    targetEffect,
  };
}

/**
 * The minimum detectable RELATIVE effect for a continuous metric.
 *
 * WHY THIS EXISTS, and it was a real hole rather than a refinement. Without it,
 * `minimumDetectableEffect` covers binary metrics only, every continuous gating metric that did not
 * move is reported as unpowered, and the suite verdict can therefore never reach NO_DRIFT at all.
 * A verdict vocabulary with an unreachable value is a vocabulary with one fewer value than it
 * claims, and the one it loses is the one people most want to see.
 *
 * IT RESAMPLES THE OBSERVED VALUES RATHER THAN FITTING A DISTRIBUTION. Output-token counts and
 * latencies are not normal, not log-normal in any way worth committing to, and differ in shape case
 * by case: measured on this machine, output tokens had a CV of 18.5 percent on a free-form case and
 * about 32 percent on a reasoning-heavy one, and latency carried a tail with one sample in eight at
 * 3.57 times the median. A bootstrap from what was actually observed inherits all of that for free
 * and asserts none of it.
 *
 * The alternative modelled is a uniform relative shift, for the same reason as the binary case: a
 * provider that made everything a few percent longer is both the most plausible shape and the
 * hardest to see.
 */
export function minimumDetectableRelativeEffect(
  perCase: readonly (readonly number[])[],
  options: MdeOptions = {},
): MdeResult {
  const alpha = options.alpha ?? 0.05;
  const targetPower = options.targetPower ?? 0.8;
  const sims = options.simulations ?? 300;
  const draws = options.permutationDraws ?? 300;
  const grid = options.grid ?? RELATIVE_GRID;
  const usable = perCase.filter((v) => v.length >= 2);
  const replicates = usable.reduce((m, v) => Math.min(m, v.length), Number.POSITIVE_INFINITY);

  if (usable.length === 0 || !Number.isFinite(replicates)) {
    return {
      mde: null,
      power: 0,
      alpha,
      targetPower,
      cases: 0,
      replicates: 0,
      simulations: sims,
      allPassCeiling: Number.NaN,
      replicatesForTarget: null,
      targetEffect: options.targetEffect ?? null,
    };
  }

  const powerAt = (effect: number): number => {
    const rng: Rng = mulberry32(options.seed ?? 20260826);
    let rejected = 0;
    for (let s = 0; s < sims; s += 1) {
      const deltas: number[] = [];
      for (const values of usable) {
        let a = 0;
        let b = 0;
        for (let i = 0; i < replicates; i += 1) {
          a += values[Math.floor(rng() * values.length)] as number;
          b += (values[Math.floor(rng() * values.length)] as number) * (1 + effect);
        }
        const mb = a / replicates;
        deltas.push(mb === 0 ? 0 : (b / replicates - mb) / mb);
      }
      if (signFlipTest(deltas, { rng, draws, forceMonteCarlo: true }).p <= alpha) rejected += 1;
    }
    return rejected / sims;
  };

  let found: number | null = null;
  let power = 0;
  for (const effect of grid) {
    power = powerAt(effect);
    if (power >= targetPower) {
      found = effect;
      break;
    }
  }

  return {
    mde: found,
    power,
    alpha,
    targetPower,
    cases: usable.length,
    replicates,
    simulations: sims,
    // Meaningless for a continuous metric: there is no "all passed" to bound. NaN rather than 0,
    // because 0 would read as "an all-passing arm proves a zero failure rate", which is the exact
    // misreading the rule of three exists to prevent.
    allPassCeiling: Number.NaN,
    replicatesForTarget: null,
    targetEffect: options.targetEffect ?? null,
  };
}

/** Relative shifts to search, as fractions of each case's own baseline. */
const RELATIVE_GRID = [0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6];
