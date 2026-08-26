// The markdown report. The document a person reads during an incident, or pastes into a pull
// request, or is shown six weeks later by someone asking why a build went red.
//
// THE ORDER OF THIS DOCUMENT IS THE ARGUMENT IT MAKES. Verdict first, then what the verdict does
// and does not mean, then the evidence. A report that opens with a table of p-values makes the
// reader assemble the conclusion themselves, and the conclusion they assemble is usually "a number
// moved, therefore the model changed", which is the exact inference this project exists to refuse.
//
// THE SECOND SECTION IS THE POINT OF THE WHOLE PACKAGE. "What this verdict does and does not mean"
// is GENERATED FROM THE VERDICT AND ITS NUMBERS, never printed from a template. A fixed paragraph
// would say the same thing about an INCONCLUSIVE run at 4 replicates and at 40, and the whole
// difference between those two runs lives in that paragraph. So NO_DRIFT prints the minimum
// detectable effect that "nothing" was measured against, INCONCLUSIVE prints the rule-of-three
// ceiling and the replicate count that would fix it, SUSPECTED_DRIFT prints the command that
// collects a confirmation arm, and CONFIRMED_DRIFT names what reproduced and on which arm.
//
// PROSE IS WRITTEN AS SENTENCES AND FILLED HERE, by `para`, rather than hand-broken into lines. A
// paragraph containing an interpolated number cannot be hand-broken correctly, because the number's
// width is not known until it is rendered, and the result is a ragged raw document that looks like
// nobody read it. Filling also means a sentence can be edited without re-counting columns, which is
// the only reason hand-broken prose ever goes stale.
//
// WHAT WAS REJECTED. An executive summary at the top that restates the verdict in softer words: two
// statements of the same finding drift apart under editing and the softer one is the one that gets
// quoted. A "risk score" or a letter grade: this package has four verdicts with stated meanings and
// collapsing them onto one axis destroys the distinction between "nothing moved" and "we could not
// have seen it move", which is the distinction the detector was built around. Colour or emoji
// status markers: the same bytes have to survive a terminal, a CI log, a file and a diff.
//
// WHAT THIS IS NOT. It is not a decision. `exitCodeFor` and `gatesFor` decide; this renders. It
// does not compute statistics, does not re-grade anything, and derives no number that
// `@model-regression-sentinel/detect` did not already put in the CompareResult.

import {
  type CompareResult,
  MIN_N_FOR_RATE,
  type MetricFinding,
  exitCodeFor,
  ruleOfThree,
} from "@model-regression-sentinel/detect";
import { undisclosedFields } from "@model-regression-sentinel/run";
import {
  CONSEQUENCE,
  DEFAULT_CONFIRM_COMMAND,
  type ReportContext,
  asP,
  asPercent,
  asPoints,
  asPointsMagnitude,
  asRelative,
  belowRateFloor,
  describeTest,
  drawsBehind,
  effectOf,
  findingVerdict,
  gatingLabel,
  intervalOf,
  levelOf,
  markdownTable,
  metricLabel,
  noiseFloorOf,
  wrap,
} from "./format.js";

/** Options are context, not configuration. Every field is optional and none of them changes a verdict. */
export type MarkdownOptions = ReportContext;

/** The column the raw document fills to. Rendered markdown reflows; the raw file is what gets diffed. */
const MD_WIDTH = 100;

/** One filled paragraph, followed by the blank line that ends it. */
const para = (text: string): readonly string[] => [...wrap(text, MD_WIDTH, ""), ""];

/**
 * One filled block quote, used for the sentence that must not be misread.
 *
 * Paragraphs are separated by a bare `>` rather than by a blank line, because a blank line ends the
 * quote and turns one emphatic block into two adjacent ones.
 */
const quote = (...paragraphs: readonly string[]): readonly string[] => {
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (out.length > 0) out.push(">");
    out.push(...wrap(paragraph, MD_WIDTH, "> "));
  }
  out.push("");
  return out;
};

