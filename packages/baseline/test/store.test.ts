// The snapshot store, and the one property the whole archive rests on: THE BYTES ON DISK ARE THE
// BYTES THAT WERE HASHED.
//
// WHAT THIS FILE PREVENTS. `store.ts` makes a promise that is easy to state and easy to break by
// accident: a snapshot is serialized through `canonicalJson` exactly once, and `snapshotDigest`
// hashes that same string. The obvious refactor - `writeFileSync(path, JSON.stringify(snapshot))`
// because it reads more naturally, or a digest taken over the object by a second route - keeps
// every round trip working and silently detaches the digest from the file. Nothing downstream
// notices until two people compare digests of the same run and disagree, at which point the digest
// has already been decoration for months. So the round trip is asserted AND the exact byte equality
// is asserted, because the first one passes under the broken version.
//
// THE KEY ORDER TEST IS THE OTHER HALF OF THE SAME ARGUMENT, and it carries its own negative
// control: the reordered object is checked to actually have moved its keys under `JSON.stringify`
// before the digest is asserted to be unchanged. Without that check, a `reorder` helper that
// quietly returned its input would make the test pass while proving nothing.
//
// `listSnapshots` is tested against a directory that also holds things that are not snapshots,
// because that is the only kind of directory it will ever be pointed at. A lister that dies on a
// stray README is a lister nobody uses on a real baseline directory, and a lister that silently
// returns nothing is worse.

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderResponse, type RunSnapshot, skipped } from "@model-regression-sentinel/run";
import { canonicalJson } from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";
import { listSnapshots, readSnapshot, snapshotDigest, writeSnapshot } from "../src/store.js";

/**
 * One successful call.
 *
 * Built from `skipped("")` so the twenty-odd zeroed fields are named once, by the package that owns
 * them, rather than copied into a fixture that goes stale the day a field is added.
 */
const ok = (text: string): ProviderResponse => ({ ...skipped(""), error: "", text });

