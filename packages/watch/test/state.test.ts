// What a running watch remembers between looks, and why every one of those memories is
// load-bearing.
//
// WHAT THIS FILE PREVENTS.
//
//   A WATCH SEEDED FROM NOTHING. `startEProcess` will happily accept 0 successes out of 0 trials:
//   the Wilson bound comes back NaN, the clamp inside turns that into a p0 of 0.5, and the result
//   is a confident bet against a rate nobody measured. A case whose every baseline replicate
//   errored must therefore get NO watch at all rather than a watch with an invented null in it, and
//   the only way to see the difference from outside is to count the e-processes. That is the first
//   test here.
//
//   A WATCH FILE THAT CHURNS IN VERSION CONTROL. The file is rewritten on every tick. A serializer
//   emitting keys in insertion order would produce a diff on every tick while nothing about the
//   watch moved, and a diff nobody can read is a diff nobody reads.
//
//   A WATCH FILE THAT LOSES ITS WEALTH ON THE ROUND TRIP. The e-process earns its any-time validity
//   by carrying wealth forward from every observation it has ever seen. A read that dropped a field
//   would silently restart the martingale, which is exactly the fixed-alpha test that fires once
//   every twenty hours under a perfect null, wearing the name of a watch that cannot.
//
//   A READER THAT ACCEPTS A FILE IT DOES NOT UNDERSTAND. A watch file is a durable artifact with no
//   migration path by design, and a file written by an older version is usually wrong in several
//   ways at once, so `readWatchFile` reports every problem rather than the first.
//
// No clock reaches this file. `initWatchFile` takes its instant as data, and the instant is written
// out in the assertions so two runs of this suite on different days agree.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ECONFIG,
  mulberry32,
  synthCases,
  synthEvalCases,
  synthSnapshot,
} from "@model-regression-sentinel/detect";
import type { RunSnapshot } from "@model-regression-sentinel/run";
import { canonicalJson } from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";
import { initWatchFile, readWatchFile, writeWatchFile } from "../src/state.js";

const CASES = synthCases(4, [1, 1, 0.9, 1]);
const EVAL_CASES = synthEvalCases(CASES);
const START = new Date("2026-08-26T00:00:00.000Z");
const BASELINE = synthSnapshot(CASES, { label: "baseline", replicates: 10, rng: mulberry32(1) });

const scratch = (): string => mkdtempSync(join(tmpdir(), "sentinel-watch-"));

/** The same baseline with one case's every call marked failed, so it has no gradable replicate. */
const withUngradableCase = (snapshot: RunSnapshot, caseId: string): RunSnapshot => ({
  ...snapshot,
  records: snapshot.records.map((r) =>
    r.caseId === caseId ? { ...r, response: { ...r.response, error: "SKIPPED: no key" } } : r,
  ),
});

