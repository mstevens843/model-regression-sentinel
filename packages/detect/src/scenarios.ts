// The calibration scenarios: what a drift detector must and must not do.
//
// EVERY "MUST NOT" HAS A "MUST" BESIDE IT, and that pairing is the most important structural fact
// about this file. The sibling `durable-agent-outbox` records the reason in its scenario 14: a suite
// made entirely of safety properties is satisfied VACUOUSLY by an implementation that does nothing,
// and you cannot detect that failure by running the suite against something correct.
//
// The trap is unusually sharp for a drift detector, because almost everything one wants to promise
// has the form "does not report drift when there is none":
//
//   does not fire on an A/A comparison           - satisfied by a detector that never fires
//   does not fire on an effect below its MDE     - satisfied by a detector that never fires
//   does not fire on a latency outlier           - satisfied by a detector that never fires
//   does not fire on repeated looks              - satisfied by a detector that never fires
//
// A detector that returns NO_DRIFT unconditionally passes all four and is worthless, and it would
// look excellent on any false-positive dashboard. So the injected-drift scenarios are not a nice
// extra, they are what stops the honesty scenarios from being free, and `alwaysQuiet` is shipped as
// a mutant specifically so that this cannot quietly stop being true.
//
// Ids are stable. Every mutant's `mustFail` list refers to them, so renaming one silently
// re-points a negative control at a scenario it was never written against.

import { metadataOf, skipped } from "@model-regression-sentinel/run";
import { exitCodeFor } from "./compare.js";
import { type CheckResult, type Detector, check, expectEqual } from "./detector.js";
import { needsRebaseline, sensitivityDebt, startEProcess, wealthFloor } from "./eprocess.js";
import { mulberry32 } from "./rng.js";
import { synthCases, synthEvalCases, synthSnapshot } from "./synth.js";

export interface CalibrationScenario {
  /** Stable two-digit id. Referenced by every mutant's `mustFail` list. */
  readonly id: string;
  readonly title: string;
  run(detector: Detector): readonly CheckResult[];
}

const CASES = synthCases(12);
const EVAL = synthEvalCases(CASES);
const FAST = { skipMde: true } as const;

/** Two arms drawn from identical rates. Different seeds, so they differ by sampling alone. */
const aaPair = (seed: number, replicates = 10) => ({
  baseline: synthSnapshot(CASES, { label: "baseline", replicates, rng: mulberry32(seed) }),
  candidate: synthSnapshot(CASES, { label: "candidate", replicates, rng: mulberry32(seed + 7919) }),
});

/** A candidate whose pass rate is `drop` lower on every case. A uniform, realistic drift shape. */
const driftPair = (seed: number, drop: number, replicates = 10) => {
  const dropped = CASES.map((c) => ({ ...c, passRate: Math.max(0, c.passRate - drop) }));
  return {
    baseline: synthSnapshot(CASES, { label: "baseline", replicates, rng: mulberry32(seed) }),
    candidate: synthSnapshot(dropped, {
      label: "candidate",
      replicates,
      rng: mulberry32(seed + 7919),
    }),
  };
};

export const aaIsQuiet: CalibrationScenario = {
  id: "01",
  title: "aaIsQuiet: two runs of the same provider in the same window are not a regression",
  run(detector) {
    const out: CheckResult[] = [];
    // Several independent A/A pairs, because a detector can be quiet on one by luck. This is the
    // core false-positive check and the reason the whole project exists.
    for (const seed of [11, 23, 37, 51, 67, 83, 97, 113]) {
      const { baseline, candidate } = aaPair(seed);
      const r = detector.compare(EVAL, baseline, candidate, FAST);
      out.push(
        check(
          `seed ${seed}: does not report drift between two draws from one provider`,
          r.verdict !== "SUSPECTED_DRIFT" && r.verdict !== "CONFIRMED_DRIFT",
          `verdict=${r.verdict} reason=${r.reason}`,
        ),
      );
      out.push(
        check(
          `seed ${seed}: exit code is not a failure`,
          exitCodeFor(r) === 0,
          `exit=${exitCodeFor(r)}`,
        ),
      );
    }
    return out;
  },
};

