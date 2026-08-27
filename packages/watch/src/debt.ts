// The watcher's debt report: how much sensitivity this watch has spent, and what to do about it.
//
// WHY THIS IS A FIRST-CLASS REPORT RATHER THAN A FIELD ON A TICK. A watch that has gone dull is
// still quiet, still green, and still returning zero. Nothing about its ordinary output changes, so
// the degradation is invisible in precisely the way that matters: an operator reading "quiet" every
// morning has no reason to suspect the instrument has become five times less sensitive than it was.
// Measured on this implementation, a real 95 to 60 percent drop takes 14 ticks to surface on a fresh
// watch and 620 after 300 quiet ones. Nothing in the tick output distinguishes those two watches.
//
// So the debt is reported on its own terms, with the number that makes it actionable (`evidenceMultiple`,
// which says how much more evidence is now needed than a fresh watch would need) rather than the raw
// log figure, which nobody can interpret.
//
// IT IS NOT AN ALARM, AND THE EXIT CODE PROVES IT. `needsRebaseline` never sets a regression code.
// A dull instrument and a worse provider are different claims, and this project's whole value is in
// keeping them apart. The debt report is maintenance, and maintenance that pretends to be an
// incident is how an alerting channel gets muted.

import {
  DEFAULT_ECONFIG,
  type EProcessConfig,
  type RebaselineAdvice,
  cusumVerdict,
  rebaselineAdvice,
  wealth,
  worstAdvice,
} from "@model-regression-sentinel/detect";
import { lifetimeTicks } from "./lineage.js";
import { type WatchFile, lineageOf } from "./state.js";

export interface CaseDebt {
  readonly caseId: string;
  readonly observations: number;
  readonly successes: number;
  readonly p0: number;
  readonly evidenceMultiple: number;
  readonly sensitivityDebt: number;
  readonly wealth: number;
  readonly alarmed: boolean;
  readonly cusumSignalled: boolean;
  readonly state: RebaselineAdvice["state"];
}

export interface DebtReport {
  readonly requestedModel: string;
  readonly generation: number;
  /** Ticks in the CURRENT generation. */
  readonly ticks: number;
  /** Ticks across every generation. A rotated watch cannot look younger than it is. */
  readonly lifetimeTicks: number;
  readonly rotations: number;
  readonly startedAt: string;
  readonly lastTickAt: string;
  readonly baselineCapturedAt: string;
  readonly baselineReplicates: number;
  /** The dullest case, because a watch is only as sensitive as the case that must catch the drift. */
  readonly worst: RebaselineAdvice | null;
  readonly needsRebaseline: boolean;
  readonly cases: readonly CaseDebt[];
  readonly alarmedCases: readonly string[];
  readonly identityAlerts: number;
}

export function debtReport(file: WatchFile, config: EProcessConfig = DEFAULT_ECONFIG): DebtReport {
  const lineage = lineageOf(file);
  const cases: CaseDebt[] = file.cases.map((s) => {
    const advice = rebaselineAdvice(s, config);
    return {
      caseId: s.caseId,
      observations: s.observations,
      successes: s.successes,
      p0: s.p0,
      evidenceMultiple: advice.evidenceMultiple,
      sensitivityDebt: advice.sensitivityDebt,
      wealth: wealth(s),
      alarmed: s.alarmed,
      cusumSignalled: cusumVerdict(s, config).signalled,
      state: advice.state,
    };
  });
  const worst = worstAdvice(file.cases, config);

  return {
    requestedModel: file.requestedModel,
    generation: lineage.generation,
    ticks: file.ticks,
    lifetimeTicks: lifetimeTicks(file.lineage, file.ticks),
    rotations: lineage.rotations.length,
    startedAt: file.startedAt,
    lastTickAt: file.lastTickAt,
    baselineCapturedAt: lineage.baseline.capturedAt,
    baselineReplicates: lineage.baseline.replicates,
    worst,
    needsRebaseline: worst?.needsRebaseline ?? false,
    cases: cases.sort((a, b) => b.evidenceMultiple - a.evidenceMultiple),
    alarmedCases: file.cases
      .filter((s) => s.alarmed)
      .map((s) => s.caseId)
      .sort(),
    identityAlerts: file.identityAlerts.length,
  };
}

const pad = (v: string, w: number): string => (v.length >= w ? v : v + " ".repeat(w - v.length));
const RULE = "-".repeat(96);

/** The terminal form. No colour, aligned columns, the same shape as every other report here. */
export function renderDebt(report: DebtReport): string {
  const out: string[] = [];
  out.push(RULE);
  out.push(`WATCH DEBT   ${report.requestedModel}   generation ${report.generation}`);
  out.push(RULE);
  out.push(`  ticks this generation   ${report.ticks}`);
  out.push(
    `  ticks over all time     ${report.lifetimeTicks}   across ${report.rotations + 1} baseline(s)`,
  );
  out.push(
    `  baseline captured       ${report.baselineCapturedAt}   (${report.baselineReplicates} replicates)`,
  );
  out.push(`  last tick               ${report.lastTickAt}`);
  out.push(`  identity alerts         ${report.identityAlerts}`);
  out.push(
    `  alarmed cases           ${report.alarmedCases.length === 0 ? "none" : report.alarmedCases.join(", ")}`,
  );
  out.push("");

  const worst = report.worst;
  if (worst === null) {
    out.push("  no case carries an e-process, so there is no sensitivity to report.");
    return out.join("\n");
  }

  out.push(`  SENSITIVITY   ${worst.state.toUpperCase()}`);
  out.push(
    `  the dullest case needs about ${worst.evidenceMultiple.toFixed(1)}x the evidence a fresh watch would,`,
  );
  out.push(`  against a rotation threshold of ${worst.threshold}x.`);
  out.push("");
  out.push(`  ACTION  ${worst.action}`);
  if (worst.inspectFirst.length > 0) {
    out.push("");
    out.push("  INSPECT FIRST, because a rotation discards all of it:");
    for (const item of worst.inspectFirst) out.push(`    - ${item}`);
  }

  out.push("");
  out.push(RULE);
  out.push("  case         obs  passed      p0   evidence x   wealth  state     alarmed");
  out.push(`  ${"-".repeat(72)}`);
  for (const c of report.cases.slice(0, 12)) {
    out.push(
      `  ${pad(c.caseId, 12)} ${String(c.observations).padStart(3)} ${String(c.successes).padStart(7)} ${c.p0.toFixed(3).padStart(7)} ${`${c.evidenceMultiple.toFixed(1)}x`.padStart(12)} ${c.wealth.toFixed(2).padStart(8)}  ${pad(c.state, 9)} ${c.alarmed ? "YES" : "no"}`,
    );
  }
  if (report.cases.length > 12) out.push(`  ... and ${report.cases.length - 12} more`);
  out.push(RULE);
  out.push(
    "  Spending sensitivity is NOT drift and never sets a regression exit code. A blind watch",
  );
  out.push(
    "  is a dull instrument, not a worse provider, and the two must not share an alert channel.",
  );
  return out.join("\n");
}
