// The vocabulary a frozen drift corpus is written in.
//
// Three decisions here carry the whole design, and each exists because of something measured rather
// than something assumed.
//
// 1. A CASE NAMES THE METRIC THAT MUST MOVE. `requiredSignals` is the analogue of the sibling
//    project's `requiredReasons` (agent-context-containment/packages/core/src/corpus.ts). The
//    lesson there was that grading only the OUTCOME passes an implementation that got the right
//    answer for a reason that does not apply. A drift detector has the same failure: a case where
//    quality collapsed and a detector that flagged it on a latency wobble are not the same event,
//    and a scoreboard that cannot tell them apart will certify a detector that is reading noise.
//
// 2. A CASE MAY DECLARE WHAT IT CANNOT SEE. `detectionLimit` is the analogue of
//    `containmentLimit`. Some drift is structurally invisible to this method: a model that becomes
//    subtly worse at a judgement no deterministic grader can score is real drift that this tool
//    will miss. Those cases are counted and reported in their own row rather than quietly dropped.
//    A corpus with none of them is a rigged corpus.
//
// 3. THE ARCHETYPE IS PART OF THE CASE. A pilot on this machine measured latency CV at 7.5 percent
//    on a constrained one-word answer and 70.8 percent on a free-form sentence, and 8/8 identical
//    outputs on two constrained cases against a 32 percent output-token CV on a reasoning-heavy
//    structured one. Those are different noise regimes, not different amounts of the same noise, so
//    a corpus that does not span them is a corpus tuned on one easy shape. `Archetype` makes the
//    span checkable instead of hoped for.
//
// There is no zod and no runtime validation library, matching both sibling repositories. Validation
// is `checkCorpus`, which returns every violation rather than throwing at the first, because a
// corpus can be wrong in several independent ways at once.

declare const BRAND: unique symbol;
type Branded<T, B extends string> = T & { readonly [BRAND]: B };

/** A case in the frozen corpus. */
export type CaseId = Branded<string, "CaseId">;
/** A versioned, content-hashed prompt template. Recorded on every call. */
export type PromptId = Branded<string, "PromptId">;

// Constructors. Deliberately unchecked casts: validation belongs at the parse boundary, in
// `checkCorpus`, not scattered through every construction site.
export const caseId = (v: string): CaseId => v as CaseId;
export const promptId = (v: string): PromptId => v as PromptId;

/**
 * Which set a case belongs to. Also encoded in the id, so moving one between sets is loud.
 *
 *   `canary`   the small set re-run on a schedule by `watch`. Kept cheap on purpose: it is paid
 *              for every tick, forever, and a canary set nobody can afford to run hourly is a
 *              canary set that does not run.
 *   `extended` the fuller set used by `compare`. Run on demand, so it may contain the slow,
 *              expensive, reasoning-heavy cases that would make an hourly canary unaffordable.
 *
 * They are never pooled into one number. The canary is underpowered by construction and saying so
 * is the point; pooling it with the extended set would hide that behind a bigger denominator.
 */
export type Split = "canary" | "extended";

export const ALL_SPLITS: readonly Split[] = ["canary", "extended"] as const;

/** The id infix each split uses. A case whose id and split disagree is a corpus violation. */
export const SPLIT_INFIX: Readonly<Record<Split, string>> = {
  canary: "-c-",
  extended: "-x-",
};

/**
 * The shape of the answer, which is the shape of its noise.
 *
 * Measured on this machine, n=8 per condition, alias `sonnet`, default temperature:
 *
 *   constrained_categorical   8/8 identical output; latency CV 7.5 percent
 *   constrained_numeric       8/8 identical output; latency CV 12.6 percent
 *   free_form                 3 recurring lexical modes; output-token CV 18.5 percent;
 *                             latency CV 70.8 percent with one sample at 3.57x the median
 *   structured_json           stable decision field, confidence varying 0.80/0.85/0.90,
 *                             output-token CV about 32 percent, latency 10 to 18 seconds
 */
export type Archetype =
  | "constrained_categorical"
  | "constrained_numeric"
  | "free_form"
  | "structured_json";

export const ALL_ARCHETYPES: readonly Archetype[] = [
  "constrained_categorical",
  "constrained_numeric",
  "free_form",
  "structured_json",
] as const;

/**
 * A metric a case can be scored on.
 *
 * `latencyMs` is here and is deliberately NOT gating. See `GATING_METRICS` below.
 */
export type MetricKey =
  /** Did the deterministic graders pass. Binary per replicate. */
  | "quality"
  /** Did the output parse and satisfy the declared JSON Schema. Binary. Only for schema cases. */
  | "schemaValid"
  /** Did the model decline rather than answer. Binary. A refusal-rate shift is real drift. */
  | "refusal"
  /** Completion tokens. Continuous, and the best-behaved continuous drift signal measured. */
  | "outputTokens"
  /** Server-reported call duration. Continuous, fat-tailed, and confounded by everything. */
  | "latencyMs"
  /** Cost of the call. Continuous, and mostly a deterministic function of tokens. */
  | "costUsd";

export const ALL_METRICS: readonly MetricKey[] = [
  "quality",
  "schemaValid",
  "refusal",
  "outputTokens",
  "latencyMs",
  "costUsd",
];

