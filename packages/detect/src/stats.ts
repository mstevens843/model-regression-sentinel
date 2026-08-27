// The statistics, chosen for stated reasons, and each one able to make a result look worse.
//
// This is the first TypeScript statistics in this portfolio. `wilson`, `wilsonHalfwidth` and the
// seeded percentile bootstrap are ports of
// `toolcall-risk-classifier/src/toolcall_risk/eval/metrics.py`, and its reasoning is kept rather
// than re-derived. The exact Mann-Whitney distribution, the Hodges-Lehmann estimator and the
// Benjamini-Hochberg procedure are new here; NO MULTIPLE-COMPARISON CORRECTION EXISTS ANYWHERE IN
// THE PORTFOLIO, so that layer has no precedent to lean on and the README says so.
//
// WILSON, NOT THE NORMAL APPROXIMATION, for every proportion. At the sample sizes here the normal
// interval under-covers badly and DEGENERATES TO ZERO WIDTH AT p = 0 OR p = 1. That is not a corner
// case in this project, it is the common case: a pilot on this machine returned 8/8 identical
// answers on two separate constrained cases. An interval that reports zero uncertainty about a
// perfect score is the single most dangerous number a drift tool could print. Clopper-Pearson is
// rejected for over-covering, which would widen every interval and make every difference look less
// resolved than it is - the flattering direction for a tool reporting no drift.
//
// EXACT MANN-WHITNEY WHERE IT IS AVAILABLE. The normal approximation is fine at large n and this
// project does not have large n. The exact null distribution is computed by dynamic programming
// when there are no ties and the table is small enough; with ties the exact distribution is not
// valid and the tie-corrected normal approximation is used instead. Which one ran is REPORTED, not
// hidden, because they are different claims.
//
// HODGES-LEHMANN FOR THE LATENCY SHIFT, not a difference of means. Measured on this machine, one
// free-form case produced eight latencies of which one was 3.57 times the median. A mean-based
// shift estimate on that sample is not robust in the technical sense and is not honest in the
// ordinary sense.

/** A point estimate with an interval and the n it came from. */
export interface Interval {
  readonly point: number;
  readonly low: number;
  readonly high: number;
  readonly n: number;
}

/**
 * Below this many observations a percentage is not reported as a percentage.
 *
 * Inherited from the sibling, which enforces the same floor in one place so it can only be weakened
 * in one place. A rate over six draws is a fraction with a big denominator missing.
 */
export const MIN_N_FOR_RATE = 20;

export const formatInterval = (i: Interval): string =>
  i.n < MIN_N_FOR_RATE
    ? `${i.point.toFixed(3)} [n=${i.n}, below the reporting floor]`
    : `${i.point.toFixed(3)} [${i.low.toFixed(3)}, ${i.high.toFixed(3)}]`;

export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { point: Number.NaN, low: Number.NaN, high: Number.NaN, n: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { point: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half), n };
}

