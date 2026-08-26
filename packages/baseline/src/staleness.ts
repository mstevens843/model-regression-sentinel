// How old a baseline is, and the argument that one age is not one verdict.
//
// THE KEY IDEA: METRICS AGE AT DIFFERENT RATES, AND A SINGLE STALENESS VERDICT FOR ALL OF THEM IS
// DISHONEST. This is the whole reason this file is not a one line comparison against a threshold.
//
// A baseline is a claim about what a provider did on the day it was collected. Some of what it
// recorded is a property of THE MODEL GIVEN A FIXED PROMPT, and some of it is a property of THE
// WORLD THE CALL TRAVELLED THROUGH. Those two decay on completely different clocks:
//
//   latencyMs and costUsd DEGRADE FASTEST, and they degrade for a reason the tool cannot observe or
//   correct. An old baseline is compared against today's network, today's provider load, today's
//   routing and today's rate card, and this project measures none of those. A pilot on this machine
//   put one free form latency sample in eight at 3.57 times the median WITHIN A SINGLE SESSION; a
//   month of unobserved infrastructure change on top of that is not a comparison, it is a rumour
//   with a p-value attached. So these two go `untrustworthy` at the AGING threshold already. They
//   skip the middle state entirely, because there is no useful sense in which a month old latency
//   number is merely getting on a bit.
//
//   quality, schemaValid, refusal and outputTokens ARE PROPERTIES OF THE MODEL under a frozen
//   prompt. The rendered request is byte identical, the graders are code, and nothing between the
//   two runs touches them except the provider itself. They age far more slowly and they follow the
//   main horizon.
//
// A STALE BASELINE IS NOT INVALID, IT IS NARROWER. That sentence is the point of the whole file and
// it is the one a caller must come away with. The behavioral comparison survives being old: if the
// pass rate on a frozen corpus moved, it moved, and the fact that the reference is six weeks back
// does not make the graders wrong. The operational comparison does not survive: the latency and
// cost columns of an old comparison are describing a world that no longer exists. The correct
// response to an old baseline is therefore to keep reading half of it, not to throw it away and not
// to re-collect it reflexively, and a tool that answers "stale" and stops has thrown away the half
// that was still good.
//
// THE HEADLINE `trust` FOLLOWS THE BEHAVIORAL HORIZON, deliberately, because that is the half that
// survives and a headline that reported the worst metric would say `untrustworthy` about a baseline
// whose quality comparison is perfectly sound. Anything gating on an operational metric must read
// `metricTrust`, and the note says so in words on every verdict rather than only when it matters.
//
// WHAT THIS IS NOT: a recommendation to re-collect. It has no idea what a call costs the caller or
// how often the provider actually moves, and a library that says "you should re-run this" without
// either is guessing with authority. It reports the age and what the age costs.

import type { RunSnapshot } from "@model-regression-sentinel/run";
import { ALL_METRICS, type MetricKey, ageInDays } from "@model-regression-sentinel/spec";

/**
 * How much of a baseline a caller may lean on.
 *
 *   `current`         inside the aging horizon. Every metric is worth comparing against.
 *   `aging`           past the aging horizon. Still evidence, and the report must say how old.
 *   `untrustworthy`   a comparison on this metric is describing something other than the provider.
 */
export type Trust = "current" | "aging" | "untrustworthy";

export interface StalenessHorizon {
  /** Days after which a baseline stops being current. Operational metrics fall straight through. */
  readonly aging: number;
  /** Days after which even the behavioral comparison is no longer worth reporting as evidence. */
  readonly untrustworthy: number;
}

export interface StalenessVerdict {
  readonly ageDays: number;
  /** The behavioral headline. See the header: this is the half of the baseline that survives. */
  readonly trust: Trust;
  readonly metricTrust: Readonly<Record<MetricKey, Trust>>;
  readonly note: string;
}

/**
 * A week, then a month.
 *
 * Round numbers with no measurement behind them, and saying so is the honest thing to do: this
 * project has no data on how often a given provider actually changes, because it has no API key and
 * no year of history. They are the defaults a caller is expected to override once they DO have that
 * history, and the verdict prints the horizon it used so two reports written under different
 * horizons can never be mistaken for each other.
 */
export const DEFAULT_HORIZON: StalenessHorizon = { aging: 7, untrustworthy: 30 };

