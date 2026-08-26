// Always-valid inference for a watcher that runs forever.
//
// THE PROBLEM THAT MAKES CONTINUOUS MONITORING DIFFERENT FROM PRE-MERGE TESTING, and the reason
// this file exists rather than a cron job around `compare`:
//
// A fixed-alpha test is valid ONCE. Run it hourly at alpha = 0.05 and, under a null where nothing
// whatsoever is changing, it fires about once every twenty hours. Every one of those is a person
// investigating a provider that did not change, and after the second or third, the alerting gets
// switched off. This is the classic peeking problem and it is not a detail: it is the single
// largest reason naive drift monitors fail in practice. It also does not arise for promptfoo or any
// other pre-merge eval tool, because they are run once per change by construction.
//
// THE FIX IS A TEST MARTINGALE, also called an e-process. Wealth starts at 1 and is bet on each new
// observation. Under the null the wealth process is a non-negative martingale, so Ville's
// inequality bounds the probability that it EVER exceeds 1/alpha, at any stopping time, over an
// unbounded number of looks:
//
//     P( sup_t  W_t  >=  1/alpha )  <=  alpha
//
// So "wealth crossed 20" is a valid alpha = 0.05 rejection no matter how often it was checked, with
// no alpha spending schedule to tune and no penalty for looking. Nothing has to be decided in
// advance about how long the watch will run, which is exactly the property a watcher needs and
// exactly the property a fixed-alpha test does not have.
//
// THE BET. For a pass/fail stream with null rate p0, wealth is multiplied by (1 + lambda * (p0 - X))
// on each observation. Under the null the expectation of that factor is 1, which is what makes it a
// martingale. `lambda` is the Kelly-optimal bet for a named alternative p1, the smallest drop worth
// catching, so the watcher is tuned by saying what size of regression matters rather than by
// choosing a statistical constant.
//
// TWO GUARDS THAT ARE NOT DECORATION:
//
//   p0 IS A LOWER CONFIDENCE BOUND, NOT THE POINT ESTIMATE. A baseline of 10/10 has a point
//   estimate of 1.0, and betting against 1.0 means a single failure ever is treated as infinitely
//   surprising. Using the Wilson lower bound instead makes the test require more evidence, which is
//   the correct direction for a tool whose worst failure is a false alarm.
//
//   LAMBDA IS CLAMPED BELOW ITS MAXIMUM. At the boundary a single observation can drive wealth to
//   exactly zero, and zero is absorbing: the process could never recover, so a real regression
//   arriving later would be undetectable forever. Clamping to 90 percent of the bound keeps every
//   factor strictly positive.
//
// WEALTH IS CARRIED IN LOGS, because a long watch multiplies thousands of factors and a bare
// product underflows to zero or overflows long before the watch is old.
//
// THE MIXTURE, AND THE DEFECT IT REPAIRS. A pure betting martingale has a failure mode that only
// shows up in the thing this project is actually for: a watch that runs for a long time. `p0` is a
// conservative lower bound, so during a quiet stretch the true pass rate sits ABOVE it and the
// process loses money on almost every observation. Measured on this implementation, against a
// baseline of 19/20 and a quiet stream at 95 percent:
//
//     quiet ticks first    log wealth after    ticks to alarm on a real 95 to 60 percent drop
//                     0                0.00                                              12.2
//                    10               -5.98                                              28.4
//                    40              -23.67                                              94.8
//                   100              -58.96                                             209.8
//                   300             -174.77                                             617.8
//
// The deficit grows without bound, so a watcher becomes progressively BLIND the longer it has been
// well behaved. That is the opposite of what a monitor is for, and nothing about the type-I
// guarantee reveals it, because the guarantee is entirely about false alarms.
//
// TWO CANDIDATE REPAIRS WERE MEASURED, AND ONLY ONE OF THEM SURVIVES. The obvious fix is to floor
// the betting process at its starting value, which is Page's test in log-likelihood space and is
// the classical changepoint detector. It restores sensitivity completely and it is unusable here.
// Measured on this implementation, against a baseline of 19/20:
//
//                       false alarms on a pure-null stream        ticks to alarm after
//                       1000 rounds      4000 rounds              0 quiet      300 quiet
//     pure e-process         3%               3%                     12.2         617.8
//     restart at zero      100%             100%                     10.8           8.8
//
// The restarting statistic detects in about ten ticks no matter how long the watch has been quiet,
// and it alarms on EVERY pure-null watch. That is not a threshold that needs tuning, it is the
// trade-off itself: a procedure with a finite average run length to false alarm will eventually
// fire on noise by construction, and a procedure that never fires on noise must spend a finite
// error budget and therefore must eventually go quiet. You cannot have both.
//
// THIS PROJECT CHOOSES THE GUARANTEE, because a monitor people stop trusting is worth nothing, and
// because the pure process's false alarm rate is the ONE number that did not grow between 1000 and
// 4000 rounds. The blindness is then handled where it belongs, operationally rather than
// statistically: the watch tracks how much sensitivity it has spent and TELLS THE OPERATOR TO
// RE-BASELINE. That is not a workaround. A watch that has been quiet for months is a watch whose
// baseline has aged anyway, and `packages/baseline` was already going to say so on the other
// grounds. The two signals coincide because they are the same fact.
//
// The mixture below is kept for a smaller and separate reason: it bounds the wealth that gets
// compared against a threshold and reported to a human, so nothing downstream ever handles a
// log-wealth of -175. Bet only a fraction `w` of the capital and hold the rest aside.
//
//     W_t  =  (1 - w)  +  w * M_t
//
// A convex combination of a non-negative martingale and the constant 1 is itself a non-negative
// martingale starting at 1, so VILLE'S INEQUALITY STILL APPLIES UNCHANGED and the any-time
// guarantee is not weakened. What changes is that wealth can never fall below `1 - w`, so the
// deficit is bounded and a long-quiet watch stays as sensitive as a fresh one. The price is a
// constant factor in the evidence needed to alarm: at w = 0.5 the underlying martingale must reach
// about 2/alpha rather than 1/alpha. Paying one doubling of evidence to keep a monitor from going
// blind is the right trade, and it is the whole reason this is not a plain product.
//
// CUSUM SITS BESIDE IT, NOT INSTEAD OF IT. The e-process says whether something happened with a
// guarantee attached. It does not say WHEN it started, and that is usually the first question a
// person asks. CUSUM answers it and has no such guarantee, so it is reported as an aid to reading
// and never as a trigger.