/** One list item, filled, with the continuation lines hanging under the text rather than the dash. */
const bullet = (text: string): readonly string[] =>
  wrap(text, MD_WIDTH - 2, "").map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`));

export function renderMarkdown(result: CompareResult, options: MarkdownOptions = {}): string {
  const lines: string[] = [];
  const push = (...text: readonly string[]): void => {
    for (const t of text) lines.push(t);
  };

  push(`# Drift report: ${result.candidateLabel} against ${result.baselineLabel}`, "");

  // 1. the verdict and its consequence, then the detector's own sentence, unedited.
  push("## Verdict", "");
  push(...para(`**${result.verdict}** - ${CONSEQUENCE[result.verdict]}`));
  push(
    ...para(
      `Exit code **${exitCodeFor(result, "confirmed")}** under the default \`confirmed\` gate, and **${exitCodeFor(result, "suspected")}** under the opt-in \`suspected\` gate.`,
    ),
  );
  push(...para(result.reason));

  // 2. the section this package exists for.
  push("## What this verdict does and does not mean", "");
  push(...meaningBlock(result, options));

  push("## Provider identity", "");
  push(...identitySection(result, options));

  push("## Metrics", "");
  push(...metricsSection(result));

  push("## The two nulls, and why there are two", "");
  push(...nullsSection(result));

  push("## Power: what this suite could have seen", "");
  push(...powerSection(result));

  push("## Per-case triage", "");
  push(...perCaseSection(result));

  push("## Provenance", "");
  push(...provenanceSection(result, options));

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

// ---- 2. what the verdict does and does not mean ----------------------------------------------------

interface Ceiling {
  readonly value: number;
  readonly replicates: number;
  /** Whether the number came from a simulated MDE or was recomputed from the replicate count. */
  readonly source: "mde" | "replicates";
}

/**
 * The rule-of-three ceiling, preferring the one the MDE simulation already computed.
 *
 * A CompareResult can be a shell with no findings at all - a corpus mismatch, or fewer than two
 * replicates - and the ceiling is exactly the number that reader most needs. So it is recomputed
 * from the replicate count in that case, and the report says which of the two it printed.
 */
function ceilingOf(result: CompareResult): Ceiling {
  for (const finding of result.findings) {
    const mde = finding.mde;
    if (mde !== null) {
      return { value: mde.allPassCeiling, replicates: mde.replicates, source: "mde" };
    }
  }
  const n = Math.min(result.replicates.baseline, result.replicates.candidate);
  return { value: ruleOfThree(n), replicates: n, source: "replicates" };
}

const ceilingProvenance = (ceiling: Ceiling): string =>
  ceiling.source === "mde"
    ? "from the power simulation on this run"
    : "recomputed from the replicate count, because no power simulation ran on this comparison";

/** The replicate counts a named target effect would need, one bullet per metric that computed one. */
function targetBullets(result: CompareResult): readonly string[] {
  const out: string[] = [];
  for (const finding of result.findings) {
    const mde = finding.mde;
    if (mde === null || mde.replicatesForTarget === null) continue;
    out.push(
      ...bullet(
        `\`${finding.metric}\`: reaching a ${asPointsMagnitude(mde.targetEffect ?? Number.NaN)} effect at ${asPercent(mde.targetPower)} power needs **${mde.replicatesForTarget} replicates per arm**, against ${mde.replicates} collected here.`,
      ),
    );
  }
  return out;
}

