// The public surface of @model-regression-sentinel/baseline.
//
// Hand-curated, never `export *`. A barrel built from a wildcard publishes whatever happens to be
// exported today, which turns every internal rename into a breaking change for somebody and makes
// the package's API impossible to review in one place. THIS LIST IS THE API: a name that is not
// here is internal and may move without a major version.
//
// Ordered so it reads top to bottom: putting a run on disk, then asking how old it is, then the A/A
// control that is dealt out of it.

// ---- the snapshot store ----------------------------------------------------------------------------
export { listSnapshots, readSnapshot, snapshotDigest, writeSnapshot } from "./store.js";

// ---- staleness, which is not one verdict for all six metrics ------------------------------------------
export {
  DEFAULT_HORIZON,
  OPERATIONAL_METRICS,
  assessStaleness,
  untrustworthyMetrics,
} from "./staleness.js";

// ---- the A/A archive, where the false positive rate comes from -----------------------------------------
export { MIN_REPLICATES_FOR_SPLIT, manyAaSplits, splitForAaControl } from "./archive.js";

// ---- types -----------------------------------------------------------------------------------------------
export type { SnapshotEntry } from "./store.js";
export type { StalenessHorizon, StalenessVerdict, Trust } from "./staleness.js";
export type { AaPair } from "./archive.js";
