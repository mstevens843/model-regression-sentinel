// The terminal form. What a person sees when a comparison finishes, before they decide whether to
// open anything else.
//
// THE CONSTRAINT IS THE POINT: 96 columns, aligned columns, no colour, no dependency, matching
// `formatCalibration` in packages/detect/src/run.ts. Colour is rejected on the same grounds as in
// the release report it is modelled on: this text is read in a terminal, in a CI log, in a file and
// inside a diff, and it has to be the same bytes in all four. An escape sequence that renders as a
// green PASS in one of those places renders as noise in the other three, and the one that matters
// most is the CI log nobody is watching live.
//
// IT LEADS WITH THE VERDICT AND ITS CONSEQUENCE, then the two or three sentences that say what the
// verdict does and does not mean, and only then the tables. Ordering the evidence first would make
// the reader assemble a conclusion out of p-values, and the conclusion people assemble that way is
// "a number moved, so the model changed".
//
// IT IS A SUMMARY AND SAYS SO. The wide table with every interval, every method and every footnote
// is `renderMarkdown`; a 96-column form that tried to carry all of it would carry none of it
// legibly. So the metrics table is split in two rather than truncated - a truncated interval is a
// wrong interval - and the last line names the fuller document.
//
// WHAT WAS REJECTED. A one-line summary suitable for a status bar: the shortest honest statement
// this project can make about a comparison is two sentences, because "nothing moved" and "we could
// have seen it move" are separate claims and dropping the second is what a diff already does.
// Right-aligned numeric columns everywhere: a percentage and a percentage-point figure sitting in
// one column look comparable when they are not, so units are printed in the cell.

import type { CompareResult, MetricFinding } from "@model-regression-sentinel/detect";
import { exitCodeFor, ruleOfThree } from "@model-regression-sentinel/detect";
import {
  CONSEQUENCE,
  DEFAULT_CONFIRM_COMMAND,
  HEAVY_RULE,
  RULE,
  RULE_WIDTH,
  asP,
  asPercent,
  asPoints,
  asPointsMagnitude,
  asRelative,
  describeTest,
  effectOf,
  findingVerdict,
  gatingLabel,
  intervalOf,
  levelOf,
  noiseFloorOf,
  pad,
  renderTable,
  wrap,
} from "./format.js";

export function renderText(result: CompareResult): string {
  const lines: string[] = [];
  const section = (title: string): void => {
    lines.push("", RULE, title, RULE);
  };

  lines.push(HEAVY_RULE);
  lines.push(`DRIFT REPORT   ${result.candidateLabel} against ${result.baselineLabel}`);
  lines.push(HEAVY_RULE);
  lines.push(`  ${pad("VERDICT", 10)}${result.verdict}`);
  lines.push(
    `  ${pad("EXIT", 10)}${exitCodeFor(result, "confirmed")} (default gate)   ${exitCodeFor(result, "suspected")} (gate=suspected)`,
  );
  lines.push(...wrap(CONSEQUENCE[result.verdict], RULE_WIDTH, "  "));
  lines.push("");
  lines.push(...wrap(result.reason, RULE_WIDTH, "  "));
  lines.push("");
  for (const line of meaningLines(result)) lines.push(...wrap(line, RULE_WIDTH, "  "));

  section("identity");
  lines.push(...identityLines(result));

  section("metrics");
  lines.push(...metricLines(result));

  section("the two nulls");
  lines.push(
    ...wrap(
      "The permutation p asks whether the effect is large relative to SAMPLING. The calibrated p asks whether it is large relative to how much THIS PROVIDER measurably wobbles on its own, measured by splitting the baseline against itself.",
      RULE_WIDTH,
      "  ",
    ),
    ...wrap(
      "A finding must clear BOTH. When they disagree that is information rather than a problem: a permutation p of 0.01 beside a calibrated p of 0.30 says the effect is real sampling-wise and utterly ordinary for this provider.",
      RULE_WIDTH,
      "  ",
    ),
  );

  section("power");
  lines.push(...powerLines(result));

  section("per-case triage");
  lines.push(...perCaseLines(result));

  section("provenance");
  lines.push(...provenanceLines(result));

  lines.push("", RULE);
  lines.push(
    ...wrap(
      "This is the summary form. renderMarkdown carries the full intervals, the test methods, the cost bounds and the prose behind every line above.",
      RULE_WIDTH,
      "  ",
    ),
  );
  return `${lines.join("\n")}\n`;
}