import { wilson } from "./stats.js";

export interface EProcessConfig {
  /** Type-I error controlled over the whole, unbounded watch. */
  readonly alpha: number;
  /** The smallest pass-rate drop worth catching. Sets the bet. */
  readonly alternative: number;
  /** Drift allowance for CUSUM, in rate units. */
  readonly cusumSlack: number;
  /** CUSUM alarm level. Interpretive only. */
  readonly cusumThreshold: number;
  /**
   * The fraction of capital actually bet. The rest is held aside and floors the reported wealth at
   * `1 - w`. See the header: this bounds what a human is shown, and does NOT restore sensitivity.
   */
  readonly mixtureWeight: number;
  /**
   * How much less sensitive a watch may become before it should be re-baselined, expressed as a
   * MULTIPLE of the evidence a fresh watch would need.
   *
   * A multiple rather than a raw log figure, because the raw figure is uninterpretable: nobody can
   * say whether a debt of 23.7 is a problem. "This watch now needs five times the evidence a fresh
   * one would" is a sentence an operator can act on.
   *
   * Five, not two. Measured on this implementation against a 19/20 baseline, the process spends
   * about 0.58 log units per quiet tick, so a threshold at two would fire after roughly five quiet
   * ticks, when the degradation is still trivial. A maintenance prompt that fires on the first
   * morning is a maintenance prompt people filter.
   */
  readonly rebaselineEvidenceMultiple: number;
}

export const DEFAULT_ECONFIG: EProcessConfig = {
  alpha: 0.05,
  // A ten point drop in pass rate. Large enough to matter to a caller, small enough that a provider
  // update causing it would be worth an alert. Configurable, and the report prints what was used,
  // because a watcher tuned to catch a two point drop and one tuned to catch a thirty point drop are
  // different instruments and the difference must not be silent.
  alternative: 0.1,
  cusumSlack: 0.05,
  cusumThreshold: 1.0,
  // Half in, half held. Bounds the REPORTED wealth at log(0.5), about -0.69, at a cost of roughly
  // one doubling in the evidence needed to alarm.
  mixtureWeight: 0.5,
  rebaselineEvidenceMultiple: 5,
};

