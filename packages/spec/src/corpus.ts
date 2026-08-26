// The corpus checker: what makes a set of cases an instrument rather than a folder of JSON.
//
// Returns violations rather than throwing, and returns ALL of them. A corpus can be wrong in
// several independent ways at once and a checker that stops at the first hides the rest. That is
// the sibling's rule (`agent-context-containment/packages/core/src/corpus.ts`) and it is right.
//
// THE TWO RULES THAT ARE NOT OBVIOUS, and that both come from the same idea:
//
//   REQUIRED_SIGNAL_UNGRADED. A case says which metric must move for a detection on it to count.
//   If a case names `quality` but ships no grader, then nothing can ever make `quality` move, and
//   the case is decoration that will sit in the corpus reporting green forever. This is the
//   drift-detector form of "right answer for the wrong reason": the sibling learned that grading
//   only the outcome passes an implementation whose reasoning was wrong, and the analogue here is
//   that a corpus which does not tie a case to a signal cannot tell a detector that saw the real
//   change from one that tripped over something else.
//
//   ARCHETYPE_SPAN. Enforced across the whole corpus rather than per case. A corpus of nothing but
//   constrained one-word answers would report a beautifully low noise floor and would have measured
//   nothing about the free-form and reasoning-heavy cases where the noise actually lives. Measured
//   on this machine: latency CV 7.5 percent constrained against 70.8 percent free-form. Tuning a
//   detector on the first and shipping it against the second is the most likely way this project
//   ships broken, so the span is a corpus-level violation.
//
// AN UNKNOWN FIELD IS NOT AN ERROR. `schemaVersion` is a literal 1 with an optional-fields-only
// evolution rule, so a case carrying a field this version does not know about is a case from a
// newer writer, and refusing it would make the frozen bytes unreadable by the thing that froze
// them. Unknown fields are ignored, deliberately and on the record.

import { REGISTRY } from "./prompts.js";
import {
  ALL_ARCHETYPES,
  type Archetype,
  type EvalCase,
  type MetricKey,
  SPLIT_INFIX,
} from "./types.js";

export type CorpusViolationCode =
  /** Two cases share an id. Every downstream join is by id. */
  | "DUPLICATE_ID"
  /** The id does not carry its split's infix, or carries another split's. */
  | "SPLIT_ID_MISMATCH"
  /** No graders at all, so `quality` can never be anything but vacuously true. */
  | "MISSING_GRADER"
  /** `requiredSignals` is empty, so nothing says what a detection on this case would mean. */
  | "NO_REQUIRED_SIGNALS"
  /** A named signal that no grader or metric on this case can ever produce. See the header. */
  | "REQUIRED_SIGNAL_UNGRADED"
  /** A derived case with no attribution, or with empty modifications. */
  | "DERIVED_WITHOUT_ATTRIBUTION"
  /** A `structured_json` case with no schema, or a schema grader on a case with no schema. */
  | "SCHEMA_CASE_WITHOUT_SCHEMA"
  /** The prompt id is not in the registry, so the call cannot be rendered or hashed. */
  | "UNKNOWN_PROMPT_ID"
  /** An empty user prompt. */
  | "EMPTY_PROMPT"
  /** `schemaVersion` is not 1. */
  | "BAD_SCHEMA_VERSION"
  /** The corpus does not span the measured noise regimes. Corpus-level. See the header. */
  | "ARCHETYPE_SPAN"
  /** Every case declares a detectionLimit, so the corpus claims to measure nothing. */
  | "NO_MEASURABLE_CASES";

export interface CorpusViolation {
  readonly code: CorpusViolationCode;
  readonly caseId?: string;
  readonly message: string;
}

/**
 * Which metrics a given case could actually move.
 *
 * `latencyMs`, `outputTokens` and `costUsd` are always producible: every call is timed and counted.
 * `quality` needs at least one grader. `schemaValid` needs a declared schema. `refusal` is always
 * producible because the lexicon runs on every output.
 */
export function producibleSignals(c: EvalCase): ReadonlySet<MetricKey> {
  const out = new Set<MetricKey>(["latencyMs", "outputTokens", "costUsd", "refusal"]);
  if (c.graders.length > 0) out.add("quality");
  if (c.input.jsonSchema !== undefined) out.add("schemaValid");
  return out;
}