export const largeDriftIsCaught: CalibrationScenario = {
  id: "02",
  title: "largeDriftIsCaught: a 30 point drop in pass rate is reported, not shrugged off",
  run(detector) {
    const out: CheckResult[] = [];
    // THE ANTI-VACUITY SCENARIO. Without this, every other scenario in this file is passed by a
    // detector that has been switched off.
    for (const seed of [11, 23, 37, 51]) {
      const { baseline, candidate } = driftPair(seed, 0.3);
      const r = detector.compare(EVAL, baseline, candidate, FAST);
      out.push(
        check(
          `seed ${seed}: a 30 point drop is at least suspected`,
          r.verdict === "SUSPECTED_DRIFT" || r.verdict === "CONFIRMED_DRIFT",
          `verdict=${r.verdict} reason=${r.reason}`,
        ),
      );
      const quality = r.findings.find((f) => f.metric === "quality");
      out.push(
        check(
          `seed ${seed}: the effect is attributed to quality and has the right sign`,
          quality !== undefined && quality.effect < 0,
          `effect=${quality?.effect ?? "absent"}`,
        ),
      );
    }
    return out;
  },
};

export const tinyDriftIsNotOverclaimed: CalibrationScenario = {
  id: "03",
  title:
    "tinyDriftIsNotOverclaimed: a 2 point drop at n=10 is not reported as a confirmed regression",
  run(detector) {
    const out: CheckResult[] = [];
    // A real but tiny effect, far below what 12 cases at 10 replicates can resolve. The honest
    // answers are NO_DRIFT or INCONCLUSIVE. Claiming a regression here is claiming a resolution the
    // sample does not have.
    for (const seed of [11, 23, 37, 51]) {
      const { baseline, candidate } = driftPair(seed, 0.02);
      const r = detector.compare(EVAL, baseline, candidate, FAST);
      out.push(
        check(
          `seed ${seed}: a 2 point drop is not confirmed`,
          r.verdict !== "CONFIRMED_DRIFT",
          `verdict=${r.verdict}`,
        ),
      );
    }
    return out;
  },
};

export const latencyNeverGates: CalibrationScenario = {
  id: "04",
  title: "latencyNeverGates: a doubled latency with unchanged quality does not fail a build",
  run(detector) {
    const out: CheckResult[] = [];
    const baseline = synthSnapshot(CASES, {
      label: "baseline",
      replicates: 10,
      rng: mulberry32(11),
    });
    // Same quality, twice the latency. A real thing that happens for reasons that are not drift:
    // a noisy neighbour, a different region, a busier hour.
    const candidate = synthSnapshot(CASES, {
      label: "candidate",
      replicates: 10,
      rng: mulberry32(11 + 7919),
      latencyScale: 2,
    });
    const r = detector.compare(EVAL, baseline, candidate, FAST);
    const latency = r.findings.find((f) => f.metric === "latencyMs");
    out.push(check("latency is measured and reported", latency !== undefined));
    out.push(
      check(
        "latency is not a gating metric",
        latency === undefined || latency.gating === false,
        `gating=${String(latency?.gating)}`,
      ),
    );
    out.push(
      check(
        "a pure latency change does not fail the build",
        exitCodeFor(r) === 0,
        `verdict=${r.verdict} exit=${exitCodeFor(r)}`,
      ),
    );
    return out;
  },
};

