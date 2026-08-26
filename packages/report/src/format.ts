// The shared rendering primitives, and the optional context a caller may attach to any renderer.
//
// WHY THIS IS ONE FILE RATHER THAN THREE COPIES. Markdown, terminal text and the exit-code ledger
// all have to turn the same numbers into strings, and a pass rate that reads 93.8% in the markdown
// and 0.938 in the terminal is a pair of reports nobody can hold against each other. The formatting
// decisions are made once, here, and the three renderers differ only in layout and in prose.
//
// THE ONE DECISION WORTH ARGUING ABOUT: A BINARY EFFECT IS PRINTED IN PERCENTAGE POINTS, NEVER IN
// PERCENT. A pass rate falling from 94% to 64% has fallen 30 POINTS and 32 PERCENT. Both numbers
// are correct and they are different claims. Every other quantity this report puts beside an effect
// is already in points - the measured noise floor, the minimum detectable effect, the rule-of-three
// ceiling - so points is what the effect column carries, and the unit is printed in the cell rather
// than in a legend at the bottom that nobody reads.
//
// WHAT WAS REJECTED. `formatInterval` from @model-regression-sentinel/detect is deliberately not
// used for the effect interval. It applies the MIN_N_FOR_RATE floor, and that floor is a statement
// about the number of DRAWS behind a rate; the bootstrap interval here is taken over CASES, so the
// floor would stamp "below the reporting floor" on a perfectly reportable interval and then hide
// the interval itself. MIN_N_FOR_RATE is applied instead where it does belong, to the rate columns,
// which really do rest on a count of draws.
//
// WHAT THIS IS NOT. Not a table library, not a colour library, and not a place for prose. There are
// no dependencies here and no escape sequences: a report piped into a file, into a CI log and into
// `diff` must be the same bytes in all three. Prose belongs to the renderer that owns the section.

import {
  MIN_N_FOR_RATE,
  type MetricFinding,
  type Verdict,
} from "@model-regression-sentinel/detect";
import type { CostBounds, ProviderFingerprint } from "@model-regression-sentinel/run";
import type { MetricKey } from "@model-regression-sentinel/spec";

/** Terminal rule width, matching `formatCalibration` in packages/detect/src/run.ts. */
export const RULE_WIDTH = 96;
export const RULE = "-".repeat(RULE_WIDTH);
export const HEAVY_RULE = "=".repeat(RULE_WIDTH);

/**
 * Extra context a caller may attach to any renderer.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY FIELD IS A TYPE THIS PROJECT ALREADY HAS. This package does not
 * compute staleness, does not read a rate card and does not open a corpus; it prints what it is
 * handed and says where the number came from. Inventing a `Staleness` interface here would create a
 * second definition of a thing `@model-regression-sentinel/spec` already owns, and the second
 * definition is the one that goes stale.
 */
export interface ReportContext {
  /** One sentence about how old the baseline is. Rendered verbatim. Computed by the caller. */
  readonly stalenessNote?: string;
  /** Both bounds, as `summariseCost` produced them. Printed as two rows, never merged into one. */
  readonly baselineCost?: CostBounds;
  readonly candidateCost?: CostBounds;
  /** The digest both arms agreed on, so a report can be tied back to a frozen corpus. */
  readonly corpusDigest?: string;
  /** The identity observed on the candidate arm, so the report can name undisclosed fields. */
  readonly candidateFingerprint?: ProviderFingerprint;
  /**
   * Label of the independent arm a confirmation was collected from.
   *
   * Set it whenever a confirmation arm was passed to `compare`. A CompareResult that found nothing
   * to confirm cannot say whether an arm was offered and failed to reproduce or was never offered
   * at all, and those two readings of SUSPECTED_DRIFT call for different next actions.
   */
  readonly confirmationLabel?: string;
  /** The command that collects a confirmation arm. Named in the SUSPECTED_DRIFT block. */
  readonly confirmCommand?: string;
  /** Operator notes, rendered verbatim as a list. Nothing is inferred from them. */
  readonly notes?: readonly string[];
}

/** The default confirmation instruction, when the caller does not name its own command. */
export const DEFAULT_CONFIRM_COMMAND =
  "sentinel compare --baseline <baseline.json> --candidate <candidate.json> --confirmation <a second, independently collected candidate run>";