// ---- the verdict block ------------------------------------------------------------------------------

function meaningLines(result: CompareResult): readonly string[] {
  const ceiling = ceilingOf(result);
  if (result.verdict === "NO_DRIFT") {
    const resolvable = result.findings
      .filter((f) => f.gating && f.mde !== null && f.mde.mde !== null)
      .map((f) => `${f.metric} at ${asPointsMagnitude(f.mde?.mde ?? Number.NaN)}`)
      .join(", ");
    return [
      `MEANS: nothing moved AND the suite could have seen it move. Smallest uniform drop resolvable: ${resolvable === "" ? "not computed on this run" : resolvable}.`,
      `DOES NOT MEAN: nothing changed. An effect under that size would have been missed, and the rule of three still allows a true failure rate of ${asPercent(ceiling.value)} at ${ceiling.replicates} replicates.`,
    ];
  }
  if (result.verdict === "INCONCLUSIVE") {
    return [
      "THIS IS NOT EVIDENCE THAT NOTHING CHANGED. It is a statement about the instrument, not about the provider.",
      `RULE OF THREE: with every replicate passing, a true failure rate as high as ${asPercent(ceiling.value)} is still consistent with this run at ${ceiling.replicates} replicates.`,
      ...replicateTargets(result),
      result.underpoweredMetrics.length === 0
        ? "The fix is replicates, not a softer threshold."
        : `NOT ACTUALLY CHECKED: ${result.underpoweredMetrics.join(", ")}. The fix is replicates, not a softer threshold.`,
    ];
  }
  if (result.verdict === "SUSPECTED_DRIFT") {
    return [
      `MEANS: ${result.suspectedMetrics.join(", ")} cleared both nulls on a single comparison.`,
      "A single crossing is exactly what noise produces on the run where it happens to, so this does NOT fail a build.",
      `NEXT: collect an independent candidate run and pass it as the confirmation arm - ${DEFAULT_CONFIRM_COMMAND}`,
    ];
  }
  if (result.verdict === "CONFIRMED_DRIFT") {
    const what = result.findings
      .filter((f) => f.confirmed)
      .map(
        (f) =>
          `${f.metric} ${levelOf(f, f.baseline)} to ${levelOf(f, f.candidate)} (${effectOf(f)})`,
      )
      .join("; ");
    return [
      `REPRODUCED on an independent confirmation arm: ${what}.`,
      "DOES NOT MEAN a new model shipped. A prompt edit, an unfrozen corpus or a harness change would reproduce just as reliably. Check identity and the corpus digest first.",
    ];
  }
  return [
    "MEANS: the two runs were collected against different rendered corpora, so any difference between them is a difference of experiment.",
    "This is misuse of the tool rather than a provider change, which is why the exit code is 2 and not 1. Re-run both arms against one frozen corpus.",
  ];
}

function replicateTargets(result: CompareResult): readonly string[] {
  const out: string[] = [];
  for (const f of result.findings) {
    const mde = f.mde;
    if (mde === null || mde.replicatesForTarget === null) continue;
    out.push(
      `TO ANSWER IT: ${f.metric} needs ${mde.replicatesForTarget} replicates per arm to reach ${asPointsMagnitude(mde.targetEffect ?? Number.NaN)} at ${asPercent(mde.targetPower)} power, against ${mde.replicates} collected.`,
    );
  }
  return out;
}