/** The resolution of a sample, printed beside a headline so nobody over-reads a delta. */
export function wilsonHalfwidth(p: number, n: number, z = 1.96): number {
  if (n === 0) return Number.NaN;
  const denom = 1 + (z * z) / n;
  return (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
}

/**
 * The rule of three: with zero failures in n trials, the 95 percent upper bound on the true failure
 * rate is about 3/n.
 *
 * THE MOST USEFUL HONEST NUMBER THIS TOOL PRINTS. A case that passes every replicate looks like
 * proof that nothing moved, and it is not: at n=10 an all-passing arm is still consistent with a
 * true failure rate of 30 percent. Everything about "all green" being weak evidence comes from
 * here.
 */
export const ruleOfThree = (n: number): number => (n <= 0 ? 1 : Math.min(1, 3 / n));

/**
 * The symmetric percent difference, bounded in [-2, 2].
 *
 * THE STATISTIC THAT REPLACED THE NAIVE RATIO, and it lives in stats.ts rather than in compare.ts
 * because BOTH the detector and the power simulator have to use it and a cycle would form the other
 * way round. That split is the whole reason a defect survived here: the fix landed in compare.ts,
 * `mde.ts` kept computing `(c - b) / b`, and nothing connected the two files.
 *
 * WHY NOT THE NAIVE RATIO. Dividing by the baseline is unbounded, and this corpus contains a case
 * that breaks it. `cnt-c-003` is bimodal - the model usually answers in one word and sometimes
 * writes a paragraph - and runs 5 to 480 output tokens in the recorded baseline, a 96x spread. A
 * resample whose denominator lands on the short mode produces a ratio in the thousands of percent,
 * and one such case dominates a statistic that averages over cases. Measured on that case, at a
 * true injected shift of +8 percent, over 3,000 resamples:
 *
 *     formula                       p50     p95     p99     max
 *     naive     (c - b) / b       0.078   1.244   2.223   9.620
 *     symmetric 2(c-b)/(c+b)      0.075   0.767   1.053   1.656
 *
 * The two agree to first order for the small changes that matter and diverge exactly where the
 * naive form stops being a measurement. Bounded means no single bimodal case can swamp the suite.
 *
 * Zero when both sides are zero, which is the right answer rather than a guard: two arms that both
 * produced nothing did not differ.
 */
export function symmetricRelative(candidate: number, baseline: number): number {
  const total = candidate + baseline;
  return total === 0 ? 0 : (2 * (candidate - baseline)) / total;
}

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo] as number;
  return (s[lo] as number) * (hi - pos) + (s[hi] as number) * (pos - lo);
}

export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

// ---- log factorials, for the exact tests ---------------------------------------------------------

const LOG_FACT: number[] = [0, 0];
function logFactorial(n: number): number {
  for (let i = LOG_FACT.length; i <= n; i += 1) {
    LOG_FACT[i] = (LOG_FACT[i - 1] as number) + Math.log(i);
  }
  return LOG_FACT[n] as number;
}
const logChoose = (n: number, k: number): number =>
  k < 0 || k > n
    ? Number.NEGATIVE_INFINITY
    : logFactorial(n) - logFactorial(k) - logFactorial(n - k);

/**
 * Two-sided Fisher exact test on a 2x2 table.
 *
 * Summing every table with the same margins whose probability is at most the observed one, which is
 * the conventional two-sided definition and the conservative one.
 *
 * ITS FLOOR IS THE POINT AT THESE SAMPLE SIZES. With 10 replicates in each arm, the smallest
 * attainable two-sided p is reached only at a perfect 10/10 against 0/10 split. A per-case test
 * therefore cannot reach significance on anything subtler than a total collapse, which is exactly
 * why per-case results in this project are labelled hypothesis-generating and the confirmatory test
 * is run across cases instead.
 */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  if (n === 0) return 1;
  const row1 = a + b;
  const col1 = a + c;
  const logP = (x: number): number =>
    logChoose(row1, x) + logChoose(n - row1, col1 - x) - logChoose(n, col1);

  const observed = logP(a);
  const lo = Math.max(0, col1 - (n - row1));
  const hi = Math.min(row1, col1);
  let total = 0;
  // A tolerance, because two tables that are equally probable in exact arithmetic can differ in the
  // last bit in floating point, and dropping one of them makes the p-value silently anti-conservative.
  const tol = 1e-9;
  for (let x = lo; x <= hi; x += 1) {
    const lp = logP(x);
    if (lp <= observed + tol) total += Math.exp(lp);
  }
  return Math.min(1, total);
}

// ---- Mann-Whitney --------------------------------------------------------------------------------

export type PValueMethod = "exact" | "normal-approximation";

export interface MannWhitneyResult {
  readonly u: number;
  readonly p: number;
  readonly method: PValueMethod;
  /** Probability a random draw from x exceeds one from y, ties counted as half. */
  readonly auc: number;
  readonly ties: boolean;
}

/**
 * Bounds on when the exact null distribution is enumerated.
 *
 * Both are needed and they bound different things. `EXACT_MWU_CELLS` bounds the DP work and memory,
 * which grows as n1 times n1 times n2. `EXACT_MWU_TOTAL` bounds n1 + n2 so that the total
 * arrangement count stays inside a double: the counts are exact integers only up to 2^53, and past
 * that the ratio is still accurate to about 1e-16, which is irrelevant against a threshold of 0.05,
 * but there is no reason to run a large exact computation when the normal approximation is already
 * excellent at that size. At the replicate counts this project actually uses, 10 against 10, both
 * bounds are met by a wide margin and the exact test always runs.
 */