/** The consequence of each verdict, stated as the exit code plus the one sentence behind it. */
export const CONSEQUENCE: Readonly<Record<Verdict, string>> = {
  NO_DRIFT: "exit 0. Nothing moved, and the suite had the power to have seen it move.",
  INCONCLUSIVE:
    "exit 0. Nothing was found and nothing could have been found. That is not the same statement as nothing changed.",
  SUSPECTED_DRIFT:
    "exit 0 under the default gate. Reported and not a build failure until it reproduces on an independent arm.",
  CONFIRMED_DRIFT:
    "exit 1. A gating metric cleared both nulls and reproduced on an independently collected run.",
  NOT_COMPARABLE:
    "exit 2. The two arms are not a comparison, so there is no measurement to report. Distinct from a regression on purpose.",
};

// ---- text tables ---------------------------------------------------------------------------------

export const pad = (value: string, width: number): string =>
  value.length >= width ? value : value + " ".repeat(width - value.length);

export const padLeft = (value: string, width: number): string =>
  value.length >= width ? value : " ".repeat(width - value.length) + value;

export interface Column {
  readonly header: string;
  readonly align?: "right";
}

/** Aligned plain text, no colour and no dependency. Hand-rolled, like the ledger it is modelled on. */
export function renderTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  indent = "  ",
): readonly string[] {
  const widths = columns.map((column, i) =>
    rows.reduce((width, row) => Math.max(width, (row[i] ?? "").length), column.header.length),
  );
  const line = (cells: readonly string[]): string =>
    (
      indent +
      columns
        .map((column, i) => {
          const width = widths[i] ?? 0;
          const cell = cells[i] ?? "";
          return column.align === "right" ? padLeft(cell, width) : pad(cell, width);
        })
        .join("  ")
    ).trimEnd();

  const out: string[] = [line(columns.map((c) => c.header))];
  out.push(
    indent +
      "-".repeat(
        Math.max(
          1,
          widths.reduce((total, w) => total + w + 2, -2),
        ),
      ),
  );
  for (const row of rows) out.push(line(row));
  return out;
}

/** A GitHub-flavoured pipe table. Cells are emitted verbatim; nothing here contains a pipe. */
export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): readonly string[] {
  const out: string[] = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) out.push(`| ${headers.map((_, i) => row[i] ?? "").join(" | ")} |`);
  return out;
}

// ---- numbers -------------------------------------------------------------------------------------

/** Non-finite is a real answer here and is never printed as a zero. */
export const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);

/** A signed number. Exact zero carries no sign, because "+0.0" reads as a small rise and is not one. */
export const signedFixed = (value: number, digits: number): string => {
  if (!Number.isFinite(value)) return "not measured";
  if (value === 0) return value.toFixed(digits);
  return `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(digits)}`;
};

/** A LEVEL that is a proportion: a pass rate, a refusal rate. */
export const asPercent = (value: number, digits = 1): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "not measured";

/** A DIFFERENCE of two proportions. Percentage points. See the header for why not percent. */
export const asPoints = (value: number, digits = 1): string =>
  Number.isFinite(value) ? `${signedFixed(value * 100, digits)} pp` : "not measured";

/**
 * A MAGNITUDE in percentage points, unsigned.
 *
 * A minimum detectable effect and a noise floor are sizes rather than movements. Printing them with
 * a leading plus makes a 25-point detection threshold look like a 25-point rise, which is the
 * opposite of what it says.
 */