interface Ceiling {
  readonly value: number;
  readonly replicates: number;
}

function ceilingOf(result: CompareResult): Ceiling {
  for (const finding of result.findings) {
    const mde = finding.mde;
    if (mde !== null) return { value: mde.allPassCeiling, replicates: mde.replicates };
  }
  const n = Math.min(result.replicates.baseline, result.replicates.candidate);
  return { value: ruleOfThree(n), replicates: n };
}

// ---- sections ----------------------------------------------------------------------------------------

function identityLines(result: CompareResult): readonly string[] {
  if (result.identityChanges.length === 0) {
    return wrap(
      "The provider fingerprint was unchanged: no recorded identity field moved. A useful fact and a weak one, since a vendor can serve different weights under an unchanged identity.",
      RULE_WIDTH,
      "  ",
    );
  }
  return [
    ...renderTable(
      [{ header: "field" }, { header: "before" }, { header: "after" }],
      result.identityChanges.map((c) => [c.field, c.before, c.after]),
    ),
    "",
    ...wrap(
      "An identity change carries NO p-value: it is a fact, not an inference, and cannot be a false positive. It also does not by itself mean behaviour moved, because a vendor can re-tag identical weights.",
      RULE_WIDTH,
      "  ",
    ),
  ];
}

function metricLines(result: CompareResult): readonly string[] {
  if (result.findings.length === 0) {
    return wrap(
      "No metric was analysed on this comparison. The verdict above says why.",
      RULE_WIDTH,
      "  ",
    );
  }
  const out: string[] = [
    ...renderTable(
      [
        { header: "metric" },
        { header: "gating" },
        { header: "baseline", align: "right" },
        { header: "candidate", align: "right" },
        { header: "effect", align: "right" },
        { header: "verdict" },
      ],
      result.findings.map((f) => [
        f.metric,
        gatingLabel(f),
        levelOf(f, f.baseline),
        levelOf(f, f.candidate),
        effectOf(f),
        findingVerdict(f),
      ]),
    ),
    "",
    ...renderTable(
      [
        { header: "metric" },
        { header: "95% CI" },
        { header: "perm p", align: "right" },
        { header: "calib p", align: "right" },
        { header: "noise floor", align: "right" },
        { header: "errors", align: "right" },
      ],
      result.findings.map((f) => [
        f.metric,
        intervalOf(f),
        asP(f.permutation.p),
        asP(f.calibratedP),
        noiseFloorOf(f),
        String(f.errorCount),
      ]),
    ),
    "",
  ];
  const approximate = result.findings.filter((f) => !f.permutation.exchangeable);
  out.push(
    ...wrap(
      `Only GATING metrics can set a non-zero exit code; latencyMs and costUsd are observational and excluded on measured grounds. Binary effects are percentage points, continuous effects are relative to each case's own baseline. Permutation null on ${(result.findings[0] as MetricFinding).metric}: ${describeTest(result.findings[0] as MetricFinding)}.`,
      RULE_WIDTH,
      "  ",
    ),
  );
  if (approximate.length > 0) {
    out.push(
      ...wrap(
        `The two arms have unequal replicate counts, so the sign-flip test is APPROXIMATE rather than exact for: ${approximate.map((f) => f.metric).join(", ")}.`,
        RULE_WIDTH,
        "  ",
      ),
    );
  }
  return out;
}