function meaningBlock(result: CompareResult, options: ReportContext): readonly string[] {
  const ceiling = ceilingOf(result);
  const out: string[] = [];

  if (result.verdict === "NO_DRIFT") {
    out.push(
      ...para(
        "**What this means.** Two things at once, and this verdict requires both. No gating metric moved beyond the permutation null or beyond this provider's own measured noise floor, AND the suite had the power to have seen a movement of the size it went looking for. The second half is the half a raw diff leaves out, so it is printed here rather than left implied.",
      ),
      ...para('What "nothing moved" was measured against:'),
    );
    const rows = result.findings
      .filter((f) => f.gating && f.mde !== null)
      .map((f) => {
        const mde = f.mde;
        if (mde === null) return [f.metric];
        return [
          f.metric,
          mde.mde === null
            ? "no drop on the grid reached the target power"
            : asPointsMagnitude(mde.mde),
          asPercent(mde.power),
          asPercent(mde.targetPower),
        ];
      });
    if (rows.length === 0) {
      out.push(
        ...para(
          "No minimum detectable effect was computed on this run, so this verdict rests on the two nulls alone. Read it as INCONCLUSIVE until an MDE is available.",
        ),
      );
    } else {
      out.push(
        ...markdownTable(
          ["metric", "smallest uniform drop this suite resolves", "power there", "target power"],
          rows,
        ),
        "",
      );
    }
    out.push(
      ...para(
        `**What this does not mean.** It does not mean nothing changed. An effect smaller than the minimum detectable effect above would have been missed, and with every replicate of a case passing, the rule of three still allows a true failure rate as high as **${asPercent(ceiling.value)}** at ${ceiling.replicates} replicates. It also says nothing about behaviour this corpus does not score: a model that got subtly worse at a judgement no deterministic grader can check would produce exactly this report.`,
      ),
    );
    return out;
  }

  if (result.verdict === "INCONCLUSIVE") {
    out.push(
      ...quote(
        "**This is NOT evidence that nothing changed.**",
        "It is a statement about the instrument rather than about the provider. Nothing was found, and at this sample size nothing of the size that matters could have been found. Reading this as a green tick is the single most expensive mistake this report can cause, which is why it is not rendered as one.",
      ),
      ...para(
        `**The rule of three.** With every replicate of a case passing, the largest true failure rate still consistent with the data is **${asPercent(ceiling.value)}** at ${ceiling.replicates} replicates (${ceilingProvenance(ceiling)}). An all-passing arm and a provider that fails nearly a third of the time are consistent with the same observation here. No amount of staring at this run gets under that floor; only replicates do.`,
      ),
    );
    if (result.underpoweredMetrics.length > 0) {
      out.push(
        ...para(
          `**Which metrics were not actually checked:** ${result.underpoweredMetrics.join(", ")}. For each of these the suite could not resolve an effect at this replicate count, so a null result from them carries no information at all. The power section below says which of the two reasons applies to each.`,
        ),
      );
    }
    const targets = targetBullets(result);
    if (targets.length > 0) {
      out.push("**What it would take to answer the question.**", "", ...targets, "");
    } else {
      out.push(
        ...para(
          "**What it would take to answer the question.** No target effect was named on this run, so the required replicate count was not simulated. Pass `targetEffect` to `compare` and it will be.",
        ),
      );
    }
    out.push(
      ...para(
        "**What this does not mean.** It does not mean the tool failed, and it does not mean drift is likely. It means the only honest answer available at this n is that the question was not settled, and the fix is more replicates rather than a softer threshold.",
      ),
    );
    return out;
  }

  if (result.verdict === "SUSPECTED_DRIFT") {
    const command = options.confirmCommand ?? DEFAULT_CONFIRM_COMMAND;
    out.push(
      ...para(
        `**What this means.** ${result.suspectedMetrics.join(", ")} cleared BOTH nulls: the effect is large relative to sampling, and it is also larger than this provider's own measured wobble. That is a finding worth an operator's time.`,
      ),
      ...para(
        "**A single crossing is exactly what noise produces on the run where it happens to.** Any fixed threshold applied on a schedule will eventually fire without a cause, and the first time someone investigates one and finds nothing, the gate loses its credibility. So this verdict does NOT set a non-zero exit code by default, and it is not a regression yet.",
      ),
    );
    if (options.confirmationLabel === undefined) {
      out.push(
        ...para(
          "**No confirmation arm was supplied.** Collect an independent candidate run and pass it as the confirmation arm. Only a finding that reproduces there becomes CONFIRMED_DRIFT, and only that fails a build:",
        ),
        "```sh",
        command,
        "```",
        "",
      );
    } else {
      out.push(
        ...para(
          `**A confirmation arm was collected (\`${options.confirmationLabel}\`) and the finding did not reproduce on it.** That is what a false alarm looks like from the inside. Two independent arms disagreeing is much weaker evidence than one arm crossing a threshold looks, and the correct action is to collect another arm rather than to file a regression on the first.`,
        ),
      );
    }
    out.push(
      ...para(
        "**What this does not mean.** It does not name a cause. A prompt-side change, a corpus edit that left the case ids alone, a provider-side rollout and a genuine weight change all look identical in this table. Check the identity section and the corpus digest before attributing it.",
      ),
    );
    return out;
  }

  if (result.verdict === "CONFIRMED_DRIFT") {
    const arm = options.confirmationLabel ?? "the independent confirmation arm";
    out.push(
      ...para(
        `**What this means.** ${result.confirmedMetrics.join(", ")} moved, cleared both nulls, and then REPRODUCED on \`${arm}\`, a separately collected run. One test at alpha became two, which is a far stronger guard than lowering alpha would have been, and one that can be reasoned about without a statistics textbook. This is the only verdict that fails a build.`,
      ),
      ...para("What reproduced:"),
      ...markdownTable(
        [
          "metric",
          "baseline to candidate",
          "effect",
          "95% CI",
          "permutation p",
          "calibrated p",
          "reproduced on",
        ],
        result.findings
          .filter((f) => f.confirmed)
          .map((f) => [
            f.metric,
            `${levelOf(f, f.baseline)} to ${levelOf(f, f.candidate)}`,
            effectOf(f),
            intervalOf(f),
            asP(f.permutation.p),
            asP(f.calibratedP),
            arm,
          ]),
      ),
      "",
      ...para(
        "**What this does not mean.** It does not name a cause and it does not say the provider shipped a new model. A prompt-template edit, a corpus that is not actually frozen, or a change on the harness side would all reproduce just as reliably, because they are also real and also present on both arms. The identity section and the corpus digest are where to look first. The effect column is a point estimate; the interval beside it is the range the data actually support.",
      ),
    );
    return out;
  }

  out.push(
    ...para(
      "**What this means.** The two runs were collected against DIFFERENT rendered corpora. The digest is taken over the rendered requests, so this also catches a prompt-template edit that left every case id untouched, which is the failure most easily mistaken for drift.",
    ),
    ...para(
      "**This is misuse of the tool rather than a provider change.** No difference between these two runs is attributable to the provider, because the two runs asked different questions. That is why the exit code is 2 and not 1: a regression and a category error should never be handled by the same runbook step.",
    ),
    ...para(
      "**What this does not mean.** It does not mean either run is bad. Re-run both arms against one frozen corpus and the comparison becomes available again. Nothing collected here is wasted, because a snapshot keeps raw outputs and can be re-graded.",
    ),
  );
  return out;
}

