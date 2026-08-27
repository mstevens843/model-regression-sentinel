// The v0.2 corpus: the third split, and the guards that keep it from becoming decoration.
//
// WHAT THIS FILE IS FOR, beyond validating ten more cases. A corpus grows by somebody adding a file,
// and the two ways that goes wrong are both quiet. The first is a case that looks like a case and
// grades nothing: a placeholder, a demo, a stub with an empty note, a `derived` provenance with a
// locator nobody could follow. The second is a case that changes the instrument without changing
// the evidence, which is what an edit to a frozen split would be.
//
// So this file asserts three separate things and they are not the same thing:
//
//   1. THE NEW SPLIT IS REAL. Ten structured_json cases, each with a declared schema, each naming
//      `schemaValid`, each attributed to a sibling file that exists. `schemaValid` is producible on
//      at least eight of them, which is the number the sign-flip test needs before an effect of any
//      size can reach significance on it. Below that threshold the metric is listed as gating and
//      cannot be checked, which is the defect this split exists to close.
//
//   2. NOTHING SYNTHETIC GOT IN. The corpus is scored as evidence about a real provider. A case
//      named `demo` or `placeholder` in it is not a small mess, it is a number in RESULTS.md that
//      nobody can attribute. The check is deliberately crude and deliberately repo-wide.
//
//   3. AN EDIT IS DETECTABLE. Both halves: a changed case has a different content hash, and
//      `checkManifest` reports it. Every mutation here happens on a COPY in a temp directory. The
//      real corpus is never written to by this file, and the manifest test that does corrupt a real
//      file restores it in a `finally`; this one avoids needing to.
//
// The v0.1 corpus digest, the single most important assertion in this pass, is NOT here. It needs
// `corpusDigestOf` from @model-regression-sentinel/run, and `run` depends on `spec`, so importing it
// here would make the workspace graph cyclic and `turbo run build` would refuse it. It lives in
// packages/run/test/corpusV1Digest.test.ts instead, where the import is legal. What this file pins
// is the membership that digest is taken over.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bytesHash, canonicalHash } from "../src/canonical.js";
import { checkCorpus, formatCorpusViolations, producibleSignals } from "../src/corpus.js";
import { loadCorpus, loadSplit, loadV1Corpus } from "../src/load.js";
import { SIDECARS, buildManifest, checkManifest } from "../src/manifest.js";
import { type EvalCase, SPLIT_INFIX } from "../src/types.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = join(REPO, "corpus");
const SCHEMA_DIR = join(ROOT, "schema");

/** Where the sibling projects sit, if this checkout is beside them. See the sourceTrace test. */
const SIBLINGS = dirname(REPO.replace(/\/$/, ""));

describe("the schema split", () => {
  const schema = loadSplit(SCHEMA_DIR, "schema");
  const all = loadCorpus(ROOT);

  it("validates, case by case and as part of the whole corpus", () => {
    expect(
      checkCorpus(schema, "split"),
      formatCorpusViolations(checkCorpus(schema, "split")),
    ).toEqual([]);
    expect(checkCorpus(all), formatCorpusViolations(checkCorpus(all))).toEqual([]);
  });

  it("holds ten structured_json cases, all on the decide-v1 prompt", () => {
    expect(schema.length).toBe(10);
    for (const c of schema) {
      expect(c.archetype, String(c.id)).toBe("structured_json");
      expect(String(c.promptId), String(c.id)).toBe("decide-v1");
      expect(c.split).toBe("schema");
      expect(String(c.id)).toContain(SPLIT_INFIX.schema);
    }
  });

  it("declares a schema and the two graders every case in it needs", () => {
    for (const c of schema) {
      expect(c.input.jsonSchema, `${String(c.id)} has no schema`).toBeDefined();
      const kinds = c.graders.map((g) => g.kind);
      expect(kinds, String(c.id)).toContain("jsonSchema");
      expect(kinds, String(c.id)).toContain("nonRefusal");
      expect(c.requiredSignals, String(c.id)).toContain("schemaValid");
    }
  });

  it("makes schemaValid producible on enough cases for the permutation test to resolve anything", () => {
    // THE POINT OF THE SPLIT. The confirmatory test is a paired sign-flip permutation over CASES,
    // so k cases give 2^k sign assignments and a smallest attainable two-sided p of 2 / 2^k. At
    // k = 2, that is 0.5 and no effect of any size can ever be significant, so `schemaValid` was a
    // gating metric that could not be checked and every comparison answered INCONCLUSIVE. At k = 8
    // it is 2/256, which clears alpha with room to spare.
    const producible = all.filter((c) => producibleSignals(c).has("schemaValid"));
    expect(producible.length).toBeGreaterThanOrEqual(8);
    expect(2 / 2 ** producible.length).toBeLessThan(0.05);
  });

  it("counts what it cannot see, and does not declare every case out of scope", () => {
    const limited = schema.filter((c) => c.detectionLimit !== null);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited.length).toBeLessThan(schema.length);
    for (const c of limited) expect((c.detectionLimit as string).length).toBeGreaterThan(40);
  });

  it("keeps at least one case whose correct answer is not caution", () => {
    // The sibling's anti-vacuity rule: every "must not" needs a "must" beside it. A split made only
    // of cases where refusing is right would be passed by a model that had become uselessly
    // cautious, and would report that as no drift.
    const allowing = schema.filter((c) =>
      c.graders.some((g) => g.kind === "regex" && g.pattern.includes("ALLOW")),
    );
    expect(allowing.length).toBeGreaterThan(0);
  });
});