export const repeatedLooksDoNotManufactureAlarms: CalibrationScenario = {
  id: "05",
  title:
    "repeatedLooksDoNotManufactureAlarms: a watch of pure noise does not fire, however long it runs",
  run(detector) {
    const out: CheckResult[] = [];

    // The peeking problem, made concrete, with the null being the exact one the watcher bets
    // against rather than an easier one. Every round is drawn at the watcher's OWN p0, so nothing
    // whatsoever changes and every alarm is a false alarm.
    const falseAlarmRate = (runs: number, rounds: number): number => {
      let alarms = 0;
      for (let trial = 0; trial < runs; trial += 1) {
        const rng = mulberry32(1000 + trial);
        let state = startEProcess("syn-c-001", 9, 10);
        const nullRate = state.p0;
        let fired = false;
        for (let round = 0; round < rounds; round += 1) {
          const outcomes = Array.from({ length: 3 }, () => rng() < nullRate);
          const r = detector.watchRound(state, outcomes);
          state = r.state;
          if (r.alarmed) fired = true;
        }
        if (fired) alarms += 1;
      }
      return alarms;
    };

    const runs = 40;
    const short = falseAlarmRate(runs, 1000);
    const long = falseAlarmRate(runs, 2000);

    // Four of forty is 10 percent against a nominal 5 percent. Loose on purpose: forty watches
    // cannot resolve 5 percent, and a threshold this suite could fail by luck would be a flaky test
    // rather than a control. A procedure that peeks lands far outside it regardless.
    out.push(
      check(
        `over ${runs} watches of 1000 null rounds, false alarms stay near the nominal rate`,
        short <= 4,
        `${short}/${runs} watches alarmed on a stream where nothing changed`,
      ),
    );

    // THE ALWAYS-VALID PROPERTY ITSELF, asserted rather than described. A fixed-alpha test applied
    // repeatedly accumulates error as the watch gets longer, so doubling the number of looks
    // increases its false alarm rate. An e-process is bounded over the WHOLE sequence, so doubling
    // the watch changes nothing. This check is the difference between the two, in one line.
    out.push(
      check(
        "doubling the length of the watch does not increase the false alarm rate",
        long <= Math.max(4, short),
        `1000 rounds: ${short}/${runs}, 2000 rounds: ${long}/${runs}`,
      ),
    );
    return out;
  },
};

export const theWatcherStillFires: CalibrationScenario = {
  id: "06",
  title: "theWatcherStillFires: a real sustained drop does alarm the watcher",
  run(detector) {
    const out: CheckResult[] = [];
    // The "must" beside scenario 05's "must not". A watcher that never alarms passes 05 perfectly.
    let alarms = 0;
    const runs = 20;
    for (let trial = 0; trial < runs; trial += 1) {
      const rng = mulberry32(2000 + trial);
      let state = startEProcess("syn-c-001", 19, 20);
      for (let round = 0; round < 60; round += 1) {
        const outcomes = Array.from({ length: 3 }, () => rng() < 0.5);
        state = detector.watchRound(state, outcomes).state;
      }
      if (state.alarmed) alarms += 1;
    }
    out.push(
      check(
        "a drop from 95 to 50 percent alarms nearly every watch",
        alarms >= runs - 2,
        `${alarms}/${runs} watches alarmed`,
      ),
    );
    return out;
  },
};

export const oneReplicateIsInconclusive: CalibrationScenario = {
  id: "07",
  title: "oneReplicateIsInconclusive: a single draw per case cannot separate drift from noise",
  run(detector) {
    const { baseline, candidate } = driftPair(11, 0.3, 1);
    const r = detector.compare(EVAL, baseline, candidate, FAST);
    return [
      expectEqual(
        "one replicate per arm yields INCONCLUSIVE rather than a verdict",
        r.verdict,
        "INCONCLUSIVE",
      ),
      check("and does not fail the build", exitCodeFor(r) === 0, `exit=${exitCodeFor(r)}`),
    ];
  },
};

export const differentCorporaAreNotComparable: CalibrationScenario = {
  id: "08",
  title: "differentCorporaAreNotComparable: two runs of different corpora are refused, not diffed",
  run(detector) {
    const baseline = synthSnapshot(CASES, {
      label: "baseline",
      replicates: 10,
      rng: mulberry32(11),
      corpusDigest: "digest-a",
    });
    const candidate = synthSnapshot(CASES, {
      label: "candidate",
      replicates: 10,
      rng: mulberry32(23),
      corpusDigest: "digest-b",
    });
    const r = detector.compare(EVAL, baseline, candidate, FAST);
    return [
      expectEqual("the comparison is refused", r.verdict, "NOT_COMPARABLE"),
      check(
        "and exits with a distinct code, because this is misuse rather than a regression",
        exitCodeFor(r) === 2,
        `exit=${exitCodeFor(r)}`,
      ),
    ];
  },
};

