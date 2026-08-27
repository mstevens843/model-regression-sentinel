// The A/A calibration: measuring the noise floor instead of assuming it.
//
// THIS IS THE MECHANISM THAT MAKES THE PROJECT HONEST, and it is the piece a raw diff cannot have.
//
// A textbook null assumes the only randomness is sampling from a fixed distribution. A provider is
// not that. Temperature nondeterminism, mixture-of-experts routing, batching, load, and whatever a
// vendor changed on their side this morning all contribute variation that no binomial model knows
// about. A test calibrated against the textbook null will therefore reject too often, and every
// false alarm it produces will look exactly like the true positive it was built to find.
//
// So the baseline is asked to describe its own noise. Its replicates are split into two random
// halves, the SAME suite statistic is computed on that split, and the split is repeated. What comes
// back is the distribution of the statistic under a condition where drift is known to be absent,
// because both halves came from the same provider in the same window against the same corpus. The
// candidate is then scored against that measured distribution rather than an assumed one.
//
// WHAT IT COSTS, STATED PLAINLY. Splitting n replicates in half means each A/A arm has n/2, so the
// calibration null is the distribution of the statistic at HALF the sample size the real comparison
// uses. That makes it CONSERVATIVE: the A/A statistic is more variable than the real one, so its
// quantiles sit wider and the empirical p-value is biased toward saying no drift. Erring toward
// silence is the right direction for a tool whose main failure mode is crying wolf, and it is
// stated here rather than discovered by whoever wonders why the calibrated p is always larger than
// the permutation p.
//
// IT DOES NOT REPLACE THE PERMUTATION TEST. It is reported beside it. Two nulls disagreeing is
// information: a permutation p of 0.01 against a calibrated p of 0.30 means the effect is large
// relative to sampling and ordinary relative to how much this provider moves on its own, which is
// the exact situation where a diff-based tool declares a regression and is wrong.

import { type Rng, shuffle } from "./rng.js";

/** Every replicate of one case, for one metric. */
export interface CaseSamples {
  readonly caseId: string;
  readonly values: readonly number[];
}

export interface NullCalibration {
  /** How many random A/A splits were taken. */
  readonly splits: number;
  /**
   * The SMALLEST per-half replicate count across cases, for reporting.
   *
   * Each case now splits its own replicates, so this is a floor rather than the value used. It is
   * kept because it is the number a reader needs to judge how conservative the null is.
   */
  readonly replicatesPerHalf: number;
  /** |mean per-case difference| under A/A, sorted ascending. The measured noise floor. */
  readonly sorted: readonly number[];
  readonly cases: number;
  /** False when the baseline had too few replicates to split. Nothing downstream may use it. */
  readonly usable: boolean;
}

/**
 * Build the empirical null by repeatedly splitting the baseline against itself.
 *
 * Needs at least four replicates per case: with three, one half has a single draw and the split
 * measures almost nothing; with two, the "distribution" is a handful of points. Below that the
 * calibration is marked unusable rather than returned as a thin one, because a noise floor
 * estimated from two numbers is worse than admitting there is no estimate.
 */
export function calibrateNull(
  samples: readonly CaseSamples[],
  rng: Rng,
  splits = 500,
): NullCalibration {
  const usableCases = samples.filter((s) => s.values.length >= 4);
  const minN = usableCases.reduce((m, s) => Math.min(m, s.values.length), Number.POSITIVE_INFINITY);

  if (usableCases.length === 0 || !Number.isFinite(minN)) {
    return { splits: 0, replicatesPerHalf: 0, sorted: [], cases: 0, usable: false };
  }

  // EACH CASE SPLITS ITS OWN REPLICATES. Cutting every case down to the smallest one's half is
  // tidier and is wrong: a single case that errored on most of its calls would shrink the sample
  // for every other case in the corpus, which is exactly what happened on the first real collection
  // here. The statistic averages per-case deltas, so the two halves only have to be equal WITHIN a
  // case.
  const half = Math.floor(minN / 2);
  const stats: number[] = [];
  for (let s = 0; s < splits; s += 1) {
    let total = 0;
    for (const c of usableCases) {
      const caseHalf = Math.floor(c.values.length / 2);
      const shuffled = shuffle(rng, [...c.values]);
      total += mean(shuffled.slice(0, caseHalf)) - mean(shuffled.slice(caseHalf, caseHalf * 2));
    }
    stats.push(Math.abs(total / usableCases.length));
  }
  stats.sort((x, y) => x - y);
  return {
    splits,
    replicatesPerHalf: half,
    sorted: stats,
    cases: usableCases.length,
    usable: true,
  };
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Where an observed statistic sits in the measured null.
 *
 * The (count + 1) / (splits + 1) form again: a calibrated p of exactly zero would claim the effect
 * is larger than anything the provider could produce on its own, which 500 splits cannot establish.
 */
export function calibratedP(calibration: NullCalibration, observed: number): number | null {
  // NULL, not NaN. There is no calibrated p when the baseline was too thin to split, and NaN is not
  // serializable under this project's canonical JSON: it broke `--format json` once already through
  // `allPassCeiling`, and this is the same hole in a second place. Null says "no calibration was
  // possible" and survives a round trip; NaN says the same thing and throws.
  if (!calibration.usable || calibration.sorted.length === 0) return null;
  const target = Math.abs(observed);
  let atLeastAsExtreme = 0;
  for (const s of calibration.sorted) if (s >= target - 1e-12) atLeastAsExtreme += 1;
  return (atLeastAsExtreme + 1) / (calibration.sorted.length + 1);
}

/** A quantile of the measured noise floor, for the report's "how much does this provider wobble" line. */
export function nullQuantile(calibration: NullCalibration, q: number): number | null {
  const n = calibration.sorted.length;
  if (n === 0) return null;
  const at = Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))));
  return calibration.sorted[at] as number;
}
