// The public surface of @model-regression-sentinel/detect.
//
// Hand-curated. Ordered so it reads top to bottom: the detector and its verdict, then the two nulls
// it judges against, then the power calculation that decides whether a null result means anything,
// then the continuous-monitoring machinery, then the calibration apparatus that grades the detector
// itself, then the raw statistics.

// ---- the detector --------------------------------------------------------------------------------
export { compare, exitCodeFor } from "./compare.js";
export { symmetricRelative } from "./stats.js";
export { referenceDetector, check, expectEqual } from "./detector.js";
export { observedNothing, whyItCouldNotLook } from "./observed.js";
export type { WatchSubject } from "./observed.js";
export { extractMetrics, pairCases } from "./metrics.js";

// ---- the two nulls -------------------------------------------------------------------------------
export { MAX_EXACT_K, signFlipTest } from "./permutation.js";
export { calibrateNull, calibratedP, nullQuantile } from "./nullCalibration.js";

// ---- power, and what a null result is worth --------------------------------------------------------
export {
  minimumDetectableEffect,
  minimumDetectableRelativeEffect,
  simulatePower,
  smoothedRate,
} from "./mde.js";

// ---- continuous monitoring -------------------------------------------------------------------------
export {
  DEFAULT_ECONFIG,
  alarmProgress,
  cusumVerdict,
  evidenceMultiple,
  kellyLambda,
  mixtureLogWealth,
  HEALTHY_MULTIPLE,
  needsRebaseline,
  observe,
  rebaselineAdvice,
  observeMany,
  sensitivityDebt,
  startEProcess,
  wealth,
  wealthFloor,
  worstAdvice,
} from "./eprocess.js";

// ---- grading the detector itself ---------------------------------------------------------------------
export { ALL_SCENARIOS } from "./scenarios.js";
export { ALL_MUTANTS } from "./mutants/index.js";
export { formatCalibration, runCalibration } from "./run.js";
export { synthCases, synthEvalCases, synthSnapshot } from "./synth.js";

// ---- statistics ---------------------------------------------------------------------------------------
export {
  MIN_N_FOR_RATE,
  benjaminiHochberg,
  bootstrapCI,
  fisherExactTwoSided,
  formatInterval,
  hodgesLehmann,
  mannWhitneyU,
  mean,
  median,
  mwuTotal,
  normalCdf,
  quantile,
  ruleOfThree,
  stdev,
  wilson,
  wilsonHalfwidth,
} from "./stats.js";
export { binomial, mulberry32, randomInt, shuffle } from "./rng.js";

// ---- types ----------------------------------------------------------------------------------------------
export type {
  CompareOptions,
  CompareResult,
  MetricFinding,
  PerCaseFinding,
  Verdict,
} from "./compare.js";
export type { CheckResult, Detector, WatchOutcome } from "./detector.js";
export type { MetricSamples } from "./metrics.js";
export type { PermutationMethod, PermutationResult, SignFlipOptions } from "./permutation.js";
export type { CaseSamples, NullCalibration } from "./nullCalibration.js";
export type { MdeOptions, MdeResult } from "./mde.js";
export type {
  CusumVerdict,
  EProcessConfig,
  EProcessState,
  RebaselineAdvice,
  SensitivityState,
} from "./eprocess.js";
export type { CalibrationScenario } from "./scenarios.js";
export type { DetectorMutant } from "./mutants/index.js";
export type { CalibrationReport, ScenarioResult } from "./run.js";
export type { SynthCase, SynthOptions } from "./synth.js";
export type { FdrResult, Interval, MannWhitneyResult, PValueMethod } from "./stats.js";
export type { Rng } from "./rng.js";
