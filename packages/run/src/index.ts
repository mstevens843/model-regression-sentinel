// The public surface of @model-regression-sentinel/run.
//
// Hand-curated. `export *` would publish whatever happens to be exported today and turn every
// internal rename into someone else's breaking change.

// ---- the provider seam ---------------------------------------------------------------------------
export {
  AnthropicApiProvider,
  ClaudeCliProvider,
  NoopProvider,
  OpenAiCompatibleProvider,
  PROVIDER_REGISTRY,
  ReplayProvider,
  replayTable,
  requestKey,
} from "./providers/index.js";
export { skipped } from "./types.js";

// ---- running a corpus ----------------------------------------------------------------------------
export { corpusDigestOf, observedFingerprints, renderRequest, runCorpus } from "./runner.js";

// ---- identity, which is drift detection with no statistics in it ------------------------------------
export { fingerprintDiff, fingerprintOf, undisclosedFields } from "./fingerprint.js";

// ---- cost, always as two bounds --------------------------------------------------------------------
export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  RATES,
  RATE_CARD_DATE,
  RATE_CARD_SOURCE,
  canonicalRateKey,
  summariseCost,
} from "./cost.js";

// ---- types -------------------------------------------------------------------------------------------
export type { Availability, CompletionRequest, Provider, ProviderResponse } from "./types.js";
export type { RunOptions, RunRecord, RunSnapshot } from "./runner.js";
export type { FingerprintChange, ProviderFingerprint } from "./fingerprint.js";
export type { CostBounds, CostInput } from "./cost.js";
export type {
  ClaudeCliOptions,
  ExecResult,
  Fetcher,
  Perturbation,
  ProviderEntry,
  ReplayOptions,
} from "./providers/index.js";
