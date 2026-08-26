// The exit-code ledger: every graded line in one place, so the exit code is DERIVED from the same
// facts that were printed rather than from a second walk over the same result.
//
// Modelled on `durable-agent-outbox/scripts/release-report.mjs`, and the reason that shape is worth
// copying is not tidiness. When the printed table and the exit code are computed by two different
// passes, they can disagree, and the day they do is the day someone stops believing the table. Here
// the rows ARE the decision: `gatesFor` produces them, `renderGates` prints exactly those rows, and
// `exitCodeFromGates` reads exactly those rows and nothing else.
//
// THE STATUS VOCABULARY IS CLOSED, AND EACH WORD MEANS ONE THING.
//
//   PASS      measured, and good.
//   FAIL      measured, and bad. This is the only status that can set a non-zero exit.
//   NOT RUN   the environment could not support the measurement, and the row SAYS WHICH: too few
//             replicates to calibrate a null, no case in the corpus producing the signal, no
//             minimum detectable effect resolvable at this n, or a corpus mismatch that made the
//             comparison meaningless before any metric was reached. A NOT RUN row is not a pass and
//             must never be counted as one.
//   SKIPPED   the measurement was deliberately declined. `gatesFor` never emits one, because a
//             CompareResult does not record what a caller chose not to do; it is in the vocabulary
//             so a CLI that declined a slow gate can append its own row to this same ledger and be
//             printed and counted by the same code.
//   FLAG      measured, is NOT a failure, and is worth an operator's eye. A suspected finding, an
//             identity change, a metric that turned out to be underpowered.
//
// A NON-ZERO EXIT REQUIRES A CONFIRMED REGRESSION BY DEFAULT. A suspected finding is a FLAG and
// returns zero, because a build that fails on a single crossing of a threshold is a build that
// fails on noise, and the second time that happens the gate gets deleted rather than investigated.
// `gate: "suspected"` promotes metric FLAGs to a failing exit for a team that would rather chase a
// false alarm than miss a real one, and it is opt-in so that the choice is made deliberately.
//
// A CORPUS MISMATCH EXITS 2, NOT 1, and outranks everything else in the ledger. It means the tool
// was misused rather than that the provider moved, and a runbook that handles those two the same
// way will send someone to read a model changelog about a prompt-template edit.
//
// WHAT WAS REJECTED. A numeric severity per row that the exit code sums: a total is not auditable,
// and a row can only ever be made to matter less by lowering a number nobody reviews. A WARN status
// distinct from FLAG: two words for "look at this but do not fail" is one word too many, and the
// second one always ends up meaning "we did not decide".
//
// WHAT THIS IS NOT: a renderer of findings. It grades. `markdown.ts` and `text.ts` explain.

import type { CompareResult, MetricFinding } from "@model-regression-sentinel/detect";
import { GATING_METRICS, type MetricKey } from "@model-regression-sentinel/spec";
import {
  RULE,
  RULE_WIDTH,
  asP,
  asPercent,
  asPointsMagnitude,
  effectOf,
  noiseFloorOf,
  renderTable,
  wrap,
} from "./format.js";

export type GateStatus = "PASS" | "FAIL" | "SKIPPED" | "NOT RUN" | "FLAG";

export interface GateRow {
  readonly area: string;
  readonly name: string;
  readonly status: GateStatus;
  readonly detail: string;
}

/** The areas, as constants, so a typo cannot silently detach a row from the exit-code rule. */
export const AREA_COMPARABILITY = "comparability";
export const AREA_METRIC = "metric";
export const AREA_IDENTITY = "identity";
export const AREA_POWER = "power";

export const ALL_GATE_STATUSES: readonly GateStatus[] = [
  "PASS",
  "FAIL",
  "SKIPPED",
  "NOT RUN",
  "FLAG",
];

/** What each status means, printed with the counts so the vocabulary travels with the numbers. */
const MEANING: Readonly<Record<GateStatus, string>> = {
  PASS: "measured and good",
  FAIL: "measured and bad, sets a non-zero exit",
  SKIPPED: "deliberately declined, never measured",
  "NOT RUN": "the environment could not support the measurement",
  FLAG: "measured, not a failure, worth an operator's eye",
};