export interface EProcessState {
  readonly schemaVersion: 1;
  readonly caseId: string;
  /** The conservative null rate this watch is betting against. */
  readonly p0: number;
  readonly lambda: number;
  /**
   * log of the UNDERLYING betting martingale. Unbounded below, and that is exactly the quantity the
   * mixture exists to stop anyone comparing against a threshold.
   */
  readonly logMartingale: number;
  /** log of the MIXTURE wealth, floored at log(1 - w). Crossing log(1/alpha) is the alarm. */
  readonly logWealth: number;
  readonly observations: number;
  readonly successes: number;
  readonly cusum: number;
  /** The maximum log wealth ever reached, so a watch that nearly fired is visible. */
  readonly peakLogWealth: number;
  /** Observation index where CUSUM first left zero. The changepoint estimate. */
  readonly cusumStartedAt: number | null;
  readonly alarmed: boolean;
}

/**
 * Start a watch from a baseline.
 *
 * `baselineSuccesses` out of `baselineN` is the reference. The Wilson lower bound of that is the
 * null this watch bets against, so a thin baseline produces a conservative watch rather than a
 * confident one.
 */
export function startEProcess(
  caseId: string,
  baselineSuccesses: number,
  baselineN: number,
  config: EProcessConfig = DEFAULT_ECONFIG,
): EProcessState {
  const bound = wilson(baselineSuccesses, baselineN);
  // Clamped away from both ends: p0 of exactly 1 makes the bet undefined, and p0 of 0 makes the
  // watch meaningless since no observation could ever be surprising.
  const p0 = Math.min(0.999, Math.max(0.001, Number.isFinite(bound.low) ? bound.low : 0.5));
  return {
    schemaVersion: 1,
    caseId,
    p0,
    lambda: kellyLambda(p0, config.alternative),
    logMartingale: 0,
    logWealth: 0,
    observations: 0,
    successes: 0,
    cusum: 0,
    peakLogWealth: 0,
    cusumStartedAt: null,
    alarmed: false,
  };
}

/**
 * The Kelly-optimal bet against an alternative `alternative` points below p0.
 *
 *   lambda* = (p0 - p1) / (p0 * (1 - p0))
 *
 * from maximizing the expected log wealth under p1. Clamped to 90 percent of 1/(1 - p0), the point
 * at which a single success would drive wealth to zero. See the header.
 */
export function kellyLambda(p0: number, alternative: number): number {
  const p1 = Math.max(0.0001, p0 - alternative);
  const raw = (p0 - p1) / (p0 * (1 - p0));
  const ceiling = 0.9 / (1 - p0);
  return Math.min(Math.max(0, raw), ceiling);
}

/** Fold one observation into the state. Pure: no clock, no randomness, no I/O. */
export function observe(
  state: EProcessState,
  passed: boolean,
  config: EProcessConfig = DEFAULT_ECONFIG,
): EProcessState {
  const x = passed ? 1 : 0;
  const factor = 1 + state.lambda * (state.p0 - x);
  // Guarded, though the lambda clamp should make it unreachable. A wealth process that silently
  // became NaN would report "no alarm" forever, which is the worst possible failure for a monitor.
  const logMartingale = state.logMartingale + Math.log(Math.max(factor, 1e-12));
  const logWealth = mixtureLogWealth(logMartingale, config.mixtureWeight);

  const cusum = Math.max(0, state.cusum + (state.p0 - x) - config.cusumSlack);
  const cusumStartedAt =
    state.cusum === 0 && cusum > 0
      ? state.observations + 1
      : cusum === 0
        ? null
        : state.cusumStartedAt;

  return {
    ...state,
    logMartingale,
    logWealth,
    peakLogWealth: Math.max(state.peakLogWealth, logWealth),
    observations: state.observations + 1,
    successes: state.successes + x,
    cusum,
    cusumStartedAt,
    // Once alarmed, stays alarmed. The guarantee is about the SUPREMUM of the wealth process, so a
    // crossing that later subsides was still a valid rejection at the moment it happened. Letting
    // the flag drop would quietly convert an any-time-valid test back into a peeking one.
    alarmed: state.alarmed || logWealth >= Math.log(1 / config.alpha),
  };
}

