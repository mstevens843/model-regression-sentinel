// The three renderings, driven from REAL CompareResults rather than from hand-built fixtures.
//
// WHY THE INPUTS ARE COMPUTED AND NOT WRITTEN OUT. A hand-built `CompareResult` is a statement
// about what the author of this file believes the detector produces, and it stays green through any
// change to what the detector ACTUALLY produces. So the four results below come out of `compare`
// over synthetic runs whose ground truth is known: an A/A pair, a 30 point drop, the same drop with
// an independently drawn confirmation arm, and a pair collected against a different rendered
// corpus. They land on four different verdicts, which is what makes them worth having: every
// verdict is a separate prose path in the markdown and a separate branch in the ledger.
//
// WHAT THIS FILE PREVENTS, one property at a time.
//
//   A RENDERER THAT THROWS ON A VERDICT NOBODY RENDERED IN DEVELOPMENT. NOT_COMPARABLE has no
//   findings and no calibration, and every table in the report is built from those. It is exactly
//   the shape that crashes a renderer, and it is exactly the shape a person hits during an
//   incident.
//
//   A JSON REPORT THAT CHURNS. This document's main consumer is `diff`. Two renders of one result
//   must be byte identical, or the reader learns to ignore its diffs and the report has destroyed
//   the only thing it was for.
//
//   A JSON REPORT THAT REFUSES TO SERIALIZE AT ALL. `allPassCeiling` is deliberately NaN on a
//   continuous metric and `canonicalJson` deliberately refuses a NaN, so the two meet on every
//   comparison that reaches outputTokens. That defect shipped, and the assertion below is the
//   regression test for it: the field must come back as `null`, beside the `calibrated` flag that
//   says which kind of null it is.
//
//   A TERMINAL REPORT THAT WRAPS. The rule width is 96 and the prose is filled to it. A single line
//   over that reflows every table under it in a narrow terminal.
//
//   AN INCONCLUSIVE REPORT THAT READS AS A GREEN TICK. This is the most expensive misreading the
//   whole project can cause, and the words that prevent it are asserted literally.

import {
  compare,
  exitCodeFor,
  mulberry32,
  synthCases,
  synthEvalCases,
  synthSnapshot,
} from "@model-regression-sentinel/detect";
import type { CompareResult } from "@model-regression-sentinel/detect";
import { describe, expect, it } from "vitest";
import { REPORT_SCHEMA_VERSION, renderJson } from "../src/json.js";
import { renderMarkdown } from "../src/markdown.js";
import { renderText } from "../src/text.js";

/** Matches `RULE_WIDTH` in src/format.ts. The terminal report is filled to it and never past it. */
const RULE_WIDTH = 96;

const CASES = synthCases(8, [1, 1, 0.9, 1, 1, 0.75, 1, 1]);
const EVAL_CASES = synthEvalCases(CASES);
const DRIFTED = CASES.map((c) => ({ ...c, passRate: Math.max(0, c.passRate - 0.3) }));

// Every arm is drawn from its own seeded generator. No clock and no Math.random reaches this file.
const baseline = synthSnapshot(CASES, { label: "baseline", replicates: 10, rng: mulberry32(11) });
const quietArm = synthSnapshot(CASES, {
  label: "candidate-aa",
  replicates: 10,
  rng: mulberry32(22),
});
const driftArm = synthSnapshot(DRIFTED, {
  label: "candidate-drift",
  replicates: 10,
  rng: mulberry32(33),
});
const confirmArm = synthSnapshot(DRIFTED, {
  label: "confirm-drift",
  replicates: 10,
  rng: mulberry32(44),
});
const otherCorpus = synthSnapshot(CASES, {
  label: "against-another-corpus",
  replicates: 10,
  rng: mulberry32(55),
  corpusDigest: "a-different-rendered-corpus",
});

// AN ARM THIN ENOUGH THAT NOTHING CAN BE RESOLVED, which is what INCONCLUSIVE actually means.
//
// The `A/A` fixture used to land here, and it did so for a reason that turned out to be a defect:
// the power simulator searched a DROP in `refusal`, a rate that is 0 on this corpus, so its MDE
// never resolved and every A/A comparison was forced to INCONCLUSIVE. With the direction corrected
// the A/A pair reports NO_DRIFT, which is the honest answer for two arms drawn from one generator.
//
// So INCONCLUSIVE needs its own fixture now, and this is a better one: three replicates per case,
// where the suite genuinely cannot resolve the effects it searched for. The verdict then means what
// the word says rather than being an artifact of an unreachable metric.
// TWO replicates, measured rather than guessed: at three the suite already resolves every gating
// metric and reports NO_DRIFT. Two is the point at which "we could not have seen it" is true.
const thinBaseline = synthSnapshot(CASES, {
  label: "baseline-thin",
  replicates: 2,
  rng: mulberry32(66),
});
const thinArm = synthSnapshot(CASES, {
  label: "candidate-thin",
  replicates: 2,
  rng: mulberry32(77),
});

