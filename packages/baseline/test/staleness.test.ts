// The one claim in `staleness.ts` that a single-verdict implementation would quietly delete:
// METRICS AGE AT DIFFERENT RATES.
//
// WHAT THIS FILE PREVENTS. `assessStaleness` could be written in three lines - compare the age
// against a threshold and return one word - and every test that only asked "is a six week old
// baseline stale" would still pass. The whole argument of the module lives in the gap between the
// two clocks: `latencyMs` and `costUsd` are properties of the network, the provider's load, the
// routing and the rate card, none of which this project observes, so they go straight to
// `untrustworthy` at the FIRST horizon and never occupy the middle state at all, while `quality`,
// `schemaValid`, `refusal` and `outputTokens` are properties of the model under a frozen prompt and
// follow the main horizon. The assertion at exactly the aging threshold is therefore the load
// bearing one in this file: it is the single day on which a collapsed implementation and the real
// one give different answers.
//
// The headline `trust` following the BEHAVIORAL horizon is pinned for the same reason. A headline
// that reported the worst metric would say `untrustworthy` about a baseline whose quality
// comparison is perfectly sound, and the correct reading of an old baseline is that it is narrower
// rather than invalid.
//
// NO REAL CLOCK ANYWHERE. Every `now` is written out in the test, so two runs of this suite on
// different days agree and a failure names a date rather than a mood.

import type { ProviderResponse, RunSnapshot } from "@model-regression-sentinel/run";
import { skipped } from "@model-regression-sentinel/run";
import { ALL_METRICS, type MetricKey } from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HORIZON,
  OPERATIONAL_METRICS,
  assessStaleness,
  untrustworthyMetrics,
} from "../src/staleness.js";

const ok = (): ProviderResponse => ({ ...skipped(""), error: "" });

/** The day the reference was collected. Everything below is measured from here, in whole days. */
const CAPTURED_ON = "2026-07-01";

function snapshot(capturedAt: string): RunSnapshot {
  return {
    schemaVersion: 1,
    label: "baseline",
    capturedAt,
    provider: "fixture",
    requestedModel: "fixture-alias",
    splits: ["canary"],
    replicates: 10,
    concurrency: 1,
    caseIds: ["cse-c-001"],
    corpusDigest: "digest-of-the-rendered-corpus",
    fingerprint: null,
    records: [
      {
        caseId: "cse-c-001",
        replicate: 0,
        promptId: "terse-v1",
        promptSha256: "p",
        requestSha256: "r",
        response: ok(),
      },
    ],
    errorCount: 0,
    cost: {
      model: "fixture-model-1",
      n: 1,
      meanInputTokens: 40,
      meanOutputTokens: 5,
      meanCacheReadTokens: 0,
      meanCacheCreateTokens: 0,
      harnessUsdPerCall: 0.001,
      bareApiUsdPerCall: 0.0009,
      rateCardDate: "2026-06-24",
      rateUnknown: false,
    },
  };
}

/** `days` after the capture date, at midnight UTC. Written out rather than read from a clock. */
const daysLater = (days: number): Date =>
  new Date(Date.parse(`${CAPTURED_ON}T00:00:00Z`) + days * 86_400_000);

const BASELINE = snapshot(`${CAPTURED_ON}T09:30:00.000Z`);

/** The four metrics that describe the model rather than the world the call travelled through. */
const BEHAVIORAL: readonly MetricKey[] = ALL_METRICS.filter(
  (m) => !OPERATIONAL_METRICS.includes(m),
);