export const asPointsMagnitude = (value: number, digits = 1): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)} pp` : "not measured";

/** A relative change of a continuous quantity, as a fraction of its own baseline. */
export const asRelative = (value: number, digits = 1): string =>
  Number.isFinite(value) ? `${signedFixed(value * 100, digits)}%` : "not measured";

/** A p-value. A floor rather than a zero: no sampled null can support a p of exactly zero. */
export function asP(value: number): string {
  if (!Number.isFinite(value)) return "not measured";
  if (value < 0.001) return "<0.001";
  return value.toFixed(3);
}

/** A continuous metric's own units, so a token count is never printed as if it were a rate. */
export function asMagnitude(metric: MetricKey, value: number): string {
  if (!Number.isFinite(value)) return "not measured";
  if (metric === "costUsd") return `$${value.toFixed(6)}`;
  if (metric === "latencyMs") return `${Math.round(value)} ms`;
  return value.toFixed(1);
}

// ---- one finding, rendered -------------------------------------------------------------------------

export const levelOf = (finding: MetricFinding, value: number): string =>
  finding.binary ? asPercent(value) : asMagnitude(finding.metric, value);

export const effectOf = (finding: MetricFinding): string =>
  finding.binary ? asPoints(finding.effect) : asRelative(finding.effect);

export const intervalOf = (finding: MetricFinding): string => {
  const { low, high } = finding.effectCI;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return "not measured";
  const unit = finding.binary ? " pp" : "%";
  return `[${signedFixed(low * 100, 1)}, ${signedFixed(high * 100, 1)}]${unit}`;
};

/**
 * The 95th percentile of the provider's own A/A wobble, in the same units as `effect`.
 *
 * Directly comparable to the effect column for BOTH metric kinds, which was not always true. The
 * detector originally reported an absolute calibration here while computing the calibrated p on
 * relative differences, so a latency floor of about 4 seconds rendered beside a relative effect and
 * came out as several hundred thousand percent. `compare.ts` now derives both numbers from one
 * relative calibration for continuous metrics, so a percentage is the correct rendering and the two
 * columns finally mean the same thing.
 */
export const noiseFloorOf = (finding: MetricFinding): string =>
  finding.binary
    ? asPointsMagnitude(finding.noiseFloor95)
    : asRelativeMagnitude(finding.noiseFloor95);

/** A relative magnitude, unsigned. A noise floor has no direction. */
export const asRelativeMagnitude = (value: number): string =>
  Number.isFinite(value) ? `${(Math.abs(value) * 100).toFixed(1)}%` : "n/a";

/**
 * How many draws a binary rate rests on.
 *
 * Cases times replicates. This is the count MIN_N_FOR_RATE is about, and the only place in this
 * package where that floor applies.
 */
export const drawsBehind = (finding: MetricFinding, replicates: number): number =>
  finding.cases * replicates;

export const belowRateFloor = (finding: MetricFinding, replicates: number): boolean =>
  finding.binary && drawsBehind(finding, replicates) < MIN_N_FOR_RATE;

/** The gating column. Two words that must never be confusable at a glance. */
export const gatingLabel = (finding: MetricFinding): string =>
  finding.gating ? "GATING" : "observational";

/** The metric name as it appears in a table. Non-gating rows carry the marker inline. */
export const metricLabel = (finding: MetricFinding): string =>
  finding.gating ? finding.metric : `${finding.metric} (observational)`;

/**
 * The per-metric verdict column.
 *
 * `uncalibrated` and `within noise floor` are different answers and are never collapsed: the first
 * says the second null could not be measured, the second says it was measured and the effect did
 * not clear it. `MetricFinding.exceedsNoiseFloor` is nullable for exactly this reason.
 */
export function findingVerdict(finding: MetricFinding): string {
  if (!finding.gating) return finding.significant ? "observational, moved" : "observational";
  if (finding.confirmed) return "CONFIRMED";
  if (finding.significant && finding.exceedsNoiseFloor === true) return "SUSPECTED";
  if (finding.significant && finding.exceedsNoiseFloor === null) return "uncalibrated";
  if (finding.significant) return "within noise floor";
  if (finding.mde === null || finding.mde.mde === null) return "underpowered";
  return "no change";
}

/** Which permutation null ran, and whether it was exact. An approximate test is never printed as exact. */
export const describeTest = (finding: MetricFinding): string => {
  const n = finding.permutation.assignments;
  return `${finding.permutation.method}, ${n} sign assignment${n === 1 ? "" : "s"}, k=${finding.permutation.k}${
    finding.permutation.exchangeable ? "" : ", NOT exchangeable"
  }`;
};

/**
 * Greedy word wrap.
 *
 * The terminal renderer has a fixed rule width and prose that must sit inside it. Wrapping here
 * rather than hand-breaking every sentence means the prose can be edited without re-counting
 * columns, which is the only reason hand-broken prose ever goes stale.
 */
export function wrap(text: string, width: number, indent = "  "): readonly string[] {
  const limit = Math.max(20, width - indent.length);
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line === "") {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= limit) {
      line = `${line} ${word}`;
      continue;
    }
    out.push(indent + line);
    line = word;
  }
  if (line !== "") out.push(indent + line);
  return out;
}