const EXACT_MWU_CELLS = 2500;
const EXACT_MWU_TOTAL = 60;

export function mannWhitneyU(x: readonly number[], y: readonly number[]): MannWhitneyResult {
  const n1 = x.length;
  const n2 = y.length;
  if (n1 === 0 || n2 === 0) {
    return { u: Number.NaN, p: 1, method: "normal-approximation", auc: Number.NaN, ties: false };
  }

  const all = [...x.map((v) => ({ v, from: 0 })), ...y.map((v) => ({ v, from: 1 }))].sort(
    (a, b) => a.v - b.v,
  );
  // Mid-ranks for ties.
  const ranks = new Array<number>(all.length);
  const tieGroups: number[] = [];
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && (all[j + 1] as { v: number }).v === (all[i] as { v: number }).v)
      j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = avg;
    if (j > i) tieGroups.push(j - i + 1);
    i = j + 1;
  }
  const hasTies = tieGroups.length > 0;

  let rankSum1 = 0;
  all.forEach((item, index) => {
    if (item.from === 0) rankSum1 += ranks[index] as number;
  });
  const u1 = rankSum1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const auc = u1 / (n1 * n2);

  if (!hasTies && n1 * n2 <= EXACT_MWU_CELLS && n1 + n2 <= EXACT_MWU_TOTAL) {
    return { u, p: exactMwuP(u, n1, n2), method: "exact", auc, ties: false };
  }

  // Tie-corrected normal approximation with a continuity correction.
  const meanU = (n1 * n2) / 2;
  const n = n1 + n2;
  const tieTerm = tieGroups.reduce((acc, t) => acc + (t * t * t - t), 0);
  const varU = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (varU <= 0) return { u, p: 1, method: "normal-approximation", auc, ties: hasTies };
  const z = (Math.abs(u1 - meanU) - 0.5) / Math.sqrt(varU);
  return {
    u,
    p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))),
    method: "normal-approximation",
    auc,
    ties: hasTies,
  };
}

/**
 * The exact number of arrangements producing each value of U.
 *
 * The standard recurrence, which is the one thing here worth writing out because getting it subtly
 * wrong produces p-values that look plausible and are not:
 *
 *   N(u, m, n) = N(u - n, m - 1, n) + N(u, m, n - 1)
 *
 * with N(0, m, 0) = N(0, 0, n) = 1. Equivalently, the number of partitions of u that fit inside an
 * m by n box. `mwuTotal` below is asserted against the binomial coefficient in the tests, because a
 * recurrence that has drifted usually still sums to something and the only cheap way to notice is
 * to check it sums to the right thing.
 */
function mwuCounts(m: number, n: number): Float64Array {
  const maxU = m * n;
  let table: Float64Array[] = [];
  for (let i = 0; i <= m; i += 1) {
    const row = new Float64Array(maxU + 1);
    row[0] = 1; // N(u, i, 0) is 1 at u = 0 and 0 elsewhere.
    table.push(row);
  }
  for (let j = 1; j <= n; j += 1) {
    const next: Float64Array[] = [];
    for (let i = 0; i <= m; i += 1) {
      const row = new Float64Array(maxU + 1);
      if (i === 0) {
        row[0] = 1; // N(u, 0, j) is 1 at u = 0 and 0 elsewhere.
        next.push(row);
        continue;
      }
      const sameJ = next[i - 1] as Float64Array; // N(u - j, i - 1, j)
      const prevJ = table[i] as Float64Array; // N(u, i, j - 1)
      for (let u = 0; u <= maxU; u += 1) {
        row[u] = (prevJ[u] as number) + (u >= j ? (sameJ[u - j] as number) : 0);
      }
      next.push(row);
    }
    table = next;
  }
  return table[m] as Float64Array;
}

/** Total arrangements, which must equal C(m + n, m). Exported so a test can assert exactly that. */
export function mwuTotal(m: number, n: number): number {
  const counts = mwuCounts(m, n);
  let total = 0;
  for (let u = 0; u < counts.length; u += 1) total += counts[u] as number;
  return total;
}