describe("a baseline's age is not one verdict for all six metrics", () => {
  it("calls everything current one day after collection", () => {
    const verdict = assessStaleness(BASELINE, daysLater(1));
    expect(verdict.ageDays).toBe(1);
    expect(verdict.trust).toBe("current");
    for (const metric of ALL_METRICS) expect(verdict.metricTrust[metric], metric).toBe("current");
    expect(untrustworthyMetrics(verdict)).toEqual([]);
  });

  it("has latencyMs and costUsd already untrustworthy on the day quality is only aging", () => {
    // THE test in this file. On exactly this day a collapsed implementation and the real one give
    // different answers, and every other day in the range they agree.
    const verdict = assessStaleness(BASELINE, daysLater(DEFAULT_HORIZON.aging));
    expect(verdict.ageDays).toBe(DEFAULT_HORIZON.aging);
    expect(verdict.metricTrust.latencyMs).toBe("untrustworthy");
    expect(verdict.metricTrust.costUsd).toBe("untrustworthy");
    expect(verdict.metricTrust.quality).toBe("aging");
    for (const metric of BEHAVIORAL) expect(verdict.metricTrust[metric], metric).toBe("aging");
  });

  it("keeps the headline on the behavioral half, which is the half that survives being old", () => {
    // A headline that reported the worst metric would read `untrustworthy` here, about a baseline
    // whose quality comparison is sound, and the caller would throw away the good half.
    const verdict = assessStaleness(BASELINE, daysLater(DEFAULT_HORIZON.aging));
    expect(verdict.trust).toBe("aging");
    expect(untrustworthyMetrics(verdict)).toEqual(["latencyMs", "costUsd"]);
  });

  it("never lets an operational metric occupy the middle state on any day at all", () => {
    // The `aging` state is meaningless for these two: there is no useful sense in which a month old
    // latency number is merely getting on a bit. Swept rather than sampled, because a single day
    // could pass by luck.
    for (let day = 0; day <= 45; day += 1) {
      const verdict = assessStaleness(BASELINE, daysLater(day));
      for (const metric of OPERATIONAL_METRICS) {
        expect(verdict.metricTrust[metric], `${metric} on day ${day}`).not.toBe("aging");
      }
    }
  });

  it("calls every metric untrustworthy past the untrustworthy horizon", () => {
    const verdict = assessStaleness(BASELINE, daysLater(DEFAULT_HORIZON.untrustworthy + 15));
    expect(verdict.ageDays).toBe(DEFAULT_HORIZON.untrustworthy + 15);
    expect(verdict.trust).toBe("untrustworthy");
    for (const metric of ALL_METRICS)
      expect(verdict.metricTrust[metric], metric).toBe("untrustworthy");
    expect([...untrustworthyMetrics(verdict)]).toEqual([...ALL_METRICS]);
  });

  it("uses the horizon it was handed rather than the default one", () => {
    // The defaults are round numbers with no measurement behind them and the module says so. A
    // caller who HAS a year of provider history is expected to override them, and an implementation
    // that ignored the argument would look identical on every test that only used the default.
    const verdict = assessStaleness(BASELINE, daysLater(3), { aging: 2, untrustworthy: 90 });
    expect(verdict.trust).toBe("aging");
    expect(verdict.metricTrust.latencyMs).toBe("untrustworthy");
    expect(verdict.note).toContain("horizons of 2 (aging) and 90 (untrustworthy)");
  });
});

describe("the verdict says in words what the split costs the reader", () => {
  it("states both halves on a current baseline, not only when the age starts to matter", () => {
    const verdict = assessStaleness(BASELINE, daysLater(1));
    expect(verdict.note).toContain("latencyMs and costUsd are current");
    expect(verdict.note).toContain("quality, schemaValid, refusal and outputTokens are current");
  });

  it("tells an aging reader which columns to keep and which to discard", () => {
    const verdict = assessStaleness(BASELINE, daysLater(DEFAULT_HORIZON.aging));
    expect(verdict.note).toContain("A stale baseline is not invalid, it is narrower");
    expect(verdict.note).toContain("discard the latency and cost columns");
  });

  it("does not recommend a re-collection it has no basis for, past the second horizon", () => {
    // The module has no idea what a call costs the caller or how often the provider moves. It says
    // to collect a fresh baseline before ACTING on a finding, which is a different claim from
    // telling somebody to spend money on a schedule.
    const verdict = assessStaleness(BASELINE, daysLater(DEFAULT_HORIZON.untrustworthy));
    expect(verdict.note).toContain(
      "collect a fresh baseline and compare against that before acting",
    );
  });
});

describe("an age that cannot be established is treated as the worst age", () => {
  it("returns NaN and untrustworthy for a capturedAt that is not a date", () => {
    // A reference whose provenance cannot be established is not a reference. Defaulting an unknown
    // age to zero would make a corrupt file look like the freshest baseline in the directory.
    const verdict = assessStaleness(snapshot("some time last week"), daysLater(1));
    expect(Number.isNaN(verdict.ageDays)).toBe(true);
    expect(verdict.trust).toBe("untrustworthy");
    for (const metric of ALL_METRICS)
      expect(verdict.metricTrust[metric], metric).toBe("untrustworthy");
    expect(verdict.note).toContain("could not be read as a date");
  });
});