// ---- 3. provider identity ---------------------------------------------------------------------------

function identitySection(result: CompareResult, options: ReportContext): readonly string[] {
  const out: string[] = [];
  if (result.identityChanges.length === 0) {
    out.push(
      ...para(
        "The provider fingerprint was **unchanged** between the two arms: every recorded identity field held the same value. That is a useful fact and a weak one. A vendor can serve different weights under an unchanged identity just as easily as it can re-tag identical weights under a new one.",
      ),
    );
  } else {
    out.push(
      ...para(
        "The provider identity **changed**. This is the one finding in this report with no statistics in it at all.",
      ),
      ...markdownTable(
        ["field", "before", "after"],
        result.identityChanges.map((c) => [`\`${c.field}\``, c.before, c.after]),
      ),
      "",
      ...para(
        "**An identity change carries NO p-value, because it is a fact rather than an inference.** It cannot be a false positive and it cannot be tested for significance; the field either moved or it did not.",
      ),
      ...para(
        "**It also does not by itself mean behaviour moved.** A vendor can re-tag identical weights, and an alias can start exposing a dated snapshot id that was always what it served. So this is reported in its own category and never as a regression on its own. What it does do is raise the priority of any behavioural finding in the same run: an effect that clears both nulls beside an identity change is a much easier story to tell than either one alone.",
      ),
    );
  }

  const fingerprint = options.candidateFingerprint;
  if (fingerprint !== undefined) {
    const undisclosed = undisclosedFields(fingerprint);
    out.push(
      ...para(
        undisclosed.length === 0
          ? "Every fingerprint field was disclosed by this provider, so an unchanged field here really is an unchanged field."
          : `Fields this provider declined to expose: ${undisclosed.map((f) => `\`${f}\``).join(", ")}. An undisclosed field cannot be observed to change, so its stability above is an absence of evidence rather than evidence of stability.`,
      ),
    );
  }
  return out;
}

// ---- 4. metrics -------------------------------------------------------------------------------------

function metricsSection(result: CompareResult): readonly string[] {
  if (result.findings.length === 0) {
    return para(
      "No metric was analysed on this comparison. The verdict above says why, and it is not a metric result: nothing was measured, so nothing is tabulated.",
    );
  }

  const replicates = Math.min(result.replicates.baseline, result.replicates.candidate);
  const floored = result.findings.filter((f) => belowRateFloor(f, replicates));
  const rows = result.findings.map((f) => {
    const mark = belowRateFloor(f, replicates) ? " *" : "";
    return [
      metricLabel(f),
      gatingLabel(f),
      `${levelOf(f, f.baseline)}${mark}`,
      `${levelOf(f, f.candidate)}${mark}`,
      effectOf(f),
      intervalOf(f),
      asP(f.permutation.p),
      asP(f.calibratedP),
      findingVerdict(f),
    ];
  });

  const out: string[] = [
    ...markdownTable(
      [
        "metric",
        "gating",
        "baseline",
        "candidate",
        "effect",
        "95% CI",
        "permutation p",
        "calibrated p",
        "verdict",
      ],
      rows,
    ),
    "",
    ...para(
      "Only a **GATING** metric can set a non-zero exit code. `latencyMs` and `costUsd` are marked `(observational)` on their own row, and they are excluded on measured grounds rather than as a preference: in a pilot of eight replicates of one free-form case, one latency sample in eight came in at 3.57 times the median, and cost is very nearly a deterministic function of the token counts and a rate card that a vendor can reprice without touching a model.",
    ),
    ...para(
      "Binary metrics are rates, so their levels are percentages and their effects are percentage POINTS. Continuous metrics are compared in RELATIVE terms, as a fraction of each case's own baseline: on this corpus one case averages about 76 output tokens and another about 1190, and an unweighted mean of raw differences across those is a statistic about the second case wearing the name of the suite.",
    ),
  ];

  if (floored.length > 0) {
    const counts = floored
      .map((f) => `\`${f.metric}\` at ${drawsBehind(f, replicates)}`)
      .join(", ");
    out.push(
      ...para(
        `\\* rests on fewer than ${MIN_N_FOR_RATE} draws (${counts}), which is this project's reporting floor for a percentage. The rate is printed so the row is not blank, and it is a fraction whose denominator is too small to read as one.`,
      ),
    );
  }

  out.push(
    ...para("How each p was computed, and what the second null was measured to be:"),
    ...markdownTable(
      [
        "metric",
        "permutation null",
        "measured noise floor (95th pct of A/A)",
        "errored calls dropped",
      ],
      result.findings.map((f) => [
        f.metric,
        describeTest(f),
        noiseFloorOf(f),
        String(f.errorCount),
      ]),
    ),
    "",
    ...para(
      "The noise floor for a binary metric is in percentage points and is directly comparable to the effect column. For a continuous metric it is printed in the metric's OWN units, because the A/A calibration is absolute while the effect is relative; the calibrated p is the number that actually compares the two, and the detector recomputes it on relative differences for exactly this reason.",
    ),
    ...para(
      "An arm pair with unequal replicate counts makes the sign-flip test APPROXIMATE rather than exact, and the table says `NOT exchangeable` when that is the case, rather than leaving the reader to discover it while arguing with the result. Errored calls are dropped from the samples and counted here: a provider outage is not a quality regression, and scoring it as one would make every network problem look like drift.",
    ),
  );
  return out;
}