/**
 * Metrics that describe the world the call travelled through rather than the model that answered.
 *
 * These are exactly the two metrics `GATING_METRICS` already excludes from failing a build, and
 * that is not a coincidence: the reason latency and cost cannot gate is the same reason they cannot
 * age. Both come from the tool not observing the thing that moves them.
 */
export const OPERATIONAL_METRICS: readonly MetricKey[] = ["latencyMs", "costUsd"];

/**
 * Assess a baseline's age.
 *
 * `now` is a parameter, never a clock read, so a staleness test states the date it is asserting
 * about and two runs of the same suite on different days agree.
 */
export function assessStaleness(
  snapshot: RunSnapshot,
  now: Date,
  horizon: StalenessHorizon = DEFAULT_HORIZON,
): StalenessVerdict {
  // `ageInDays` takes a day precision date, because that is what a freeze record carries, and a
  // snapshot carries a full ISO instant. Slicing to the day is the right loss of precision here:
  // the horizons are measured in days and an hour of resolution on a month old baseline is a
  // decimal place nobody would act on.
  const ageDays = ageInDays({ frozenAt: snapshot.capturedAt.slice(0, 10) }, now);

  if (!Number.isFinite(ageDays)) {
    return {
      ageDays: Number.NaN,
      trust: "untrustworthy",
      metricTrust: everyMetric("untrustworthy"),
      note: `capturedAt "${snapshot.capturedAt}" could not be read as a date, so the age of this baseline is unknown. An unknown age is treated as the worst age rather than the best one: a reference whose provenance cannot be established is not a reference.`,
    };
  }

  const behavioral: Trust =
    ageDays >= horizon.untrustworthy
      ? "untrustworthy"
      : ageDays >= horizon.aging
        ? "aging"
        : "current";
  // The operational metrics skip `aging` entirely. Past the first horizon they are already
  // describing a network and a rate card the tool never observed. See the header.
  const operational: Trust = ageDays >= horizon.aging ? "untrustworthy" : "current";

  const metricTrust: Record<MetricKey, Trust> = everyMetric(behavioral);
  for (const metric of OPERATIONAL_METRICS) metricTrust[metric] = operational;

  return {
    ageDays,
    trust: behavioral,
    metricTrust,
    note: noteFor(ageDays, behavioral, operational, horizon),
  };
}

/** The metrics a verdict says are no longer worth comparing. Sorted, so two reports agree. */
export const untrustworthyMetrics = (verdict: StalenessVerdict): readonly MetricKey[] =>
  ALL_METRICS.filter((m) => verdict.metricTrust[m] === "untrustworthy");

function everyMetric(trust: Trust): Record<MetricKey, Trust> {
  const out = {} as Record<MetricKey, Trust>;
  for (const metric of ALL_METRICS) out[metric] = trust;
  return out;
}

function noteFor(
  ageDays: number,
  behavioral: Trust,
  operational: Trust,
  horizon: StalenessHorizon,
): string {
  const age = `This baseline is ${ageDays} day(s) old, against horizons of ${horizon.aging} (aging) and ${horizon.untrustworthy} (untrustworthy) days.`;
  const split = `latencyMs and costUsd are ${operational}; quality, schemaValid, refusal and outputTokens are ${behavioral}. They are reported separately because they age at different rates and one verdict for all six would be wrong about at least one of them.`;

  if (behavioral === "current" && operational === "current") {
    return `${age} ${split} Nothing about the age of this reference narrows what may be read from it.`;
  }
  if (behavioral === "current") {
    return `${age} ${split} Read the behavioral comparison as it stands.`;
  }
  if (behavioral === "aging") {
    return `${age} ${split} A stale baseline is not invalid, it is narrower: the behavioral comparison survives, because the rendered corpus is frozen and the graders are code, and the operational one does not, because it is being compared against today's network, today's provider load and today's routing, none of which this tool observes. Read the quality, schemaValid, refusal and outputTokens findings and discard the latency and cost columns.`;
  }
  return `${age} ${split} Past the untrustworthy horizon every column is describing a provider that has had ${ageDays} days to become a different one. This is not a proof that the reference is wrong, and it is not grounds for treating a finding against it as a regression on its own: collect a fresh baseline and compare against that before acting.`;
}
