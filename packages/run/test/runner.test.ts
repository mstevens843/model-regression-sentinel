// The runner, which had no test file at all.
//
// `runCorpus` is where money is spent and where a run either becomes an artifact or is lost, and
// nothing exercised it directly: `byok.test.ts` reaches it once, incidentally, to build a snapshot.
// So none of the following was covered - the concurrency bound, whether `errorCount` agrees with
// `records`, what a throwing provider does to the calls already paid for, or what a NaN option
// produces. Two of those turned out to be defects.

import { type EvalCase, caseId, promptId } from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";
import { runCorpus } from "../src/runner.js";
import {
  type CompletionRequest,
  type Provider,
  type ProviderResponse,
  skipped,
} from "../src/types.js";

const CASES: readonly EvalCase[] = ["a", "b", "c"].map((letter, i) => ({
  schemaVersion: 1,
  id: caseId(`obx-c-00${i + 1}`),
  split: "canary",
  archetype: "constrained_categorical",
  title: `case ${letter}`,
  promptId: promptId("terse-v1"),
  input: { user: `question ${letter}` },
  graders: [{ kind: "exact", expected: "HOLD" }],
  provenance: { origin: "original", note: "a fixture that exists only in memory" },
})) as unknown as readonly EvalCase[];

const ok = (text: string): ProviderResponse => ({
  ...skipped(""),
  text,
  inputTokens: 10,
  outputTokens: 3,
  apiMs: 1,
  clientMs: 1,
  wallMs: 1,
  modelServed: "test-model-1",
  canonicalModel: "test-model-1",
  stopReason: "end_turn",
  error: "",
});

/** A provider whose behaviour per call is scripted by index. */
const scripted = (
  fn: (n: number) => ProviderResponse | Promise<never>,
): Provider & {
  readonly peak: () => number;
} => {
  let n = 0;
  let live = 0;
  let peak = 0;
  return {
    name: "scripted",
    model: "test-model",
    available: () => ({ ok: true, reason: "" }),
    complete: async (_request: CompletionRequest): Promise<ProviderResponse> => {
      live += 1;
      peak = Math.max(peak, live);
      try {
        // A microtask boundary, so concurrency is observable at all.
        await Promise.resolve();
        return await Promise.resolve(fn(n++));
      } finally {
        live -= 1;
      }
    },
    peak: () => peak,
  };
};

describe("runCorpus", () => {
  it("records every replicate of every case, in a deterministic order", async () => {
    const p = scripted(() => ok("HOLD"));
    const snap = await runCorpus(p, CASES, ["canary"], { replicates: 4, concurrency: 2 });
    expect(snap.records).toHaveLength(12);
    expect(snap.caseIds).toEqual(["obx-c-001", "obx-c-002", "obx-c-003"]);
    // Sorted by id, so two runs of one corpus produce the same digest regardless of input order.
    const shuffled = await runCorpus(p, [...CASES].reverse(), ["canary"], {
      replicates: 4,
      concurrency: 2,
    });
    expect(shuffled.corpusDigest).toBe(snap.corpusDigest);
  });

  it("honours the concurrency bound", async () => {
    const p = scripted(() => ok("HOLD"));
    await runCorpus(p, CASES, ["canary"], { replicates: 5, concurrency: 3 });
    expect(p.peak()).toBeLessThanOrEqual(3);
  });

  it("keeps errorCount and records consistent", async () => {
    const p = scripted((n) => (n % 2 === 0 ? ok("HOLD") : { ...ok(""), error: "ECONNRESET" }));
    const snap = await runCorpus(p, CASES, ["canary"], { replicates: 4, concurrency: 1 });
    const errored = snap.records.filter((r) => r.response.error !== "").length;
    expect(snap.errorCount).toBe(errored);
    expect(snap.errorCount).toBeGreaterThan(0);
    expect(snap.errorCount).toBeLessThan(snap.records.length);
  });

  it("A THROWING PROVIDER COSTS ONE CALL, NOT THE WHOLE RUN", async () => {
    // The workers are joined by `Promise.all`, so a single rejection used to discard every record
    // collected so far - including hundreds of successful calls already paid for. A socket reset is
    // a condition every provider produces routinely, and `ReplayProvider` rejects deliberately, so
    // the hazard was live in-repo. An error is already a first-class outcome here; a throw is the
    // same event arriving through a different door.
    const p = scripted((n) => {
      if (n % 3 === 2) return Promise.reject(new Error("socket hang up"));
      return ok("HOLD");
    });
    const snap = await runCorpus(p, CASES, ["canary"], { replicates: 3, concurrency: 2 });
    expect(snap.records).toHaveLength(9);
    expect(snap.errorCount).toBeGreaterThan(0);
    expect(snap.errorCount).toBeLessThan(9);
    const thrown = snap.records.find((r) => r.response.error.startsWith("THREW:"));
    expect(thrown?.response.error, "the reason has to survive, not just the fact").toContain(
      "socket hang up",
    );
  });

  it("records the splits it was given rather than inventing one", async () => {
    // `run-study.mjs` used to stamp the literal "extended" on any multi-split run, so a fresh
    // 34-case baseline claimed on disk to be the 16-case extended split.
    const p = scripted(() => ok("HOLD"));
    const snap = await runCorpus(p, CASES, ["canary", "extended", "schema"], {
      replicates: 1,
      concurrency: 1,
    });
    expect(snap.splits).toEqual(["canary", "extended", "schema"]);
  });

  it("produces a snapshot whose every number is finite", async () => {
    // The serialization boundary this project has broken three times. `canonicalJson` refuses a
    // non-finite number, so an unchecked option reaching the record shape turns into a write that
    // throws long after the calls were paid for.
    const p = scripted(() => ok("HOLD"));
    const snap = await runCorpus(p, CASES, ["canary"], { replicates: 2, concurrency: 2 });
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "number") {
        expect(Number.isFinite(v), `${path} is ${String(v)}`).toBe(true);
        return;
      }
      if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
        return;
      }
      if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(snap, "snapshot");
  });
});