// ---- 5. the two nulls -------------------------------------------------------------------------------

function nullsSection(result: CompareResult): readonly string[] {
  const calibration = result.calibration;
  const splits =
    calibration === null
      ? "not available on this run"
      : calibration.usable
        ? `${calibration.splits} splits`
        : "attempted and not usable here, because splitting a baseline against itself needs at least four replicates per case";
  const out: string[] = [
    ...para(
      "The **permutation p** asks whether the effect is large relative to SAMPLING: it flips the signs of the per-case differences, which is exactly the symmetry the no-drift null asserts, and asks how often chance alone produces something this big.",
    ),
    ...para(
      `The **calibrated p** asks a different question entirely: whether the effect is large relative to how much THIS PROVIDER measurably wobbles on its own, measured by splitting the baseline against itself and computing the same suite statistic on each split (${splits}).`,
    ),
    ...para(
      "**A finding must clear both.** When they disagree that is information rather than a problem: a permutation p of 0.01 beside a calibrated p of 0.30 says the effect is real sampling-wise and utterly ordinary for this provider, which is precisely the case where a raw diff declares a regression and is wrong.",
    ),
  ];

  const disagreeing = result.findings.filter((f) => f.significant && f.exceedsNoiseFloor === false);
  if (disagreeing.length > 0) {
    const many = disagreeing.length > 1;
    out.push(
      ...para(
        `On this run the two nulls disagree for ${disagreeing.map((f) => `\`${f.metric}\``).join(", ")}. ${many ? "Each of those" : "It"} cleared the permutation null and did NOT clear this provider's own measured noise floor, so ${many ? "each is reported and none of them is" : "it is reported and it is not"} a finding.`,
      ),
    );
  }
  const uncalibrated = result.findings.filter((f) => f.exceedsNoiseFloor === null);
  if (uncalibrated.length > 0) {
    out.push(
      ...para(
        `The noise floor could not be measured for ${uncalibrated.map((f) => `\`${f.metric}\``).join(", ")}. A null calibration needs at least four replicates per case to split, and \`null\` here means the second null was NOT measured. That is not the same as the effect having failed it, and it never confirms.`,
      ),
    );
  }
  return out;
}

