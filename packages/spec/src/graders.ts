// Grading one raw output, deterministically.
//
// THE VERDICT IS ALWAYS RE-DERIVED FROM RAW TEXT, never read back from a stored field. That rule is
// inherited from `toolcall-risk-classifier/src/toolcall_risk/bench/frontier.py`, where the reason is
// spelled out: a stored `predicted_unsafe` is a CACHE OF A PARSE, and a cached parse goes stale the
// moment the parser changes. It did change there, and every refusal was being scored as a confident
// answer until it was found. Re-deriving means a grader fix re-grades every recorded run for free,
// with no new spend, and a stale field can never quietly contradict the reported number.
//
// It is also what makes this project's calibration studies possible at all: the A/A false-positive
// measurement and the injected-drift power curve both re-grade recorded outputs thousands of times.
// If grading were baked in at collection time, the instrument could only ever be measured with a
// credit card.
//
// AN UNPARSEABLE OUTPUT IS WRONG, NOT SKIPPED. A model that emits unusable output three percent of
// the time is three percent wrong, and hiding that behind a retry loop or a skip flatters it. That
// matters more here than in a static eval, because "started emitting unparseable output" IS a drift
// event and a harness that retries it away is a harness that cannot see the thing it watches for.

import { parseJson } from "./canonical.js";
import { validateAgainstSchema } from "./jsonSchema.js";
import { detectRefusal } from "./refusal.js";
import type { EvalCase, Grader, JsonValue } from "./types.js";

/** One grader's verdict, with the observed value, so a failing report explains itself. */
export interface GradeResult {
  readonly grader: Grader["kind"];
  readonly passed: boolean;
  readonly detail: string;
}

/** Everything deterministic that can be said about one raw output. */
export interface GradedOutput {
  /** Every grader passed. The `quality` metric, as a boolean. */
  readonly quality: boolean;
  /** The output parsed and satisfied the case schema. `null` when the case declares no schema. */
  readonly schemaValid: boolean | null;
  readonly refused: boolean;
  readonly results: readonly GradeResult[];
}

const norm = (s: string): string => s.trim();

/** Read a dotted field path out of a parsed object. Returns undefined rather than throwing. */
export function readField(value: JsonValue, field: string): JsonValue | undefined {
  let cursor: JsonValue | undefined = value;
  for (const part of field.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as { readonly [k: string]: JsonValue })[part];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

export function gradeOutput(evalCase: EvalCase, rawText: string): GradedOutput {
  const text = norm(rawText);
  const refusal = detectRefusal(text);
  const parsed = parseJson(text);
  const schema = evalCase.input.jsonSchema;

  let schemaValid: boolean | null = null;
  if (schema !== undefined) {
    schemaValid = parsed.ok ? validateAgainstSchema(parsed.value, schema).valid : false;
  }

  const results = evalCase.graders.map((grader) =>
    runGrader(
      grader,
      text,
      parsed.ok ? parsed.value : undefined,
      schema,
      refusal.refused,
      refusal.marker,
    ),
  );

  return {
    quality: results.length > 0 && results.every((r) => r.passed),
    schemaValid,
    refused: refusal.refused,
    results,
  };
}

function runGrader(
  grader: Grader,
  text: string,
  parsed: JsonValue | undefined,
  schema: JsonValue | undefined,
  refused: boolean,
  marker: string | null,
): GradeResult {
  switch (grader.kind) {
    case "exact": {
      const a = grader.caseSensitive === true ? text : text.toLowerCase();
      const b = grader.caseSensitive === true ? grader.expected : grader.expected.toLowerCase();
      return {
        grader: "exact",
        passed: a === b,
        detail: `saw ${JSON.stringify(text.slice(0, 80))}`,
      };
    }
    case "oneOf": {
      const a = grader.caseSensitive === true ? text : text.toLowerCase();
      const options = grader.expected.map((e) =>
        grader.caseSensitive === true ? e : e.toLowerCase(),
      );
      return {
        grader: "oneOf",
        passed: options.includes(a),
        detail: `saw ${JSON.stringify(text.slice(0, 80))}, wanted one of ${grader.expected.join(", ")}`,
      };
    }
    case "regex": {
      const re = new RegExp(grader.pattern, grader.flags);
      return {
        grader: "regex",
        passed: re.test(text),
        detail: `/${grader.pattern}/${grader.flags ?? ""} against ${JSON.stringify(text.slice(0, 80))}`,
      };
    }
    case "jsonSchema": {
      if (schema === undefined) {
        return { grader: "jsonSchema", passed: false, detail: "the case declares no schema" };
      }
      if (parsed === undefined) {
        return { grader: "jsonSchema", passed: false, detail: "the output is not JSON" };
      }
      const result = validateAgainstSchema(parsed, schema);
      // `unsupportedKeywords` EXISTS SO A CASE CANNOT QUIETLY RELY ON A KEYWORD THIS DOES NOT
      // IMPLEMENT, and it was computed and then discarded by every caller in the repository. A case
      // using `oneOf`, `allOf`, `$ref`, `const`, `multipleOf`, `uniqueItems` or `format` therefore
      // validated more loosely than its author wrote it, reported `schemaValid: true`, and said so
      // nowhere - on a metric that can fail a build. Surfacing it in `detail` is the minimum: the
      // number is still a pass, and now the pass says what it did not check.
      const caveat =
        result.unsupportedKeywords.length === 0
          ? ""
          : ` (NOT CHECKED: ${result.unsupportedKeywords.join(", ")} - this validator implements a documented subset, so this case is validated more loosely than it is written)`;
      return {
        grader: "jsonSchema",
        passed: result.valid,
        detail: result.valid
          ? `valid${caveat}`
          : `${result.errors.map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ")}${caveat}`,
      };
    }
    case "numericTolerance": {
      if (parsed === undefined) {
        return { grader: "numericTolerance", passed: false, detail: "the output is not JSON" };
      }
      const found = readField(parsed, grader.field);
      if (typeof found !== "number") {
        return {
          grader: "numericTolerance",
          passed: false,
          detail: `${grader.field} is ${found === undefined ? "absent" : typeof found}, not a number`,
        };
      }
      const delta = Math.abs(found - grader.expected);
      return {
        grader: "numericTolerance",
        passed: delta <= grader.tolerance,
        detail: `${grader.field}=${found}, wanted ${grader.expected} +/- ${grader.tolerance}`,
      };
    }
    case "nonRefusal":
      return {
        grader: "nonRefusal",
        passed: !refused,
        detail: refused ? `refusal marker "${String(marker)}"` : "answered",
      };
  }
}