describe("nothing synthetic can enter the corpus quietly", () => {
  const all = loadCorpus(ROOT);

  it("has no case id that names itself a stand-in", () => {
    // Crude on purpose, and repo-wide rather than schema-only. A case called `demo` or `placeholder`
    // in a corpus that is scored as evidence about a real provider is a number in RESULTS.md nobody
    // can attribute, which is worse than a missing number.
    const banned = ["synthetic", "demo", "test", "example", "placeholder", "todo"];
    const offenders = all
      .map((c) => String(c.id))
      .filter((id) => banned.some((word) => id.toLowerCase().includes(word)));
    expect(offenders).toEqual([]);
  });

  it("gives every case a non-empty note, because a case nobody argued for is decoration", () => {
    for (const c of all) {
      expect(c.note.trim().length, `${String(c.id)} has an empty note`).toBeGreaterThan(0);
      expect(c.title.trim().length, `${String(c.id)} has an empty title`).toBeGreaterThan(0);
    }
  });

  it("gives every case a provenance that is original, or derived with a real locator", () => {
    for (const c of all) {
      if (c.provenance.kind === "original") continue;
      expect(c.provenance.kind).toBe("derived");
      expect(c.provenance.ref.trim().length, `${String(c.id)} has no locator`).toBeGreaterThan(10);
      expect(
        c.provenance.modifications.trim().length,
        `${String(c.id)} says nothing about what changed`,
      ).toBeGreaterThan(40);
    }
  });
});

describe("sourceTrace", () => {
  const schema = loadSplit(SCHEMA_DIR, "schema");
  const frozen = loadV1Corpus(ROOT);

  it("is present on every new case and on none of the frozen 24", () => {
    // The optional-fields-only rule made literal. Retrofitting it onto the frozen 24 would rewrite
    // bytes that four recorded runs are hashed over.
    for (const c of schema) expect(c.sourceTrace, String(c.id)).toBeDefined();
    for (const c of frozen) expect(c.sourceTrace, String(c.id)).toBeUndefined();
  });

  it("carries four non-empty fields, so it can be followed rather than merely read", () => {
    for (const c of schema) {
      const trace = c.sourceTrace as NonNullable<EvalCase["sourceTrace"]>;
      expect(trace.repo.trim().length, String(c.id)).toBeGreaterThan(0);
      expect(trace.path.trim().length, String(c.id)).toBeGreaterThan(0);
      expect(trace.symbol.trim().length, String(c.id)).toBeGreaterThan(0);
      expect(trace.carried.trim().length, String(c.id)).toBeGreaterThan(40);
      // A path, not a sentence about a path. This is the whole difference from `provenance.ref`.
      expect(trace.path, String(c.id)).not.toContain(" ");
      expect(trace.path.startsWith("/"), String(c.id)).toBe(false);
    }
  });

  it("names a file that exists, when the sibling checkouts are beside this one", () => {
    // COUPLED TO ANOTHER REPOSITORY'S LAYOUT ON PURPOSE, AND ONLY WHEN IT IS THERE. A locator that
    // has never been resolved is a locator nobody has checked, and the field exists precisely so it
    // can be. But this package is published, and a stranger's clone has no siblings beside it, so
    // the check degrades to the shape assertions above rather than failing. The shape is asserted
    // unconditionally in the test before this one; this one is the stronger check where it is
    // available. If it starts failing, the sibling moved the file: update the trace, do not delete
    // the test.
    const available = schema.filter((c) =>
      existsSync(join(SIBLINGS, (c.sourceTrace as NonNullable<EvalCase["sourceTrace"]>).repo)),
    );
    if (available.length === 0) return;
    const missing = available
      .map((c) => c.sourceTrace as NonNullable<EvalCase["sourceTrace"]>)
      .filter((t) => !existsSync(join(SIBLINGS, t.repo, t.path)))
      .map((t) => `${t.repo}/${t.path}`);
    expect(missing).toEqual([]);
  });
});