// ---- 6. power ----------------------------------------------------------------------------------------

function powerSection(result: CompareResult): readonly string[] {
  const ceiling = ceilingOf(result);
  const withMde = result.findings.filter((f) => f.mde !== null);
  const out: string[] = [
    ...para(
      `Replicates collected: **${result.replicates.baseline}** on \`${result.baselineLabel}\` and **${result.replicates.candidate}** on \`${result.candidateLabel}\`.`,
    ),
  ];

  if (withMde.length === 0) {
    out.push(
      ...para(
        "No minimum detectable effect was computed on this comparison. Without one, a null result cannot be distinguished from an unlooked-for one, so nothing here should be read as NO_DRIFT.",
      ),
    );
  } else {
    out.push(
      ...markdownTable(
        [
          "metric",
          "cases",
          "replicates",
          "minimum detectable drop",
          "power there",
          "target power",
          "alpha",
          "simulations",
        ],
        withMde.map((f) => {
          const mde = f.mde;
          if (mde === null) return [f.metric];
          return [
            metricLabel(f),
            String(mde.cases),
            String(mde.replicates),
            mde.mde === null ? "**none on the grid**" : asPointsMagnitude(mde.mde),
            asPercent(mde.power),
            asPercent(mde.targetPower),
            mde.alpha.toFixed(3),
            String(mde.simulations),
          ];
        }),
      ),
      "",
      ...para(
        "The minimum detectable effect is SIMULATED from the observed per-case baseline rates at the actual replicate count, running the actual test, rather than read off a closed-form power formula. On a corpus where some cases return identical answers on every draw and others are genuinely ambiguous, a formula fed the average of those variances describes no case in the corpus. Rates are shrunk toward one half by the Jeffreys prior first, so a case observed at 10/10 does not enter the simulation as one that can never fail.",
      ),
    );
  }

  out.push(
    ...para(
      `**The rule-of-three ceiling is ${asPercent(ceiling.value)}** at ${ceiling.replicates} replicates (${ceilingProvenance(ceiling)}). With zero observed failures in n trials the 95 percent upper bound on the true failure rate is about 3/n, and that is the honest floor no amount of staring at an all-green run gets under.`,
    ),
  );

  const targets = targetBullets(result);
  if (targets.length > 0) {
    out.push("Replicates required for the named target effect:", "", ...targets, "");
  }

  // Three different reasons put a metric in `underpoweredMetrics`, and they are not interchangeable.
  // Collapsing them would tell a reader the search grid was exhausted on a metric no simulation has
  // ever covered.
  const underpowered = result.findings.filter((f) => result.underpoweredMetrics.includes(f.metric));
  const noGrid = underpowered.filter((f) => f.mde !== null);
  const continuous = underpowered.filter((f) => f.mde === null && !f.binary);
  const notSimulated = underpowered.filter((f) => f.mde === null && f.binary);
  const names = (findings: readonly MetricFinding[]): string =>
    findings.map((f) => f.metric).join(", ");

  if (noGrid.length > 0) {
    out.push(
      ...para(
        `**Not actually checked, because no effect on the search grid reached the target power at this replicate count:** ${names(noGrid)}. Silence there is silence about the instrument rather than about the provider.`,
      ),
    );
  }
  if (continuous.length > 0) {
    out.push(
      ...para(
        `**Not actually checked, because no minimum detectable effect is simulated for them at all:** ${names(continuous)}. The power simulator draws from per-case pass RATES, so it covers binary metrics only; a continuous gating metric therefore appears here whenever it did not move, and its null result should be read as unproven rather than as clean.`,
      ),
    );
  }
  if (notSimulated.length > 0) {
    out.push(
      ...para(
        `**Not actually checked, because the power simulation was declined on this comparison:** ${names(notSimulated)}. These are binary metrics an MDE could have been computed for. It was not run here, so nothing at all is known about what this suite could have seen on them.`,
      ),
    );
  }
  return out;
}