export const confirmationIsRequired: CalibrationScenario = {
  id: "09",
  title: "confirmationIsRequired: one crossing is suspected, only a reproduction is confirmed",
  run(detector) {
    const out: CheckResult[] = [];
    const { baseline, candidate } = driftPair(11, 0.3);
    const single = detector.compare(EVAL, baseline, candidate, FAST);
    out.push(
      expectEqual(
        "a single comparison of a real effect is SUSPECTED, not CONFIRMED",
        single.verdict,
        "SUSPECTED_DRIFT",
      ),
    );
    out.push(
      check(
        "and a suspected finding does not fail the build by default",
        exitCodeFor(single) === 0,
        `exit=${exitCodeFor(single)}`,
      ),
    );
    // An independently collected second candidate, same true rates, different seed.
    const dropped = CASES.map((c) => ({ ...c, passRate: Math.max(0, c.passRate - 0.3) }));
    const confirmation = synthSnapshot(dropped, {
      label: "confirmation",
      replicates: 10,
      rng: mulberry32(31337),
    });
    const confirmed = detector.compare(EVAL, baseline, candidate, { ...FAST, confirmation });
    out.push(
      expectEqual("a reproduced finding is CONFIRMED", confirmed.verdict, "CONFIRMED_DRIFT"),
    );
    out.push(
      check(
        "and only then does the build fail",
        exitCodeFor(confirmed) === 1,
        `exit=${exitCodeFor(confirmed)}`,
      ),
    );
    return out;
  },
};

export const identityChangeIsReportedWithoutAPValue: CalibrationScenario = {
  id: "10",
  title:
    "identityChangeIsReportedWithoutAPValue: a changed resolved model is a fact, not a statistic",
  run(detector) {
    const baseline = synthSnapshot(CASES, {
      label: "baseline",
      replicates: 10,
      rng: mulberry32(11),
      resolvedModel: "synthetic-model-1",
    });
    const candidate = synthSnapshot(CASES, {
      label: "candidate",
      replicates: 10,
      rng: mulberry32(11 + 7919),
      resolvedModel: "synthetic-model-2",
    });
    const r = detector.compare(EVAL, baseline, candidate, FAST);
    return [
      check(
        "the resolved model change is reported",
        r.identityChanges.some((c) => c.field === "resolvedModel"),
        JSON.stringify(r.identityChanges),
      ),
      check(
        "and behaviour is still judged on its own evidence rather than on the rename",
        r.verdict !== "CONFIRMED_DRIFT",
        `verdict=${r.verdict}`,
      ),
    ];
  },
};

export const spentSensitivityIsReported: CalibrationScenario = {
  id: "11",
  title: "spentSensitivityIsReported: a watch that has gone blind says so instead of staying quiet",
  run(detector) {
    const out: CheckResult[] = [];

    // The failure this pins is silent and is the worst kind a monitor can have. `p0` is a
    // conservative lower bound, so during a long quiet stretch the true rate sits above it and the
    // betting process loses on nearly every observation. Nothing about the verdict, the wealth or
    // the false alarm rate reveals it. Measured on this implementation against a 19/20 baseline: a
    // real 95 to 60 percent drop is caught in 12 ticks on a fresh watch and 618 after 300 quiet
    // ones. The statistics cannot fix that without giving up the any-time guarantee, so the watch
    // has to report it.
    const rng = mulberry32(4242);
    let fresh = startEProcess("syn-c-001", 19, 20);
    out.push(check("a fresh watch has spent nothing", sensitivityDebt(fresh) === 0));
    out.push(check("and is not asking to be re-baselined", !needsRebaseline(fresh)));

    for (let round = 0; round < 300; round += 1) {
      fresh = detector.watchRound(
        fresh,
        Array.from({ length: 5 }, () => rng() < 0.95),
      ).state;
    }

    out.push(
      check(
        "after 300 quiet rounds the spent sensitivity is large and is reported",
        sensitivityDebt(fresh) > 20,
        `debt=${sensitivityDebt(fresh).toFixed(1)}`,
      ),
    );
    out.push(
      check(
        "and the watch asks to be re-baselined rather than continuing to look sensitive",
        needsRebaseline(fresh),
        `debt=${sensitivityDebt(fresh).toFixed(1)}`,
      ),
    );
    out.push(
      check(
        "the wealth a human is shown never falls below the mixture floor",
        fresh.logWealth >= wealthFloor() - 1e-9,
        `logWealth=${fresh.logWealth.toFixed(3)} floor=${wealthFloor().toFixed(3)}`,
      ),
    );
    return out;
  },
};