describe("a watch is seeded from the baseline, one e-process per gradable case", () => {
  const file = initWatchFile({ snapshot: BASELINE, cases: EVAL_CASES, now: START });

  it("starts one e-process for every case the baseline actually graded", () => {
    expect(file.cases.map((c) => c.caseId)).toEqual([
      "syn-c-001",
      "syn-c-002",
      "syn-c-003",
      "syn-c-004",
    ]);
  });

  it("bets against a null it measured rather than one it assumed", () => {
    // p0 is the Wilson LOWER bound on the baseline pass rate, which is why it sits below 1 even for
    // a case that passed every draw. A watch pinned to the observed rate would alarm on the first
    // ordinary failure.
    for (const state of file.cases) {
      expect(state.p0, state.caseId).toBeGreaterThan(0);
      expect(state.p0, state.caseId).toBeLessThan(1);
      expect(state.observations, state.caseId).toBe(0);
      expect(state.logWealth, state.caseId).toBe(0);
      expect(state.alarmed, state.caseId).toBe(false);
    }
  });

  it("gives a case with no gradable replicate NO watch at all", () => {
    // THE test in this file. `startEProcess` would accept 0 of 0, the Wilson bound would come back
    // NaN and the clamp would turn it into a p0 of 0.5, which is a confident bet against a rate
    // nobody measured. Silence is the honest answer and the only visible difference is the count.
    const partial = initWatchFile({
      snapshot: withUngradableCase(BASELINE, "syn-c-002"),
      cases: EVAL_CASES,
      now: START,
    });
    expect(partial.cases.map((c) => c.caseId)).toEqual(["syn-c-001", "syn-c-003", "syn-c-004"]);
    expect(partial.cases.length).toBe(file.cases.length - 1);
  });

  it("pins the subject, so a tick against another corpus or alias can be refused", () => {
    expect(file.corpusDigest).toBe(BASELINE.corpusDigest);
    expect(file.requestedModel).toBe(BASELINE.requestedModel);
    expect(file.provider).toBe(BASELINE.provider);
    expect(file.fingerprintSha256).toBe(BASELINE.fingerprint?.sha256);
  });

  it("takes its instant as data rather than reading a clock", () => {
    expect(file.startedAt).toBe("2026-08-26T00:00:00.000Z");
    expect(file.lastTickAt).toBe("2026-08-26T00:00:00.000Z");
    expect(file.ticks).toBe(0);
  });

  it("opens with empty logs, because a first observation is not a change", () => {
    expect(file.identityAlerts).toEqual([]);
    expect(file.confirmations).toEqual([]);
  });

  it("records the config, so an alarm can say what it would have meant", () => {
    // A watcher tuned to catch a two point drop and one tuned to catch a thirty point drop are
    // different instruments, and the difference must never be silent.
    expect(file.config).toEqual(DEFAULT_ECONFIG);
    const tighter = initWatchFile({
      snapshot: BASELINE,
      cases: EVAL_CASES,
      now: START,
      config: { ...DEFAULT_ECONFIG, alternative: 0.02 },
    });
    expect(tighter.config.alternative).toBe(0.02);
    expect(tighter.cases[0]?.lambda).not.toBe(file.cases[0]?.lambda);
  });

  it("leaves the file empty when the baseline never reached the provider", () => {
    // Empty rather than a placeholder. A tick that then observes an identity adopts it silently,
    // because opening every watch with a false identity alert is how alerts get filtered.
    const blind: RunSnapshot = { ...BASELINE, fingerprint: null };
    expect(
      initWatchFile({ snapshot: blind, cases: EVAL_CASES, now: START }).fingerprintSha256,
    ).toBe("");
  });
});

describe("the watch file survives a round trip and is canonical on disk", () => {
  const file = initWatchFile({ snapshot: BASELINE, cases: EVAL_CASES, now: START });

  it("comes back as the file that went down", () => {
    // The wealth is the watch. A read that dropped a field would silently restart the martingale,
    // which is the fixed-alpha test wearing the name of a watch that cannot fire on repeated looks.
    const path = join(scratch(), "nested", "watch.json");
    writeWatchFile(path, file);
    expect(readWatchFile(path)).toEqual(file);
  });

  it("is written as canonicalJson, byte for byte, so a tick that changed nothing shows nothing", () => {
    const path = join(scratch(), "watch.json");
    writeWatchFile(path, file);
    expect(readFileSync(path, "utf8")).toBe(canonicalJson(file));
  });

  it("writes the same bytes twice for the same file, whatever order it was built in", () => {
    const a = join(scratch(), "watch.json");
    const b = join(scratch(), "watch.json");
    writeWatchFile(a, file);
    writeWatchFile(b, { ...file });
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
  });
});

describe("readWatchFile refuses a file it does not understand, in full", () => {
  it("rejects a schemaVersion other than 1", () => {
    const path = join(scratch(), "future.json");
    const file = initWatchFile({ snapshot: BASELINE, cases: EVAL_CASES, now: START });
    writeFileSync(path, canonicalJson({ ...file, schemaVersion: 2 }), "utf8");
    expect(() => readWatchFile(path)).toThrowError(/schemaVersion is 2/);
  });

  it("names every problem at once, because an old file is usually wrong several ways", () => {
    const path = join(scratch(), "broken.json");
    writeFileSync(
      path,
      canonicalJson({ schemaVersion: 1, corpusDigest: 7, ticks: "many" }),
      "utf8",
    );
    const message = (() => {
      try {
        readWatchFile(path);
        return "";
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    })();
    expect(message).toContain("corpusDigest is missing or is not a string");
    expect(message).toContain("cases is missing or is not an array");
    expect(message).toContain("ticks is missing or is not a number");
    // The one whose absence would make an alarm unreadable: without a config nothing can say what
    // the alarm would have meant.
    expect(message).toContain("config is missing");
  });

  it("rejects a file that is not JSON, and one that is JSON but not an object", () => {
    const dir = scratch();
    writeFileSync(join(dir, "notes.json"), "a note somebody left here", "utf8");
    expect(() => readWatchFile(join(dir, "notes.json"))).toThrowError(/is not JSON/);
    writeFileSync(join(dir, "list.json"), "[1, 2, 3]", "utf8");
    expect(() => readWatchFile(join(dir, "list.json"))).toThrowError(/is not a watch file object/);
  });
});
