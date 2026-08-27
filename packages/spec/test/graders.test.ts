// Grading, and the inherited bug that shaped it.
//
// The substring test is the one to read. The sibling's v0.1 parser tested `"SAFE" in upper` and
// therefore matched SAFETY, so every refusal beginning "I cannot evaluate the safety of this tool
// call" was scored as a confident SAFE verdict. Its audit found 55 of them in a 494-call run. The
// rule that came out of it is implemented here and pinned below: match on word boundaries, and
// treat a refusal that arrives BEFORE any answer as a refusal whatever follows it.

import { describe, expect, it } from "vitest";
import { gradeOutput, readField } from "../src/graders.js";
import { validateAgainstSchema } from "../src/jsonSchema.js";
import { detectRefusal } from "../src/refusal.js";
import type { EvalCase } from "../src/types.js";

const caseWith = (over: Partial<EvalCase>): EvalCase => ({
  schemaVersion: 1,
  id: "tst-c-001" as EvalCase["id"],
  split: "canary",
  archetype: "constrained_categorical",
  title: "t",
  promptId: "terse-v1" as EvalCase["promptId"],
  input: { system: "", user: "u" },
  graders: [{ kind: "exact", expected: "HOLD" }],
  requiredSignals: ["quality"],
  detectionLimit: null,
  provenance: { kind: "original" },
  authoredAt: "2026-08-26",
  note: "n",
  ...over,
});

describe("refusal detection", () => {
  it("fires on an opener", () => {
    expect(detectRefusal("I cannot help with that.").refused).toBe(true);
    expect(detectRefusal("I'm sorry, I can't do that.").refused).toBe(true);
  });

  it("does not fire on a marker buried inside an answer", () => {
    // THE INHERITED BUG, in its modern form. This sentence is an answer, and a detector that fires
    // on it would report a refusal-rate change every time the model became more careful in prose.
    const answer =
      "The main risk is that retrying can double-charge the customer, and I cannot rule that out from the timeout alone.";
    expect(detectRefusal(answer).refused).toBe(false);
  });

  it("does not fire on a marker that is part of a longer word", () => {
    expect(detectRefusal("Nothing in this was an aid to the attacker.").refused).toBe(false);
  });

  it("reports which marker fired, so a report can explain itself", () => {
    const v = detectRefusal("I am unable to answer.");
    expect(v.marker).toBe("i am unable");
    expect(v.index).toBe(0);
  });
});

describe("graders", () => {
  it("exact match is case-insensitive by default and trims", () => {
    expect(gradeOutput(caseWith({}), "  hold  ").quality).toBe(true);
    expect(gradeOutput(caseWith({}), "RETRY").quality).toBe(false);
  });

  it("a refusal is scored as wrong, not skipped", () => {
    // A model that starts declining a prompt it used to answer has drifted, and a harness that
    // retried that away would be blind to one of the clearest drift signals there is.
    const c = caseWith({ graders: [{ kind: "exact", expected: "HOLD" }, { kind: "nonRefusal" }] });
    const graded = gradeOutput(c, "I cannot answer that.");
    expect(graded.quality).toBe(false);
    expect(graded.refused).toBe(true);
  });

  it("an unparseable structured answer is wrong rather than an error", () => {
    const c = caseWith({
      archetype: "structured_json",
      input: {
        system: "",
        user: "u",
        jsonSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
      },
      graders: [{ kind: "jsonSchema" }],
      requiredSignals: ["schemaValid"],
    });
    expect(gradeOutput(c, "here you go: {a: 1}").schemaValid).toBe(false);
    expect(gradeOutput(c, '{"a": 1}').schemaValid).toBe(true);
  });

  it("a case with no graders has vacuously true quality, which is why checkCorpus forbids it", () => {
    expect(gradeOutput(caseWith({ graders: [] }), "anything").quality).toBe(false);
  });

  it("reads a dotted field without throwing on an absent path", () => {
    expect(readField({ a: { b: 2 } }, "a.b")).toBe(2);
    expect(readField({ a: { b: 2 } }, "a.c.d")).toBeUndefined();
    expect(readField(null, "a")).toBeUndefined();
  });

  it("numeric tolerance reports what it saw when the field is the wrong type", () => {
    const c = caseWith({
      input: { system: "", user: "u", jsonSchema: { type: "object" } },
      graders: [{ kind: "numericTolerance", field: "confidence", expected: 0.85, tolerance: 0.1 }],
    });
    expect(gradeOutput(c, '{"confidence": 0.9}').quality).toBe(true);
    expect(gradeOutput(c, '{"confidence": 0.4}').quality).toBe(false);
    expect(gradeOutput(c, '{"confidence": "high"}').results[0]?.detail).toContain("not a number");
  });
});