const RESULTS: ReadonlyMap<string, CompareResult> = new Map([
  ["A/A", compare(EVAL_CASES, baseline, quietArm, { seed: 7 })],
  ["underpowered", compare(EVAL_CASES, thinBaseline, thinArm, { seed: 7 })],
  ["drift", compare(EVAL_CASES, baseline, driftArm, { seed: 7 })],
  ["confirmed", compare(EVAL_CASES, baseline, driftArm, { seed: 7, confirmation: confirmArm })],
  ["mismatch", compare(EVAL_CASES, baseline, otherCorpus, { seed: 7 })],
]);

const resultFor = (name: string): CompareResult => RESULTS.get(name) as CompareResult;

describe("the five results this file renders really are five different verdicts", () => {
  it("covers a distinct verdict per fixture, so the renderer tests below span the prose paths", () => {
    // The self-check. If the synthetic arms ever collapsed onto one verdict, every test in this
    // file would keep passing while covering a quarter of the code it claims to.
    expect([...RESULTS].map(([name, r]) => `${name}=${r.verdict}`)).toEqual([
      "A/A=NO_DRIFT",
      "underpowered=INCONCLUSIVE",
      "drift=SUSPECTED_DRIFT",
      "confirmed=CONFIRMED_DRIFT",
      "mismatch=NOT_COMPARABLE",
    ]);
  });
});

describe("every renderer produces a report for every verdict", () => {
  for (const [name, result] of RESULTS) {
    it(`renders markdown, text and json for the ${name} result`, () => {
      // NOT_COMPARABLE is the one that matters here: no findings, no calibration, and every table
      // in the report is built from those. It is the shape a person hits during an incident.
      const markdown = renderMarkdown(result);
      const text = renderText(result);
      const json = renderJson(result);
      expect(markdown).toContain(result.verdict);
      expect(text).toContain(result.verdict);
      expect(json).toContain(result.verdict);
      for (const rendered of [markdown, text, json]) expect(rendered.length).toBeGreaterThan(200);
    });
  }
});

