// The public surface of @model-regression-sentinel/spec.
//
// Curated by hand rather than re-exported wholesale. A barrel built from `export *` publishes
// whatever happens to be exported today, which turns every internal rename into a breaking change
// for someone and makes the package's API impossible to review in one place. This list IS the API:
// if a name is not here it is internal and may move.
//
// Ordered so it reads top to bottom: the vocabulary, then the freeze discipline, then the graders,
// then the prompt registry, then the types.

// ---- vocabulary and validation -------------------------------------------------------------------
export {
  ALL_ARCHETYPES,
  ALL_METRICS,
  ALL_SPLITS,
  GATING_METRICS,
  SPLIT_INFIX,
  SentinelError,
  caseId,
  promptId,
} from "./types.js";
export { checkCorpus, formatCorpusViolations, producibleSignals } from "./corpus.js";
export {
  EXIT_CODES,
  EXIT_CODE_HELP,
  EXIT_CONFIRMED_REGRESSION,
  EXIT_COULD_NOT_LOOK,
  EXIT_MISUSE,
  EXIT_OK,
  describeExit,
} from "./exitCodes.js";
export { corpusFiles, loadCorpus, loadSplit, loadSplits, loadV1Corpus } from "./load.js";

// ---- the freeze discipline -----------------------------------------------------------------------
export { canonicalHash, canonicalJson, bytesHash, parseJson } from "./canonical.js";
export {
  SIDECARS,
  buildManifest,
  checkManifest,
  parseManifest,
  renderManifest,
} from "./manifest.js";
export { ageInDays, checkFreeze, formatFreezeViolations } from "./freeze.js";

// ---- grading ---------------------------------------------------------------------------------------
export { gradeOutput, readField } from "./graders.js";
export { REFUSAL_MARKERS, REFUSAL_WINDOW, detectRefusal } from "./refusal.js";
export { validateAgainstSchema } from "./jsonSchema.js";

// ---- the prompt registry ---------------------------------------------------------------------------
export {
  DECIDE,
  DEFAULT_PROMPT,
  EXPLAIN,
  REGISTRY,
  TERSE,
  getPrompt,
  promptHash,
} from "./prompts.js";

// ---- types -----------------------------------------------------------------------------------------
export type {
  Archetype,
  CaseId,
  CaseInput,
  CaseProvenance,
  EvalCase,
  Grader,
  JsonValue,
  MetricKey,
  PromptId,
  SentinelErrorCode,
  SentinelErrorPayload,
  SourceTrace,
  Split,
} from "./types.js";
export type { CheckScope, CorpusViolation, CorpusViolationCode } from "./corpus.js";
export type { ExitCode, ExitCodeMeaning } from "./exitCodes.js";
export type { FreezeRecord, FreezeState, FreezeViolation, FreezeViolationCode } from "./freeze.js";
export type { ManifestCheck, ManifestEntry, ManifestResult } from "./manifest.js";
export type { GradeResult, GradedOutput } from "./graders.js";
export type { RefusalVerdict } from "./refusal.js";
export type { SchemaError, SchemaResult } from "./jsonSchema.js";
export type { PromptVersion } from "./prompts.js";