// ---- 7. per-case triage --------------------------------------------------------------------------------

function perCaseSection(result: CompareResult): readonly string[] {
  const rows: string[][] = [];
  for (const finding of result.findings) {
    for (const c of finding.perCase) {
      if (!c.flagged) continue;
      rows.push([
        `\`${c.caseId}\``,
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
      ? [
          ...para(
            "No case survived Benjamini-Hochberg screening at the configured q, so there is nothing to triage.",
          ),
        ]
      : [...markdownTable(["case", "metric", "baseline", "candidate", "delta", "p"], rows), ""];

  out.push(
    ...para(
      `**Per-case results are hypothesis-generating rather than confirmatory at these sample sizes.** With ${result.replicates.baseline} replicates per arm a two-sided Fisher exact test cannot reach significance except at near-total separation: the smallest attainable p on a case is reached only when one arm passes everything and the other fails everything. A case that appears here is a place to look, never a finding, and the confirmatory test is the one run ACROSS cases in the metrics table above.`,
    ),
  );
  return out;
}

// ---- 8. provenance -----------------------------------------------------------------------------------

function provenanceSection(result: CompareResult, options: ReportContext): readonly string[] {
  const calibration = result.calibration;
  const rows: string[][] = [
    ["baseline label", `\`${result.baselineLabel}\``],
    ["baseline captured at", result.baselineCapturedAt],
    ["candidate label", `\`${result.candidateLabel}\``],
    ["candidate captured at", result.candidateCapturedAt],
    ["baseline replicates", String(result.replicates.baseline)],
    ["candidate replicates", String(result.replicates.candidate)],
    ["alpha", result.alpha.toFixed(3)],
    ["A/A calibration splits", calibration === null ? "not run" : String(calibration.splits)],
    [
      "A/A replicates per half",
      calibration === null ? "not run" : String(calibration.replicatesPerHalf),
    ],
    ["A/A cases used", calibration === null ? "not run" : String(calibration.cases)],
  ];
  if (options.corpusDigest !== undefined)
    rows.push(["corpus digest", `\`${options.corpusDigest}\``]);
  if (options.confirmationLabel !== undefined) {
    rows.push(["confirmation arm", `\`${options.confirmationLabel}\``]);
  }

  const out: string[] = [
    ...markdownTable(["field", "value"], rows),
    "",
    ...para(
      "**The A/A null is measured at HALF the replicates and is therefore conservative.** Splitting n replicates in two gives each A/A arm n/2, so the calibration distribution is the distribution of the statistic at half the sample size the real comparison uses. Its quantiles sit wider than the real ones, which biases the calibrated p toward saying no drift. Erring toward silence is the right direction for a tool whose main failure mode is crying wolf, and it is stated here rather than discovered by whoever wonders why the calibrated p is always the larger of the two.",
    ),
  ];

  if (options.stalenessNote !== undefined) {
    out.push(...para(`**Baseline age.** ${options.stalenessNote}`));
  }

  if (options.baselineCost !== undefined || options.candidateCost !== undefined) {
    const costRows: string[][] = [];
    const costRow = (label: string, cost: typeof options.baselineCost): void => {
      if (cost === undefined) return;
      costRows.push([
        label,
        cost.model,
        String(cost.n),
        `$${cost.harnessUsdPerCall.toFixed(6)}`,
        cost.rateUnknown ? "rate card has no entry" : `$${cost.bareApiUsdPerCall.toFixed(6)}`,
        cost.rateCardDate,
      ]);
    };
    costRow(result.baselineLabel, options.baselineCost);
    costRow(result.candidateLabel, options.candidateCost);
    out.push(
      ...para("Cost, as two bounds and never as one number:"),
      ...markdownTable(
        [
          "arm",
          "model",
          "calls",
          "harness measured (upper)",
          "bare API computed (lower)",
          "rate card",
        ],
        costRows,
      ),
      "",
      ...para(
        "The harness figure is MEASURED and includes tokens the harness injects that a bare API integration would never send. The bare-API figure is COMPUTED from a dated rate card and is not a measurement. They are reported separately because on this machine the gap between them reached a factor of several hundred on an identical question.",
      ),
    );
  }

  if (options.notes !== undefined && options.notes.length > 0) {
    out.push("Operator notes, carried verbatim and not interpreted:", "");
    for (const note of options.notes) out.push(...bullet(note));
    out.push("");
  }

  return out;
}
