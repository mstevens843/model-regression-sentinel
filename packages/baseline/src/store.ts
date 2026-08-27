// Persisting a run as a reference, and the rule about which bytes carry the digest.
//
// A BASELINE STORES RAW OUTPUTS, NOT SCORES, and that decision is inherited from
// `packages/run` rather than re-argued here: a snapshot keeps the text the model produced so a
// later analysis can ask a question nobody thought of on the day it was collected. The A/A
// false-positive study, the injected-drift power curve and every future grader fix all re-read old
// outputs. An archive of verdicts answers exactly one question forever, and it answers it with
// whatever the parser believed at collection time, which is how the sibling shipped a whole release
// scoring refusals as confident answers.
//
// WHY CANONICAL JSON HERE, AND RAW BYTES FOR THE CORPUS. These are two different artifacts and they
// get two different rules. The corpus is hand authored, so `shasum -a 256 -c` must interoperate with
// it and the digest must cover precisely the bytes a reader would open. A snapshot is GENERATED: a
// program builds an object and serializes it, and `JSON.stringify` emits keys in insertion order.
// Rebuild the same logical snapshot with two fields swapped and the bytes move while nothing about
// the run did. A DIGEST THAT MOVES WHEN THE CONTENT DID NOT IS WORSE THAN NO DIGEST, because the
// first false alarm teaches everyone to regenerate it, and after that the digest is decoration. So
// every snapshot goes out through `canonicalJson`: keys sorted at every depth, two space indent, one
// trailing newline, and `snapshotDigest` hashes that same string.
//
// THE FILENAME IS NOT THE IDENTITY. It is `<label>-<capturedAt>.json` because a directory of
// baselines is read by people during an incident and a sorted listing that reads as a timeline is
// worth the redundancy. Nothing joins on it. `label` is free text and free text is not a filename,
// so both halves are slugged, and two runs collected in the same millisecond under the same label
// collide on purpose rather than being silently disambiguated into two files nobody can tell apart.
//
// WHAT THIS IS NOT: an index, a database, or a garbage collector. It does not prune, it does not
// migrate, and `listSnapshots` reads every file rather than trusting a cached summary. A store that
// maintains its own index has two copies of the truth and no way to notice when they disagree.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSnapshot } from "@model-regression-sentinel/run";
import {
  SentinelError,
  canonicalHash,
  canonicalJson,
  parseJson,
} from "@model-regression-sentinel/spec";

/** One row of a directory listing. Enough to choose a baseline without opening every file. */
export interface SnapshotEntry {
  readonly path: string;
  readonly label: string;
  readonly capturedAt: string;
  readonly requestedModel: string;
  readonly split: string;
  readonly replicates: number;
}

/**
 * Write a snapshot and return the path it landed at.
 *
 * The directory is created if it is absent, because a baseline store is a place a user names in a
 * flag and being told the directory does not exist is a worse first run than having it appear.
 */