/** Keeps one long detail from widening the whole table. The full text stays on the row object. */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`;

export function gatesFor(result: CompareResult): readonly GateRow[] {
  const rows: GateRow[] = [];
  const comparable = result.verdict !== "NOT_COMPARABLE";

  rows.push({
    area: AREA_COMPARABILITY,
    name: "corpus digest",
    status: comparable ? "PASS" : "FAIL",
    detail: comparable
      ? "both arms were collected against one rendered corpus"
      : "the two arms used different rendered corpora, so nothing was measured",
  });

  const byMetric = new Map<MetricKey, MetricFinding>(
    result.findings.map((f) => [f.metric, f] as const),
  );
  for (const metric of GATING_METRICS) {
    rows.push(metricRow(metric, byMetric.get(metric), result, comparable));
  }

  rows.push(identityRow(result));
  rows.push(powerRow(result, comparable));
  return rows;
}

function metricRow(
  metric: MetricKey,
  finding: MetricFinding | undefined,
  result: CompareResult,
  comparable: boolean,
): GateRow {
  const base = { area: AREA_METRIC, name: metric } as const;

  if (!comparable) {
    return {
      ...base,
      status: "NOT RUN",
      detail: "corpora differ, so this metric was never reached",
    };
  }
  if (finding === undefined) {
    if (result.findings.length === 0) {
      return {
        ...base,
        status: "NOT RUN",
        detail: `no analysis ran: ${truncate(result.reason, 60)}`,
      };
    }
    return {
      ...base,
      status: "NOT RUN",
      detail: "no case in this corpus produces this signal",
    };
  }
  if (finding.confirmed) {
    return {
      ...base,
      status: "FAIL",
      detail: `${effectOf(finding)}, perm p ${asP(finding.permutation.p)}, calib p ${asP(finding.calibratedP)}, reproduced`,
    };
  }
  if (finding.significant && finding.exceedsNoiseFloor === true) {
    return {
      ...base,
      status: "FLAG",
      detail: `${effectOf(finding)} cleared both nulls on one comparison, not yet reproduced`,
    };
  }
  if (finding.significant && finding.exceedsNoiseFloor === null) {
    return {
      ...base,
      status: "NOT RUN",
      detail: `perm p ${asP(finding.permutation.p)} but the noise floor could not be measured`,
    };
  }
  if (finding.significant) {
    return {
      ...base,
      status: "PASS",
      detail: `${effectOf(finding)} is inside this provider's own measured noise floor of ${noiseFloorOf(finding)}`,
    };
  }
  const mde = finding.mde;
  if (mde === null) {
    // Two different reasons produce a null MDE and they are not interchangeable: the simulator
    // draws from per-case pass RATES so it never covers a continuous metric, and a caller can also
    // decline the simulation outright. Saying "the grid was exhausted" would describe a search that
    // never ran in either case.
    return {
      ...base,
      status: "NOT RUN",
      detail: finding.binary
        ? "the power simulation did not run, so this was not checked"
        : "no MDE is simulated for a continuous metric, so this was not checked",
    };
  }
  if (mde.mde === null) {
    return {
      ...base,
      status: "NOT RUN",
      detail: `no effect on the grid resolved at n=${result.replicates.baseline}, so this was not checked`,
    };
  }
  return {
    ...base,
    status: "PASS",
    detail: `no move; a ${asPointsMagnitude(mde.mde)} drop would have been caught ${asPercent(mde.power)} of the time`,
  };
}

/**
 * Identity is a FLAG and never a FAIL.
 *
 * A fingerprint change is a fact with no p-value and it cannot be a false positive, but it is also
 * not by itself evidence that behaviour moved: a vendor can re-tag identical weights. Failing a
 * build on it would make a re-tag indistinguishable from a regression, which is the confusion the
 * whole fingerprint module exists to prevent.
 */