describe("an edit to a case is detectable, both ways", () => {
  /** Copy the real corpus somewhere writable. Nothing in this file writes to `corpus/`. */
  const scratchCorpus = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "mrs-corpus-v2-"));
    cpSync(ROOT, join(dir, "corpus"), { recursive: true });
    return join(dir, "corpus");
  };

  it("changes the case's content hash", () => {
    const copy = scratchCorpus();
    try {
      const before = loadSplit(join(copy, "schema"), "schema");
      const target = before.find((c) => String(c.id) === "obx-s-001") as EvalCase;
      const hashBefore = canonicalHash(target);

      // One character in one prompt. The kind of edit that reads as a typo fix and silently makes
      // every recorded run answer a different question.
      const file = join(copy, "schema", "outbox.json");
      const text = readFileSync(file, "utf8");
      writeFileSync(
        file,
        text.replace("has now been attempted twice", "has now been attempted 2x"),
      );

      const after = loadSplit(join(copy, "schema"), "schema");
      const edited = after.find((c) => String(c.id) === "obx-s-001") as EvalCase;
      expect(canonicalHash(edited)).not.toBe(hashBefore);

      // And every other case in the split is untouched, so the hash is a property of the case and
      // not of the file it happens to share.
      const untouched = after.find((c) => String(c.id) === "obx-s-004") as EvalCase;
      const original = before.find((c) => String(c.id) === "obx-s-004") as EvalCase;
      expect(canonicalHash(untouched)).toBe(canonicalHash(original));
    } finally {
      rmSync(dirname(copy), { recursive: true, force: true });
    }
  });

  it("makes checkManifest report the file as changed rather than as ok", () => {
    const copy = scratchCorpus();
    try {
      const dir = join(copy, "schema");
      const files = readdirSync(dir)
        .filter((f) => !SIDECARS.has(f))
        .sort()
        .map((f) => join(dir, f));
      const entries = buildManifest(files);

      const clean = checkManifest(entries, files, (p) => readFileSync(p));
      expect(clean.ok, "a freshly built manifest did not match the files it was built from").toBe(
        true,
      );

      // A whitespace-only edit. The content survives it and the bytes do not, and both of those are
      // claims worth making separately: the sibling records a `biome check --fix` doing exactly this
      // to three frozen holdout files.
      const target = join(dir, "risk.json");
      writeFileSync(target, `${readFileSync(target, "utf8")} `);

      const dirty = checkManifest(entries, files, (p) => readFileSync(p));
      expect(dirty.ok).toBe(false);
      expect(dirty.checks.find((c) => c.path === target)?.status).toBe("changed");
      expect(dirty.checks.filter((c) => c.status === "ok").length).toBe(files.length - 1);
    } finally {
      rmSync(dirname(copy), { recursive: true, force: true });
    }
  });

  it("makes an added file untracked, because an addition changes the instrument too", () => {
    const copy = scratchCorpus();
    try {
      const dir = join(copy, "schema");
      const files = readdirSync(dir)
        .filter((f) => !SIDECARS.has(f))
        .sort()
        .map((f) => join(dir, f));
      const entries = buildManifest(files);
      const added = join(dir, "extra.json");
      writeFileSync(added, "[]\n");
      const result = checkManifest(entries, [...files, added], (p) => readFileSync(p));
      expect(result.ok).toBe(false);
      expect(result.untracked).toEqual([added]);
    } finally {
      rmSync(dirname(copy), { recursive: true, force: true });
    }
  });

  it("agrees with the shipped manifest for the schema split, byte for byte", () => {
    const dir = SCHEMA_DIR;
    const files = readdirSync(dir)
      .filter((f) => !SIDECARS.has(f))
      .sort()
      .map((f) => join(dir, f));
    const entries = buildManifest(files).map((e) => ({ ...e, path: e.path.slice(REPO.length) }));
    const shipped = readFileSync(join(dir, "MANIFEST.sha256"), "utf8");
    for (const entry of entries) {
      expect(shipped, `${entry.path} is not covered`).toContain(`${entry.sha256}  ${entry.path}`);
    }
    expect(bytesHash(readFileSync(join(dir, "outbox.json"))).length).toBe(64);
  });
});

describe("the generated composition table", () => {
  it("is current, so docs/CORPUS.md cannot quietly describe a corpus that is gone", () => {
    // The failure this prevents is real and already happened once at a smaller scale: CALIBRATION.md
    // states "schemaValid exists on only two cases", which was true when it was written. A number a
    // reader will not re-count has to be generated or it will eventually be wrong.
    let code = 0;
    try {
      execFileSync("node", [join(REPO, "scripts/case-composition.mjs"), "--check"], {
        cwd: REPO,
        stdio: "pipe",
      });
    } catch (cause) {
      code = (cause as { status?: number }).status ?? 1;
    }
    expect(code, "docs/CORPUS.md is stale; run `pnpm docs:composition`").toBe(0);
  });
});