export function writeSnapshot(dir: string, snapshot: RunSnapshot): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug(snapshot.label)}-${slug(snapshot.capturedAt)}.json`);
  // Not `writeFileSync` with an object: the canonical string IS the artifact, and it is the exact
  // string `snapshotDigest` hashes. Serializing twice by two routes is how the two drift apart.
  writeFileSync(path, canonicalJson(snapshot), "utf8");
  return path;
}

/**
 * Read a snapshot back, validated.
 *
 * Throws rather than returning a partial value, and reports EVERY problem it found rather than the
 * first. Those two are not in tension: `checkCorpus` and friends enumerate because their job is to
 * describe a document, while this is a constructor whose postcondition is a usable snapshot, and
 * handing back half a snapshot would let a comparison run over whichever records happened to parse.
 * The enumeration still matters, because a file written by an older version is usually wrong in
 * several ways at once and one round trip per problem is a bad afternoon.
 */
export function readSnapshot(path: string): RunSnapshot {
  const parsed = parseJson(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    throw new SentinelError("corpus_invalid", `${path} is not JSON: ${parsed.error}`);
  }

  const problems: string[] = [];
  const body = parsed.value;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new SentinelError("corpus_invalid", `${path} is not a snapshot object`);
  }

  const record = body as { readonly [key: string]: unknown };
  if (record.schemaVersion !== 1) {
    problems.push(
      `schemaVersion is ${String(record.schemaVersion)} and this reader only understands 1; a snapshot is a frozen artifact and there is no migration path by design`,
    );
  }
  const required = ["label", "capturedAt", "provider", "requestedModel", "corpusDigest"] as const;
  for (const field of required) {
    if (typeof record[field] !== "string") problems.push(`${field} is missing or is not a string`);
  }
  if (!Array.isArray(record.records)) problems.push("records is missing or is not an array");
  if (typeof record.replicates !== "number") {
    problems.push("replicates is missing or is not a number");
  }

  // errorCount IS LOAD-BEARING AND WAS NOT CHECKED. `sentinel run` decides whether a collection was
  // a look at the provider at all by comparing it against `records.length`, and `undefined === n` is
  // simply false - so a snapshot missing the field described a run in which every call failed and
  // was accepted as a good baseline, silently, by the one comparison that exists to catch that.
  if (typeof record.errorCount !== "number" || !Number.isFinite(record.errorCount)) {
    problems.push("errorCount is missing or is not a finite number");
  } else if (Array.isArray(record.records) && record.errorCount > record.records.length) {
    problems.push(
      `errorCount is ${record.errorCount} against ${record.records.length} record(s), which cannot be true of any run`,
    );
  }

  if (problems.length > 0) {
    throw new SentinelError(
      "corpus_invalid",
      `${path} is not a usable snapshot:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
  }

  // NORMALISE THE PROVENANCE FIELD RATHER THAN TEACHING EVERY READER ABOUT BOTH SHAPES. Snapshots
  // collected before `splits` existed - including the four paid-for arms in results/runs/ - carry a
  // single `split` string. Reading is the one place that knows about the old shape, so it is the one
  // place that should, and a reader downstream can treat `splits` as always present.
  const normalised =
    Array.isArray(record.splits) || typeof record.split !== "string"
      ? body
      : { ...record, splits: [record.split] };

  return normalised as unknown as RunSnapshot;
}

/**
 * Every snapshot in a directory, newest first.
 *
 * A file that is not a snapshot is SKIPPED rather than raised, because a baseline directory is a
 * place people also leave notes, reports and half a download, and a lister that dies on a stray
 * README is a lister nobody points at a real directory. A file that claims to be a snapshot and is
 * not is a different matter, and `readSnapshot` on it will say so in full.
 *
 * Sorted by `capturedAt` descending with the path as the tiebreak, so the order is total and two
 * listings of the same directory read identically.
 */
export function listSnapshots(dir: string): readonly SnapshotEntry[] {
  let names: readonly string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }

  const out: SnapshotEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const parsed = parseJson(readFileSync(path, "utf8"));
    if (!parsed.ok) continue;
    const body = parsed.value;
    if (body === null || typeof body !== "object" || Array.isArray(body)) continue;
    const record = body as { readonly [key: string]: unknown };
    if (record.schemaVersion !== 1 || typeof record.capturedAt !== "string") continue;
    out.push({
      path,
      label: text(record.label),
      capturedAt: record.capturedAt,
      requestedModel: text(record.requestedModel),
      split: Array.isArray(record.splits)
        ? record.splits.map((x) => text(x)).join("+")
        : text(record.split),
      replicates: typeof record.replicates === "number" ? record.replicates : 0,
    });
  }

  return out.sort((a, b) => {
    if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/**
 * The content digest of a snapshot.
 *
 * Over the canonical form, so it is stable under a rebuild that reorders keys and unstable under
 * any change to what was actually recorded. That is the only pair of properties a content hash on a
 * generated artifact is allowed to have.
 */
export const snapshotDigest = (snapshot: RunSnapshot): string => canonicalHash(snapshot);

// A listing row is best effort about everything except the fields it filtered on: a snapshot missing
// its label is still a snapshot, and dropping the row would hide it from a person looking for it.
const text = (value: unknown): string => (typeof value === "string" ? value : "");

// A label and a timestamp are free text and a filename is not. Everything outside the ASCII
// alphanumerics collapses to a hyphen, which turns `2026-08-26T00:00:00.000Z` into
// `2026-08-26T00-00-00-000Z` and leaves it lexicographically sortable, which is the whole point.
function slug(value: string): string {
  const cleaned = value.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "unlabelled" : cleaned;
}