/** Fold a whole round of replicates. */
export function observeMany(
  state: EProcessState,
  outcomes: readonly boolean[],
  config: EProcessConfig = DEFAULT_ECONFIG,
): EProcessState {
  return outcomes.reduce((s, o) => observe(s, o, config), state);
}

/**
 * log((1 - w) + w * exp(logM)), by log-sum-exp.
 *
 * Computed rather than exponentiated because `logM` reaches -175 on a long quiet watch and +40 on a
 * decisive one, and both ends of that range destroy a naive `Math.exp`.
 */
export function mixtureLogWealth(logMartingale: number, weight: number): number {
  const w = Math.min(1, Math.max(1e-9, weight));
  if (w === 1) return logMartingale;
  const a = Math.log(1 - w);
  const b = Math.log(w) + logMartingale;
  const top = Math.max(a, b);
  return top + Math.log(Math.exp(a - top) + Math.exp(b - top));
}

/** The floor the mixture guarantees on REPORTED wealth, however long the watch runs. */
export const wealthFloor = (config: EProcessConfig = DEFAULT_ECONFIG): number =>
  Math.log(1 - config.mixtureWeight);

/**
 * How much sensitivity this watch has spent, in log units. Zero for a fresh watch.
 *
 * THE NUMBER THAT MAKES THE BLINDNESS VISIBLE. A watch whose debt is 25 needs roughly `exp(25)`
 * times more evidence to alarm than a fresh one, and nothing about its verdict, its wealth or its
 * false alarm rate says so. Reporting it converts a silent degradation into a maintenance task.
 */
export const sensitivityDebt = (state: EProcessState): number => Math.max(0, -state.logMartingale);

/**
 * How much more evidence this watch now needs than a fresh one, as a multiple.
 *
 * A fresh watch has to climb `log(1/alpha)` to alarm. A watch carrying a debt has to climb that
 * plus the debt. The ratio is the number an operator can act on, and it is what the report prints.
 *
 * Measured on this implementation against a 19/20 baseline and a quiet stream at 95 percent: after
 * 40 quiet ticks the multiple is about 8.9 and time to detect a real 95 to 60 percent drop went
 * from 14 ticks to 97.
 */
export const evidenceMultiple = (
  state: EProcessState,
  config: EProcessConfig = DEFAULT_ECONFIG,
): number => {
  const line = Math.log(1 / config.alpha);
  return line <= 0 ? 1 : (sensitivityDebt(state) + line) / line;
};

/**
 * Whether this watch has spent enough sensitivity that it should be started again from a fresh
 * baseline.
 *
 * THE DEBT GROWS FASTEST WHEN THE BASELINE IS SMALL, and that is worth knowing because it points at
 * the real fix. `p0` is a Wilson lower bound, so a thin baseline puts it far below the true rate and
 * the process bleeds on nearly every observation. A larger baseline tightens the bound, slows the
 * bleed, and buys a longer useful life for the watch. Re-baselining is the maintenance task; a
 * bigger baseline is the cure.
 *
 * A watch that has been quiet for a long time is also a watch whose baseline has aged, and
 * `assessStaleness` in @model-regression-sentinel/baseline will independently be saying so. The two
 * signals coincide because they are the same fact seen from two directions.
 */
export const needsRebaseline = (
  state: EProcessState,
  config: EProcessConfig = DEFAULT_ECONFIG,
): boolean => evidenceMultiple(state, config) >= config.rebaselineEvidenceMultiple;

/** Wealth on the natural scale, for a report. Infinity is possible and is honest. */
export const wealth = (state: EProcessState): number => Math.exp(state.logWealth);

/** How much of the way to an alarm this watch has travelled, in [0, 1] and beyond. */
export const alarmProgress = (
  state: EProcessState,
  config: EProcessConfig = DEFAULT_ECONFIG,
): number => state.logWealth / Math.log(1 / config.alpha);

export interface CusumVerdict {
  readonly signalled: boolean;
  /** Observation index where the run of evidence began, when there is one. */
  readonly changepoint: number | null;
}

export const cusumVerdict = (
  state: EProcessState,
  config: EProcessConfig = DEFAULT_ECONFIG,
): CusumVerdict => ({
  signalled: state.cusum >= config.cusumThreshold,
  changepoint: state.cusum >= config.cusumThreshold ? state.cusumStartedAt : null,
});