/**
 * Metrics allowed to set a non-zero exit code.
 *
 * LATENCY IS EXCLUDED, and this is a measurement rather than a preference. In a pilot of eight
 * replicates of one free-form case on this machine, latency ran 1780, 2054, 2094, 2258, 2292, 2453,
 * 2657 and 8112 ms. One sample in eight was 3.57 times the median. A baseline captured last month is
 * compared against today's network, today's provider load and today's routing, none of which the
 * tool observes. A latency comparison across an aged baseline is an observation, and a CI gate built
 * on it fails builds for reasons nobody can act on, which is how a drift gate gets switched off.
 *
 * COST IS EXCLUDED for a different reason: it is very nearly a deterministic function of the token
 * counts and the rate card, so gating on it double-counts `outputTokens` and additionally fires
 * whenever a vendor reprices, which is not drift.
 */
export const GATING_METRICS: readonly MetricKey[] = [
  "quality",
  "schemaValid",
  "refusal",
  "outputTokens",
];

/** JSON, as a type, so a schema or a structured payload can be carried without `any`. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A deterministic grader.
 *
 * EVERY GRADER IS CODE, AND THAT IS THE CENTRAL CONSTRAINT OF THIS PROJECT. An LLM judge is itself
 * a drifting instrument: a tool that measures model drift with a model has a moving ruler and
 * cannot attribute a change to the thing it is watching rather than to the thing it is watching
 * with. That rules out the most flexible grading method available, it genuinely narrows what can be
 * scored, and it is the correct trade here and only here.
 */
export type Grader =
  /** The whole trimmed output equals this string. */
  | { readonly kind: "exact"; readonly expected: string; readonly caseSensitive?: boolean }
  /** The whole trimmed output equals one of these. For a case with several defensible answers. */
  | {
      readonly kind: "oneOf";
      readonly expected: readonly string[];
      readonly caseSensitive?: boolean;
    }
  /** The output matches. Anchored patterns only, by convention: a bare substring grader is how the
   *  sibling scored every refusal beginning "I cannot evaluate the safety of" as a confident SAFE. */
  | { readonly kind: "regex"; readonly pattern: string; readonly flags?: string }
  /** The output parses as JSON and satisfies the case's declared schema. */
  | { readonly kind: "jsonSchema" }
  /** A numeric field of the parsed output is within tolerance of an expected value. */
  | {
      readonly kind: "numericTolerance";
      readonly field: string;
      readonly expected: number;
      readonly tolerance: number;
    }
  /** The output is not a refusal. Shares one lexicon with the refusal metric, so the two can never
   *  disagree about what a refusal is. */
  | { readonly kind: "nonRefusal" };

/** Where a case came from. A case with no provenance is a case nobody can audit. */
export type CaseProvenance =
  | { readonly kind: "original" }
  | {
      readonly kind: "derived";
      readonly from: "durable-agent-outbox" | "agent-context-containment";
      /** Locator inside the sibling repository, precise enough to find by hand. */
      readonly ref: string;
      /** What was changed and why. Required and non-empty: a silent adaptation is not attribution. */
      readonly modifications: string;
    };

/** What the model is asked. Frozen: changing any byte here changes the case hash. */
export interface CaseInput {
  readonly system: string;
  readonly user: string;
  /** When present the provider is asked for structured output against this schema. */
  readonly jsonSchema?: JsonValue;
  readonly maxOutputTokens?: number;
}

/** One frozen case. */
export interface EvalCase {
  /**
   * A literal, not a number, and there is no migration path by design.
   *
   * The corpus bytes are frozen and covered by MANIFEST.sha256, so a required field can never be
   * added: doing so would have to rewrite files whose digests are the instrument. Schema evolution
   * is therefore OPTIONAL FIELDS ONLY, forever. The freeze and the schema enforce each other.
   */
  readonly schemaVersion: 1;
  readonly id: CaseId;
  readonly split: Split;
  readonly archetype: Archetype;
  /** One line, imperative, no marketing. */
  readonly title: string;
  readonly promptId: PromptId;
  readonly input: CaseInput;
  readonly graders: readonly Grader[];
  /**
   * The metrics that must move for a detection on this case to count as the detection this case
   * was written for. Non-empty. See the header.
   */
  readonly requiredSignals: readonly MetricKey[];
  /**
   * Non-null means drift of some kind is structurally invisible here, and the case is reported in
   * its own row rather than in the headline. Says what, in one sentence.
   */
  readonly detectionLimit: string | null;
  readonly provenance: CaseProvenance;
  readonly authoredAt: string;
  readonly note: string;
}

/** The library's one error type. Carries a machine code so a caller never matches on message text. */
export type SentinelErrorCode =
  | "corpus_invalid"
  | "manifest_mismatch"
  | "freeze_invalid"
  | "uncanonicalizable_value"
  | "unknown_case"
  | "provider_failure"
  | "insufficient_replicates";

const RECOVERABLE_CODES: ReadonlySet<SentinelErrorCode> = new Set<SentinelErrorCode>([
  "provider_failure",
]);

export interface SentinelErrorPayload {
  readonly code: SentinelErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
}

export class SentinelError extends Error implements SentinelErrorPayload {
  readonly code: SentinelErrorCode;
  readonly recoverable: boolean;

  constructor(code: SentinelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SentinelError";
    this.code = code;
    this.recoverable = RECOVERABLE_CODES.has(code);
  }

  toPayload(): SentinelErrorPayload {
    return { code: this.code, message: this.message, recoverable: this.recoverable };
  }

  static fromPayload(p: SentinelErrorPayload): SentinelError {
    return new SentinelError(p.code, p.message);
  }
}