function powerLines(result: CompareResult): readonly string[] {
  const ceiling = ceilingOf(result);
  const withMde = result.findings.filter((f) => f.mde !== null);
  const out: string[] = [
    `  replicates: ${result.replicates.baseline} baseline, ${result.replicates.candidate} candidate`,
  ];
  if (withMde.length === 0) {
    out.push(
      ...wrap(
        "No minimum detectable effect was simulated on this comparison, so no null result here can be read as NO_DRIFT.",
        RULE_WIDTH,
        "  ",
      ),
    );
  } else {
    out.push(
      "",
      ...renderTable(
        [
          { header: "metric" },
          { header: "cases", align: "right" },
          { header: "reps", align: "right" },
          { header: "min detectable drop", align: "right" },
          { header: "power", align: "right" },
          { header: "target", align: "right" },
          { header: "sims", align: "right" },
        ],
        withMde.map((f) => {
          const mde = f.mde;
          if (mde === null) return [f.metric];
          return [
            f.metric,
            String(mde.cases),
            String(mde.replicates),
            mde.mde === null ? "none on the grid" : asPointsMagnitude(mde.mde),
            asPercent(mde.power),
            asPercent(mde.targetPower),
            String(mde.simulations),
          ];
        }),
      ),
      "",
    );
  }
  out.push(
    ...wrap(
      `Rule-of-three ceiling: ${asPercent(ceiling.value)} at ${ceiling.replicates} replicates. With zero observed failures in n trials the 95 percent upper bound on the true failure rate is about 3/n, and that is the floor an all-green run never gets under.`,
      RULE_WIDTH,
      "  ",
    ),
  );
  if (result.underpoweredMetrics.length > 0) {
    out.push(
      ...wrap(
        `NOT ACTUALLY CHECKED: ${result.underpoweredMetrics.join(", ")}. Silence from these is silence about the instrument.`,
        RULE_WIDTH,
        "  ",
      ),
    );
  }
  return out;
}

function perCaseLines(result: CompareResult): readonly string[] {
  const rows: string[][] = [];
  for (const finding of result.findings) {
    for (const c of finding.perCase) {
      if (!c.flagged) continue;
      rows.push([
        c.caseId,
        finding.metric,
        levelOf(finding, c.baseline),
        levelOf(finding, c.candidate),
        finding.binary ? asPoints(c.delta) : asRelative(c.delta),
        asP(c.p),
      ]);
    }
  }
  const out: string[] =
    rows.length === 0
      ? ["  no case survived Benjamini-Hochberg screening at the configured q"]
      : [
          ...renderTable(
            [
              { header: "case" },
              { header: "metric" },
              { header: "baseline", align: "right" },
              { header: "candidate", align: "right" },
              { header: "delta", align: "right" },
              { header: "p", align: "right" },
            ],
            rows,
          ),
        ];
  out.push(
    "",
    ...wrap(
      `Per-case results are hypothesis-generating rather than confirmatory at these sample sizes: with ${result.replicates.baseline} replicates per arm a two-sided Fisher exact test cannot reach significance except at near-total separation. A case here is a place to look, never a finding.`,
      RULE_WIDTH,
      "  ",
    ),
  );
  return out;
}

function provenanceLines(result: CompareResult): readonly string[] {
  const calibration = result.calibration;
  const rows: string[][] = [
    [
      "baseline",
      result.baselineLabel,
      result.baselineCapturedAt,
      String(result.replicates.baseline),
    ],
    [
      "candidate",
      result.candidateLabel,
      result.candidateCapturedAt,
      String(result.replicates.candidate),
    ],
  ];
  return [
    ...renderTable(
      [
        { header: "arm" },
        { header: "label" },
        { header: "captured at" },
        { header: "reps", align: "right" },
      ],
      rows,
    ),
    "",
    calibration === null
      ? "  A/A calibration: not run on this comparison"
      : `  A/A calibration: ${calibration.splits} splits, ${calibration.replicatesPerHalf} replicates per half, ${calibration.cases} cases`,
    `  alpha: ${result.alpha.toFixed(3)}`,
    "",
    ...wrap(
      "The A/A null is measured at HALF the replicates and is therefore conservative: its quantiles sit wider than the real comparison's, which biases the calibrated p toward saying no drift. Erring toward silence is the right direction for a tool whose main failure mode is crying wolf.",
      RULE_WIDTH,
      "  ",
    ),
  ];
}