function identityRow(result: CompareResult): GateRow {
  if (result.identityChanges.length === 0) {
    return {
      area: AREA_IDENTITY,
      name: "fingerprint",
      status: "PASS",
      detail: "no recorded identity field moved between the two arms",
    };
  }
  return {
    area: AREA_IDENTITY,
    name: "fingerprint",
    status: "FLAG",
    detail: `${result.identityChanges.length} field(s) moved: ${result.identityChanges.map((c) => c.field).join(", ")}`,
  };
}

function powerRow(result: CompareResult, comparable: boolean): GateRow {
  const base = { area: AREA_POWER, name: "detectable effect" } as const;
  if (!comparable) {
    return { ...base, status: "NOT RUN", detail: "corpora differ, so no power was computed" };
  }
  const withMde = result.findings.filter((f) => f.gating && f.mde !== null);
  if (withMde.length === 0) {
    return {
      ...base,
      status: "NOT RUN",
      detail: "no minimum detectable effect was simulated on this comparison",
    };
  }
  if (result.underpoweredMetrics.length > 0) {
    return {
      ...base,
      status: "FLAG",
      detail: `${result.underpoweredMetrics.length} gating metric(s) had no resolvable MDE: ${result.underpoweredMetrics.join(", ")}`,
    };
  }
  const resolved = withMde.map((f) => f.mde?.mde ?? Number.NaN).filter((v) => Number.isFinite(v));
  const worst = resolved.length === 0 ? Number.NaN : Math.max(...resolved);
  return {
    ...base,
    status: "PASS",
    detail: `every gating metric resolved an MDE; the widest is ${asPointsMagnitude(worst)}`,
  };
}

/**
 * The exit code, read off the rows that were printed.
 *
 * Nothing here re-derives a verdict. Every branch is a question about the ledger, which is why the
 * printed table and the exit code cannot disagree.
 */
export function exitCodeFromGates(
  rows: readonly GateRow[],
  gate: "confirmed" | "suspected" = "confirmed",
): number {
  // Misuse outranks a regression: a comparison that was never valid has no finding to report.
  if (rows.some((r) => r.area === AREA_COMPARABILITY && r.status === "FAIL")) return 2;
  if (rows.some((r) => r.area === AREA_METRIC && r.status === "FAIL")) return 1;
  if (gate === "suspected" && rows.some((r) => r.area === AREA_METRIC && r.status === "FLAG")) {
    return 1;
  }
  return 0;
}

export function renderGates(rows: readonly GateRow[]): string {
  const lines: string[] = ["drift gates", RULE];
  lines.push(
    ...renderTable(
      [{ header: "area" }, { header: "gate" }, { header: "status" }, { header: "detail" }],
      rows.map((r) => [r.area, r.name, r.status, truncate(r.detail, 50)]),
    ),
  );
  lines.push(RULE);
  lines.push(
    ...renderTable(
      [{ header: "status" }, { header: "count", align: "right" }, { header: "meaning" }],
      ALL_GATE_STATUSES.map((status) => [
        status,
        String(rows.filter((r) => r.status === status).length),
        MEANING[status],
      ]),
    ),
  );

  // The full detail for everything that is not a plain pass, untruncated, so the table above can
  // stay narrow without the reader losing the one line they came for.
  for (const status of ["FAIL", "FLAG", "NOT RUN", "SKIPPED"] as const) {
    for (const row of rows.filter((r) => r.status === status)) {
      lines.push(
        truncate(`  ${row.status.padEnd(8)} ${row.area}/${row.name}: ${row.detail}`, RULE_WIDTH),
      );
    }
  }

  lines.push(RULE);
  const code = exitCodeFromGates(rows, "confirmed");
  lines.push(
    ...wrap(
      `exit ${code} under the default gate. A non-zero exit requires a CONFIRMED regression, so a suspected finding is a FLAG and returns zero. NOT RUN is not a pass: a ledger with no FAIL in it says only that every gate this run MEASURED was clean.`,
      RULE_WIDTH,
      "  ",
    ),
  );
  return lines.join("\n");
}