describe("the JSON Schema subset", () => {
  it("validates the shapes the corpus actually uses", () => {
    const schema = {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["RETRY", "HOLD"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["decision", "confidence"],
      additionalProperties: false,
    };
    expect(validateAgainstSchema({ decision: "HOLD", confidence: 0.9 }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ decision: "MAYBE", confidence: 0.9 }, schema).valid).toBe(false);
    expect(validateAgainstSchema({ decision: "HOLD", confidence: 2 }, schema).valid).toBe(false);
    expect(validateAgainstSchema({ decision: "HOLD" }, schema).valid).toBe(false);
    expect(
      validateAgainstSchema({ decision: "HOLD", confidence: 0.9, extra: 1 }, schema).valid,
    ).toBe(false);
  });

  it("accepts an integer where a number is wanted, and not the reverse", () => {
    expect(validateAgainstSchema(1, { type: "number" }).valid).toBe(true);
    expect(validateAgainstSchema(1.5, { type: "integer" }).valid).toBe(false);
  });

  it("REPORTS the keywords it does not implement rather than ignoring them silently", () => {
    // A case whose meaning depends on a keyword this validator does not understand would otherwise
    // pass for the wrong reason, and `schemaValid` is a gating metric.
    const result = validateAgainstSchema({ a: 1 }, { allOf: [{ type: "object" }], $ref: "#/x" });
    expect(result.unsupportedKeywords).toEqual(["$ref", "allOf"]);
  });

  it("names the path of a nested failure", () => {
    const r = validateAgainstSchema(
      { a: { b: "x" } },
      {
        type: "object",
        properties: { a: { type: "object", properties: { b: { type: "number" } } } },
      },
    );
    expect(r.errors[0]?.path).toBe(".a.b");
  });
});

// THE REFUSAL LEXICON'S TWO FAILURE DIRECTIONS, both of which move a GATING metric.
//
// `nonRefusal` is a grader on all 34 cases, so a mis-scored refusal moves `refusal` AND `quality`.
// Neither of these fires on the recorded runs - across 930 graded records not one marker of any
// kind fires and not one output contains U+2019 - so this pins latent behaviour rather than
// correcting a published number. That is worth saying plainly: the `refusal` metric has never
// observed a positive on real data, and its power figures rest on an all-zero baseline.
describe("the refusal lexicon, in both directions", () => {
  const refused = (text: string): boolean => detectRefusal(text).refused;

  it("is not fooled by a typographic apostrophe", () => {
    // Six of the fourteen markers contain an apostrophe and models emit U+2019 routinely. Without
    // the fold, a provider that changed nothing but its typography would move the refusal rate,
    // and this project would report a font decision as drift.
    expect(refused("I can't help with that.")).toBe(true);
    expect(refused("I can’t help with that.")).toBe(true);
    expect(refused("I won’t do that.")).toBe(true);
    expect(refused("I’m sorry, I cannot do that.")).toBe(true);
  });

  it("does not score an answer as a refusal because of an AI preamble", () => {
    // Defect #1 recurring with a different marker. The sentence-boundary rule cannot help: this
    // marker genuinely opens the sentence, and the sentence then answers the question.
    expect(refused("As an AI, the answer is HOLD.")).toBe(false);
    expect(refused("As an AI language model, the answer is RETRY.")).toBe(false);
  });

  it("still catches a real refusal that arrives behind that preamble", () => {
    // The reason `as an ai` is stripped rather than deleted. After the preamble the real marker
    // follows a comma, which the sentence-boundary rule rejects - so deleting the entry would have
    // traded a false positive for a false negative on a more common phrasing.
    expect(refused("As an AI, I can't help with that.")).toBe(true);
    expect(refused("As an AI language model, I cannot assist.")).toBe(true);
  });

  it("keeps the property the sentence-boundary rule was added for", () => {
    expect(
      refused(
        "The main risk is that retrying can double-charge the customer, and I cannot rule that out from the timeout alone.",
      ),
    ).toBe(false);
    expect(refused("Let me check. I cannot answer that.")).toBe(true);
  });

  it("reports the marker index in the original text, not the stripped one", () => {
    // A report that explains itself has to point at the right place.
    const v = detectRefusal("As an AI, I cannot help.");
    expect(v.refused).toBe(true);
    expect("As an AI, I cannot help.".toLowerCase().slice(v.index)).toMatch(/^i cannot/);
  });
});