function exactMwuP(u: number, n1: number, n2: number): number {
  const counts = mwuCounts(n1, n2);
  let total = 0;
  for (let k = 0; k < counts.length; k += 1) total += counts[k] as number;
  let tail = 0;
  for (let k = 0; k <= u; k += 1) tail += counts[k] as number;
  return Math.min(1, (2 * tail) / total);
}

export function normalCdf(z: number): number {
  // Abramowitz and Stegun 7.1.26 on erf. Accurate to about 1.5e-7, far inside anything that matters
  // for a p-value that is going to be compared against 0.05.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) * Math.SQRT1_2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * The Hodges-Lehmann shift: the median of all pairwise differences.
 *
 * The location estimate that goes with Mann-Whitney, and robust to the fat right tail that a
 * latency sample always has. Reported instead of a difference of means for the reason measured on
 * this machine: one sample in eight was 3.57 times the median, and it would have moved a mean by
 * more than any drift this tool is trying to detect.
 */
export function hodgesLehmann(x: readonly number[], y: readonly number[]): number {
  if (x.length === 0 || y.length === 0) return Number.NaN;
  const diffs: number[] = [];
  for (const a of x) for (const b of y) diffs.push(a - b);
  return median(diffs);
}

// ---- resampling ------------------------------------------------------------------------------------

/** Seeded percentile bootstrap over a sample. */
export function bootstrapCI(
  sample: readonly number[],
  statistic: (xs: readonly number[]) => number,
  rng: () => number,
  resamples = 2000,
): Interval {
  const n = sample.length;
  if (n === 0) return { point: Number.NaN, low: Number.NaN, high: Number.NaN, n: 0 };
  const point = statistic(sample);
  const draws: number[] = [];
  const buffer = new Array<number>(n);
  for (let r = 0; r < resamples; r += 1) {
    for (let i = 0; i < n; i += 1) buffer[i] = sample[Math.floor(rng() * n)] as number;
    const value = statistic(buffer);
    if (Number.isFinite(value)) draws.push(value);
  }
  if (draws.length === 0) return { point, low: Number.NaN, high: Number.NaN, n };
  draws.sort((a, b) => a - b);
  return {
    point,
    low: draws[Math.floor(0.025 * draws.length)] as number,
    high: draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))] as number,
    n,
  };
}

// ---- multiplicity --------------------------------------------------------------------------------

export interface FdrResult {
  /** Same order as the input. */
  readonly rejected: readonly boolean[];
  /** The largest p-value declared significant, or null when none was. */
  readonly threshold: number | null;
  readonly q: number;
}

/**
 * Benjamini-Hochberg, controlling the false discovery rate at q.
 *
 * WHY FDR AND NOT BONFERRONI. Per-case screening in this project is triage: the question is "which
 * cases are worth a human's attention", not "which cases are proven to have moved". Bonferroni
 * controls the probability of ANY false positive, which at 24 cases times several metrics leaves
 * essentially no power at these sample sizes, and a screen that never fires is a screen nobody
 * reads. FDR controls the expected PROPORTION of false positives among those flagged, which is the
 * quantity that actually matters when a person is deciding what to look at.
 *
 * ASSUMPTION: the case-level tests are independent or positively dependent. Cases in this corpus
 * are separate prompts scored by separate graders, so independence is a fair approximation, and the
 * dependence that does exist - all cases share one provider and one time window - is positive,
 * which is the direction BH tolerates. Benjamini-Yekutieli would hold under arbitrary dependence at
 * a cost of a log factor in power; it is not used, and this sentence is why.
 */
export function benjaminiHochberg(pValues: readonly number[], q = 0.1): FdrResult {
  const m = pValues.length;
  if (m === 0) return { rejected: [], threshold: null, q };
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let cut = -1;
  for (let k = 0; k < m; k += 1) {
    if ((order[k] as { p: number }).p <= ((k + 1) / m) * q) cut = k;
  }
  const rejected = new Array<boolean>(m).fill(false);
  if (cut === -1) return { rejected, threshold: null, q };
  for (let k = 0; k <= cut; k += 1) rejected[(order[k] as { i: number }).i] = true;
  return { rejected, threshold: (order[cut] as { p: number }).p, q };
}