function snapshot(label: string, capturedAt: string): RunSnapshot {
  return {
    schemaVersion: 1,
    label,
    capturedAt,
    provider: "fixture",
    requestedModel: "fixture-alias",
    split: "canary",
    replicates: 2,
    concurrency: 1,
    caseIds: ["cse-c-001"],
    corpusDigest: "digest-of-the-rendered-corpus",
    fingerprint: {
      requestedModel: "fixture-alias",
      resolvedModel: "fixture-model-1",
      canonicalModel: "fixture-model-1",
      provider: "fixture",
      contextWindow: 200000,
      maxOutputTokens: 64000,
      costBasis: "list",
      serviceTier: "standard",
      sha256: "fp-fixture-model-1",
    },
    records: [
      {
        caseId: "cse-c-001",
        replicate: 0,
        promptId: "terse-v1",
        promptSha256: "p",
        requestSha256: "r",
        response: ok("ALLOW"),
      },
      {
        caseId: "cse-c-001",
        replicate: 1,
        promptId: "terse-v1",
        promptSha256: "p",
        requestSha256: "r",
        response: ok("DENY"),
      },
    ],
    errorCount: 0,
    cost: {
      model: "fixture-model-1",
      n: 2,
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

const scratch = (): string => mkdtempSync(join(tmpdir(), "sentinel-store-"));

/** Rebuilds an object with its keys reversed. Same content, different insertion order. */
const reorder = <T extends object>(value: T): T =>
  Object.fromEntries([...Object.entries(value)].reverse()) as T;

describe("a stored snapshot is exactly the bytes that were hashed", () => {
  it("comes back from disk as the same snapshot it went down as", () => {
    const dir = scratch();
    const original = snapshot("baseline", "2026-08-26T00:00:00.000Z");
    const path = writeSnapshot(dir, original);
    expect(readSnapshot(path)).toEqual(original);
  });

  it("writes the canonical form itself, so nothing has to serialize a snapshot twice", () => {
    // The property that makes the digest mean anything. A writer that used JSON.stringify would
    // still pass the round trip above and would already have broken the digest.
    const dir = scratch();
    const original = snapshot("baseline", "2026-08-26T00:00:00.000Z");
    const path = writeSnapshot(dir, original);
    expect(readFileSync(path, "utf8")).toBe(canonicalJson(original));
  });

  it("names the file so a sorted listing reads as a timeline, without joining on the name", () => {
    const dir = scratch();
    const path = writeSnapshot(dir, snapshot("night run", "2026-08-26T00:00:00.000Z"));
    expect(path.endsWith(join("night-run-2026-08-26T00-00-00-000Z.json"))).toBe(true);
  });

  it("keeps the digest still when only the key insertion order moved", () => {
    // A digest that moves when the content did not is worse than no digest: the first false alarm
    // teaches everyone to regenerate it, and after that nobody reads it.
    const original = snapshot("baseline", "2026-08-26T00:00:00.000Z");
    const shuffledKeys = reorder(original);
    // The negative control. If `reorder` ever stopped reordering, the assertion below would be
    // comparing an object with itself and would prove nothing at all.
    expect(JSON.stringify(shuffledKeys)).not.toBe(JSON.stringify(original));
    expect(snapshotDigest(shuffledKeys)).toBe(snapshotDigest(original));
  });

  it("moves the digest when a single recorded value moved", () => {
    // The other half of a content hash's contract, and the half a sorted serializer cannot give you
    // for free. Stability alone is satisfied by a constant.
    const original = snapshot("baseline", "2026-08-26T00:00:00.000Z");
    const edited: RunSnapshot = { ...original, errorCount: 1 };
    expect(snapshotDigest(edited)).not.toBe(snapshotDigest(original));
  });
});

describe("readSnapshot refuses a file it does not understand", () => {
  it("rejects a schemaVersion other than 1, because a snapshot has no migration path by design", () => {
    const dir = scratch();
    const path = join(dir, "future.json");
    writeFileSync(
      path,
      canonicalJson({ ...snapshot("future", "2026-08-26T00:00:00.000Z"), schemaVersion: 2 }),
      "utf8",
    );
    expect(() => readSnapshot(path)).toThrowError(/schemaVersion is 2/);
  });

  it("reports every problem it found rather than the first, so one round trip fixes the file", () => {
    const dir = scratch();
    const path = join(dir, "broken.json");
    writeFileSync(path, canonicalJson({ schemaVersion: 2, label: 7, records: "no" }), "utf8");
    const message = (() => {
      try {
        readSnapshot(path);
        return "";
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    })();
    expect(message).toContain("schemaVersion is 2");
    expect(message).toContain("label is missing or is not a string");
    expect(message).toContain("records is missing or is not an array");
  });

  it("rejects a file that is not JSON at all", () => {
    const dir = scratch();
    const path = join(dir, "notes.json");
    writeFileSync(path, "this is a note somebody left here", "utf8");
    expect(() => readSnapshot(path)).toThrowError(/is not JSON/);
  });
});

describe("listSnapshots reads a real directory, which holds more than snapshots", () => {
  it("returns newest first and skips what is not a snapshot", () => {
    const dir = scratch();
    writeSnapshot(dir, snapshot("first", "2026-08-01T00:00:00.000Z"));
    writeSnapshot(dir, snapshot("middle", "2026-08-15T00:00:00.000Z"));
    writeSnapshot(dir, snapshot("latest", "2026-08-20T00:00:00.000Z"));
    // Valid JSON, and not a snapshot. This is the file that makes a naive lister throw.
    writeFileSync(
      join(dir, "notes.json"),
      canonicalJson({ note: "re-collect after the outage" }),
      "utf8",
    );
    writeFileSync(join(dir, "README.md"), "baselines live here\n", "utf8");

    const entries = listSnapshots(dir);
    // Proof the lister saw more than it returned, so an empty skip list means clean and not blind.
    expect(readdirSync(dir).length).toBe(5);
    expect(entries.map((e) => e.label)).toEqual(["latest", "middle", "first"]);
    expect(entries.map((e) => e.capturedAt)).toEqual([
      "2026-08-20T00:00:00.000Z",
      "2026-08-15T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
  });

  it("carries enough of each row to choose a baseline without opening the file", () => {
    const dir = scratch();
    writeSnapshot(dir, snapshot("only", "2026-08-20T00:00:00.000Z"));
    const entry = listSnapshots(dir)[0];
    expect(entry).toBeDefined();
    expect(entry?.requestedModel).toBe("fixture-alias");
    expect(entry?.split).toBe("canary");
    expect(entry?.replicates).toBe(2);
  });

  it("returns nothing rather than throwing when the directory does not exist", () => {
    expect(listSnapshots(join(scratch(), "never-created"))).toEqual([]);
  });
});