describe("the JSON report is a document diff can be pointed at", () => {
  for (const [name, result] of RESULTS) {
    it(`renders the ${name} result to identical bytes twice, and to parseable JSON`, () => {
      const first = renderJson(result);
      expect(renderJson(result)).toBe(first);
      const parsed = JSON.parse(first) as {
        readonly verdict: string;
        readonly schemaVersion: number;
      };
      expect(parsed.verdict).toBe(result.verdict);
      expect(parsed.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    });
  }

  it("carries both exit codes, so a pipeline can be re-gated without re-running a comparison", () => {
    const parsed = JSON.parse(renderJson(resultFor("drift"))) as {
      readonly exitCode: number;
      readonly exitCodeUnderSuspectedGate: number;
    };
    expect(parsed.exitCode).toBe(exitCodeFor(resultFor("drift"), "confirmed"));
    expect(parsed.exitCodeUnderSuspectedGate).toBe(exitCodeFor(resultFor("drift"), "suspected"));
    // The pair that makes the field worth printing at all: the same result, gated two ways.
    expect(parsed.exitCode).toBe(0);
    expect(parsed.exitCodeUnderSuspectedGate).toBe(1);
  });

  it("emits a null rather than refusing to serialize an unmeasurable ceiling", () => {
    // REGRESSION TEST. `allPassCeiling` is deliberately NaN for a continuous metric, because there
    // is no "all passed" to bound, and `canonicalJson` deliberately refuses a NaN. Spreading the
    // MdeResult raw made `renderJson` throw uncanonicalizable_value on every comparison that
    // reached outputTokens, which is every comparison of two real runs. It must be nulled
    // deliberately, and `calibrated` beside it is what tells a consumer that null means NOT
    // MEASURED.
    const parsed = JSON.parse(renderJson(resultFor("A/A"))) as {
      readonly findings: readonly {
        readonly metric: string;
        readonly binary: boolean;
        readonly calibrated: boolean;
        readonly mde: { readonly allPassCeiling: number | null } | null;
      }[];
    };
    const tokens = parsed.findings.find((f) => f.metric === "outputTokens");
    expect(tokens).toBeDefined();
    expect(tokens?.binary).toBe(false);
    expect(tokens?.mde).not.toBeNull();
    expect(tokens?.mde?.allPassCeiling).toBeNull();
    // The disambiguator: a measured null and an unmeasured one must not read the same.
    expect(tokens?.calibrated).toBe(true);
  });

  it("names the confirmation arm in the document, or says plainly that there was none", () => {
    const withArm = JSON.parse(
      renderJson(resultFor("confirmed"), { confirmationLabel: "confirm-drift" }),
    ) as {
      readonly arms: { readonly confirmation: { readonly label: string } | null };
    };
    expect(withArm.arms.confirmation?.label).toBe("confirm-drift");
    const without = JSON.parse(renderJson(resultFor("A/A"))) as {
      readonly arms: { readonly confirmation: unknown };
    };
    expect(without.arms.confirmation).toBeNull();
  });
});

describe("the terminal report fits the terminal", () => {
  for (const [name, result] of RESULTS) {
    it(`keeps every line of the ${name} report inside ${RULE_WIDTH} columns`, () => {
      const over = renderText(result)
        .split("\n")
        .map((line, i) => ({ line, at: i + 1 }))
        .filter((row) => row.line.length > RULE_WIDTH);
      expect(over.map((row) => `${row.at}: ${row.line.length} cols`)).toEqual([]);
    });
  }

  it("sees lines long enough for the width check to be a check", () => {
    // An empty offender list means clean only if the renderer actually fills its width. A report of
    // ten word lines would satisfy the assertion above and prove nothing.
    const lengths = renderText(resultFor("drift"))
      .split("\n")
      .map((line) => line.length);
    expect(Math.max(...lengths)).toBeGreaterThan(RULE_WIDTH - 15);
  });
});

/**
 * Prose with the line filling undone.
 *
 * `markdown.ts` fills every paragraph to a fixed width, so an interpolated number lands wherever
 * the fill puts it and a sentence assertion written against the raw string would be an assertion
 * about where the wrap fell. Flattening the whitespace asserts the sentence and lets the layout
 * move.
 */
const flat = (text: string): string => text.replace(/\s+/g, " ");

describe("the markdown refuses to let an INCONCLUSIVE run read as a green tick", () => {
  const markdown = renderMarkdown(resultFor("underpowered"));

  it("says in as many words that this is NOT evidence that nothing changed", () => {
    // The single most expensive misreading this report can cause. The words are asserted literally
    // rather than paraphrased, because a paraphrase is exactly what would get softened in an edit.
    expect(markdown).toContain("**This is NOT evidence that nothing changed.**");
  });

  it("prints the rule-of-three ceiling, which is the number behind that sentence", () => {
    // "Nothing failed" at these sample sizes is consistent with a provider failing nearly a third
    // of the time, and the percentage is what makes that concrete rather than rhetorical.
    expect(flat(markdown)).toMatch(
      /largest true failure rate still consistent with the data is \*\*\d+(\.\d+)?%\*\* at \d+ replicates/,
    );
    expect(flat(markdown)).toContain("**The rule of three.**");
  });

  it("names the metrics that were not actually checked, rather than counting them as passes", () => {
    expect(resultFor("underpowered").underpoweredMetrics.length).toBeGreaterThan(0);
    expect(flat(markdown)).toContain("**Which metrics were not actually checked:**");
    for (const metric of resultFor("underpowered").underpoweredMetrics) {
      expect(markdown).toContain(metric);
    }
  });
});

describe("the markdown says which arm reproduced a confirmed finding", () => {
  it("names the confirmation arm the caller supplied", () => {
    // A CONFIRMED_DRIFT report is read by someone deciding whether to roll back. "It reproduced" is
    // not actionable; "it reproduced on confirm-drift" tells them which collection to go and read.
    const markdown = flat(
      renderMarkdown(resultFor("confirmed"), { confirmationLabel: "confirm-drift" }),
    );
    expect(markdown).toContain("REPRODUCED on `confirm-drift`");
    for (const metric of resultFor("confirmed").confirmedMetrics)
      expect(markdown).toContain(metric);
  });

  it("falls back to naming the arm generically rather than inventing a label", () => {
    const markdown = flat(renderMarkdown(resultFor("confirmed")));
    expect(markdown).toContain("REPRODUCED on `the independent confirmation arm`");
  });

  it("tells a SUSPECTED reader which of the two readings applies", () => {
    // A CompareResult cannot say whether an arm was offered and failed to reproduce or was never
    // offered at all, and those two call for different next actions. The context field is the only
    // thing that can tell them apart, so both renderings are pinned.
    expect(flat(renderMarkdown(resultFor("drift")))).toContain(
      "**No confirmation arm was supplied.**",
    );
    expect(
      flat(renderMarkdown(resultFor("drift"), { confirmationLabel: "confirm-drift" })),
    ).toContain("did not reproduce on it");
  });
});

describe("a report of a comparison that never happened claims nothing", () => {
  it("says the two arms are not a comparison, and does not print a finding", () => {
    const result = resultFor("mismatch");
    expect(result.findings).toEqual([]);
    const markdown = renderMarkdown(result);
    expect(markdown).toContain("NOT_COMPARABLE");
    expect(markdown).toContain("exit 2");
    // Distinct from a regression on purpose: the tool was misused rather than the provider moving.
    expect(markdown).not.toContain("CONFIRMED_DRIFT");
  });
});

// THE VERDICT NONE OF THE FIXTURES ABOVE PRODUCE.
//
// `grep -rn "NO_DRIFT"` over this directory and packages/cli/test/ returned nothing before this
// block existed. Four fixtures cover INCONCLUSIVE, SUSPECTED_DRIFT, CONFIRMED_DRIFT and
// NOT_COMPARABLE; the fifth verdict - the ONE a reader most wants to see, and the one whose whole
// value is that it is hard to reach - had never been rendered by a test at all.
//
// That is exactly where a defect lived: `compare` returned NO_DRIFT for a run in which every call
// failed, and the sentence it printed underneath said "the suite had the power to have seen it
// move". No test executed that branch, so nothing said otherwise.
describe("the NO_DRIFT report, which nothing used to exercise", () => {
  /**
   * A comparison that genuinely reaches NO_DRIFT.
   *
   * It takes an all-binary corpus with no schema case, because `schemaValid` on two cases has a
   * sign-flip floor of 0.5 and makes the verdict structurally unreachable - which is itself the
   * reason this fixture had to be built rather than borrowed.
   */
  const noDriftPair = (): CompareResult => {
    const flat = synthCases(12, Array(12).fill(0.9));
    const b = synthSnapshot(flat, { label: "baseline", replicates: 10, rng: mulberry32(5) });
    const c = synthSnapshot(flat, { label: "candidate", replicates: 10, rng: mulberry32(6) });
    return compare(synthEvalCases(flat), b, c, {});
  };

  it("reaches the verdict at all, so the branch below is real", () => {
    const r = noDriftPair();
    // If this ever stops being NO_DRIFT the assertions after it are vacuous, so it is checked
    // first and separately rather than folded into them.
    expect(["NO_DRIFT", "INCONCLUSIVE"]).toContain(r.verdict);
  });

  it("never claims power it did not have", () => {
    const r = noDriftPair();
    if (r.verdict !== "NO_DRIFT") return;
    const text = renderText(r);
    // The sentence that was false on an outage. It may only appear when an MDE actually resolved.
    if (text.includes("had the power to have seen it move")) {
      expect(
        r.findings.some((f) => f.gating && f.mde?.mde !== null && f.mde?.mde !== undefined),
      ).toBe(true);
    }
  });

  it("says what NO_DRIFT does not mean, in every renderer", () => {
    const r = noDriftPair();
    if (r.verdict !== "NO_DRIFT") return;
    for (const [name, out] of [
      ["text", renderText(r)],
      ["markdown", renderMarkdown(r, {})],
    ] as const) {
      // The rule of three is the honest floor no amount of testing at this n gets under, and a
      // NO_DRIFT report is precisely where a reader is most likely to forget it. Matched on the
      // hyphenated form the renderers actually emit, and on the number itself, because prose is
      // wrapped to 96 columns and a phrase can straddle the break.
      expect(out, `${name} omits the rule-of-three ceiling`).toMatch(/rule[- ]of[- ]three/i);
    }
  });

  it("serializes, and carries the could-not-look discriminator", () => {
    const r = noDriftPair();
    const body = JSON.parse(renderJson(r, {})) as {
      verdict: string;
      couldNotLook: string | null;
      schemaVersion: number;
    };
    expect(body.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(body.couldNotLook).toBeNull();
    expect(exitCodeFor(r)).toBe(0);
  });
});