export const metadataDriftIsNotQualityDrift: CalibrationScenario = {
  id: "12",
  title: "metadataDriftIsNotQualityDrift: a changed endpoint is reported, and is not a regression",
  run(detector) {
    const out: CheckResult[] = [];

    // Behaviour held perfectly still: the SAME seed on both arms, so every recorded output is
    // identical. Only the provider metadata moves. Anything this reports as a regression is being
    // reported on the strength of a field that carries no p-value at all.
    const shared = { replicates: 10, capturedAt: "2026-08-26T00:00:00.000Z" } as const;
    const before = synthSnapshot(CASES, {
      ...shared,
      label: "baseline",
      rng: mulberry32(11),
      metadata: metadataOf({
        provider: "claude_cli:sonnet",
        requestedModel: "sonnet",
        response: { ...skipped(""), error: "", modelServed: "m", contextWindow: 1_000_000 },
        endpoint: "cli",
        tokenSource: "cli_usage",
        observedAt: "2026-08-26T00:00:00.000Z",
      }),
    });
    const after = synthSnapshot(CASES, {
      ...shared,
      label: "candidate",
      rng: mulberry32(11),
      metadata: metadataOf({
        provider: "anthropic_api:claude-sonnet-5",
        requestedModel: "sonnet",
        response: { ...skipped(""), error: "", modelServed: "m", contextWindow: 1_000_000 },
        endpoint: "https://api.anthropic.com",
        tokenSource: "anthropic_usage",
        observedAt: "2026-08-26T01:00:00.000Z",
      }),
    });

    const r = detector.compare(EVAL, before, after, FAST);

    out.push(
      check(
        "a metadata-only difference is not reported as drift",
        r.verdict !== "SUSPECTED_DRIFT" && r.verdict !== "CONFIRMED_DRIFT",
        `verdict=${r.verdict} reason=${r.reason}`,
      ),
    );
    out.push(check("and does not fail a build", exitCodeFor(r) === 0, `exit=${exitCodeFor(r)}`));
    // The other half, and the reason this is not satisfied by a detector that ignores metadata: the
    // change must still be VISIBLE. Silence here would be a different failure with the same verdict.
    out.push(
      check(
        "the endpoint change is still reported",
        r.metadataChanges.some((c) => c.field === "endpoint" && c.kind === "changed"),
        JSON.stringify(r.metadataChanges.map((c) => `${c.field}:${c.kind}`)),
      ),
    );
    out.push(
      check(
        "the token-source change is still reported",
        r.metadataChanges.some((c) => c.field === "tokenSource"),
        JSON.stringify(r.metadataChanges.map((c) => c.field)),
      ),
    );
    return out;
  },
};

export const ALL_SCENARIOS: readonly CalibrationScenario[] = [
  aaIsQuiet,
  largeDriftIsCaught,
  tinyDriftIsNotOverclaimed,
  latencyNeverGates,
  repeatedLooksDoNotManufactureAlarms,
  theWatcherStillFires,
  oneReplicateIsInconclusive,
  differentCorporaAreNotComparable,
  confirmationIsRequired,
  identityChangeIsReportedWithoutAPValue,
  spentSensitivityIsReported,
  metadataDriftIsNotQualityDrift,
];