/**
 * Which rules apply.
 *
 * Two of the rules here are properties of the CORPUS rather than of any case, and running them
 * against one split at a time would be wrong rather than merely noisy. The canary split is
 * deliberately all constrained cases, because it is paid for on every tick forever and the
 * reasoning-heavy archetype measured 10 to 18 seconds per call on this machine; asking it to span
 * every noise regime on its own would force the watch to be unaffordable in the name of rigour.
 * So a split is checked case by case, and the span is checked once over the union.
 */
export type CheckScope = "split" | "corpus";

/** Validate a corpus. Pure and synchronous. */
export function checkCorpus(
  cases: readonly EvalCase[],
  scope: CheckScope = "corpus",
): readonly CorpusViolation[] {
  const out: CorpusViolation[] = [];
  const push = (code: CorpusViolationCode, message: string, caseId?: string): void => {
    out.push(caseId === undefined ? { code, message } : { code, caseId, message });
  };

  const seen = new Set<string>();
  for (const c of cases) {
    const id = String(c.id);
    if (seen.has(id)) push("DUPLICATE_ID", "appears more than once", id);
    seen.add(id);

    if (c.schemaVersion !== 1) {
      push("BAD_SCHEMA_VERSION", `schemaVersion is ${String(c.schemaVersion)}, not 1`, id);
    }

    // The id carries the split, so moving a case between splits changes its id and shows up in every
    // diff. Relabelling a case out of a frozen split is the cheapest way to make an instrument agree
    // with the thing it is measuring, and this is what makes that loud.
    const infix = SPLIT_INFIX[c.split];
    if (!id.includes(infix)) {
      push("SPLIT_ID_MISMATCH", `split is "${c.split}" but the id does not contain "${infix}"`, id);
    }
    for (const [split, other] of Object.entries(SPLIT_INFIX)) {
      if (split !== c.split && id.includes(other)) {
        push("SPLIT_ID_MISMATCH", `split is "${c.split}" but the id contains "${other}"`, id);
      }
    }

    if (c.input.user.trim() === "") push("EMPTY_PROMPT", "the user prompt is empty", id);
    if (!REGISTRY.has(String(c.promptId))) {
      push("UNKNOWN_PROMPT_ID", `prompt "${String(c.promptId)}" is not in the registry`, id);
    }

    if (c.graders.length === 0) {
      push(
        "MISSING_GRADER",
        "has no graders, so its quality metric is vacuously true and can never move",
        id,
      );
    }
    if (c.requiredSignals.length === 0) {
      push(
        "NO_REQUIRED_SIGNALS",
        "names no required signal, so nothing states what a detection here would mean",
        id,
      );
    }

    const producible = producibleSignals(c);
    for (const signal of c.requiredSignals) {
      if (!producible.has(signal)) {
        push(
          "REQUIRED_SIGNAL_UNGRADED",
          `requires "${signal}" to move, but nothing on this case can produce it`,
          id,
        );
      }
    }

    if (c.archetype === "structured_json" && c.input.jsonSchema === undefined) {
      push("SCHEMA_CASE_WITHOUT_SCHEMA", "is structured_json but declares no jsonSchema", id);
    }
    if (c.graders.some((g) => g.kind === "jsonSchema") && c.input.jsonSchema === undefined) {
      push("SCHEMA_CASE_WITHOUT_SCHEMA", "has a jsonSchema grader but declares no jsonSchema", id);
    }

    if (c.provenance.kind === "derived" && c.provenance.modifications.trim() === "") {
      push(
        "DERIVED_WITHOUT_ATTRIBUTION",
        "is derived but says nothing about what was changed; a silent adaptation is not attribution",
        id,
      );
    }
  }

  if (scope === "corpus" && cases.length > 0) {
    const present = new Set<Archetype>(cases.map((c) => c.archetype));
    const missing = ALL_ARCHETYPES.filter((a) => !present.has(a));
    if (missing.length > 0) {
      push(
        "ARCHETYPE_SPAN",
        `the corpus does not span the measured noise regimes: no ${missing.join(", ")} case. A corpus of one archetype measures one noise floor and generalizes to nothing.`,
      );
    }
    if (cases.every((c) => c.detectionLimit !== null)) {
      push(
        "NO_MEASURABLE_CASES",
        "every case declares a detectionLimit, so the corpus claims to detect nothing at all",
      );
    }
  }

  return out;
}

export const formatCorpusViolations = (violations: readonly CorpusViolation[]): string =>
  violations
    .map((v) => `  ${v.code}${v.caseId === undefined ? "" : ` [${v.caseId}]`}: ${v.message}`)
    .join("\n");
