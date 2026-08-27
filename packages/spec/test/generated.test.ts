// The negative controls for generated documentation, and for the wording that must never appear.
//
// Two failure modes, and neither is caught by anything else in this repository.
//
// A GENERATED BLOCK THAT HAS GONE STALE reads exactly like one that is current. Nothing about a
// markdown table announces that the artifact behind it moved three commits ago, and the number a
// reader quotes is always the one that went stale. `blocks:check` is the guard, and a guard that has
// never been shown to fail is decoration, so this file breaks a block on a COPY and requires the
// check to notice.
//
// FALSE FREEZE WORDING is the other. This project's central honesty claim is that its ordering proof
// is UNAVAILABLE rather than pending, and `verify:freeze` exits 1 by design. Prose drifts faster than
// code: it would be very easy for a document to end up saying the corpus is "verified" or "frozen at"
// a commit while `corpus/*/FREEZE.json` still records `null`. That sentence would be the single most
// misleading thing in the repository, so it is a test rather than a habit.

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BLOCKS = join(REPO, "scripts/generated-blocks.mjs");

const runCheck = (cwd: string): number =>
  spawnSync("node", [join(cwd, "scripts/generated-blocks.mjs"), "--check"], {
    cwd,
    encoding: "utf8",
  }).status ?? -1;

describe("generated blocks", () => {
  it("are current in this checkout", () => {
    expect(runCheck(REPO)).toBe(0);
  });

  it("the check FAILS on a stale block, which is what makes it a check", () => {
    // Done on a copy. Corrupting the real tree to prove a guard works would be a guard that
    // damages the thing it protects.
    const scratch = mkdtempSync(join(tmpdir(), "mrs-blocks-"));
    try {
      for (const entry of [
        "scripts",
        "docs",
        "corpus",
        "packages",
        "README.md",
        "RESULTS.md",
        "results",
      ]) {
        const from = join(REPO, entry);
        if (existsSync(from)) cpSync(from, join(scratch, entry), { recursive: true });
      }
      const target = join(scratch, "README.md");
      const text = readFileSync(target, "utf8");
      const marker = "<!-- GENERATED:freeze-status -->";
      expect(text, "the fixture must contain the block being staled").toContain(marker);
      writeFileSync(
        target,
        text.replace(marker, `${marker}\n\n| split | cases |\n|---|---|\n| totally | wrong |\n`),
      );
      expect(runCheck(scratch), "a staled block was reported as current").not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("names the file it found stale, so the message is actionable", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mrs-blocks2-"));
    try {
      for (const entry of [
        "scripts",
        "docs",
        "corpus",
        "packages",
        "README.md",
        "RESULTS.md",
        "results",
      ]) {
        const from = join(REPO, entry);
        if (existsSync(from)) cpSync(from, join(scratch, entry), { recursive: true });
      }
      const target = join(scratch, "docs/DETECTOR_CARD.md");
      const text = readFileSync(target, "utf8");
      writeFileSync(
        target,
        text.replace(
          "<!-- GENERATED:calibration-summary -->",
          "<!-- GENERATED:calibration-summary -->\nstale\n",
        ),
      );
      const r = spawnSync("node", [join(scratch, "scripts/generated-blocks.mjs"), "--check"], {
        cwd: scratch,
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("DETECTOR_CARD.md");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fails loudly when no block is found at all, rather than passing vacuously", () => {
    // A target list that stopped matching any file would otherwise report success while checking
    // nothing, which is the quiet way an enforcement script stops enforcing.
    const scratch = mkdtempSync(join(tmpdir(), "mrs-blocks3-"));
    try {
      cpSync(join(REPO, "scripts"), join(scratch, "scripts"), { recursive: true });
      cpSync(join(REPO, "corpus"), join(scratch, "corpus"), { recursive: true });
      cpSync(join(REPO, "packages"), join(scratch, "packages"), { recursive: true });
      const r = spawnSync("node", [join(scratch, "scripts/generated-blocks.mjs"), "--check"], {
        cwd: scratch,
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("no GENERATED blocks found");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("the writer is idempotent, so a second run is a no-op", () => {
    execFileSync("node", [BLOCKS], { cwd: REPO, encoding: "utf8" });
    expect(runCheck(REPO)).toBe(0);
  });
});

describe("the freeze wording cannot drift away from the freeze record", () => {
  const states = readdirSync(join(REPO, "corpus"))
    .filter((d) => existsSync(join(REPO, "corpus", d, "FREEZE.json")))
    .map((d) => ({
      split: d,
      record: JSON.parse(readFileSync(join(REPO, "corpus", d, "FREEZE.json"), "utf8")) as {
        readonly state: string;
        readonly frozenAtCommit: string | null;
      },
    }));

  it("sees the freeze records it is checking", () => {
    expect(states.length).toBeGreaterThanOrEqual(2);
  });

  it("records no cashed ordering proof, which is the state this repository is in", () => {
    for (const s of states) {
      expect(s.record.frozenAtCommit, `${s.split} records a commit`).toBeNull();
      expect(s.record.state, `${s.split} claims a state other than unavailable`).toBe(
        "unavailable",
      );
    }
  });

  it("`verify:freeze` exits 1, by design, and a passing run would mean the check was weakened", () => {
    // The inverted control. If this ever exits 0, either somebody cashed the freeze properly, in
    // which case this test should be updated deliberately, or the check was talked into agreeing.
    const r = spawnSync("bash", [join(REPO, "scripts/verify-freeze.sh")], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
  });

  it("no document claims the corpus is verified, cashed, or frozen at a commit", () => {
    // The wording that would make a reader believe a proof exists. Checked against prose, because
    // prose is where it would appear and prose is what nothing else validates.
    const forbidden: readonly RegExp[] = [
      /freeze[^.\n]{0,40}\bVERIFIED\b/i,
      /ordering proof[^.\n]{0,40}\b(cashed|established|proven|confirmed)\b/i,
      /frozen at commit [0-9a-f]{7,}/i,
      /the corpus (?:is|was) proven to predate/i,
    ];
    const docs: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", ".git", ".turbo"].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".md")) docs.push(full);
      }
    };
    walk(REPO);
    expect(docs.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(doc, "utf8");
      for (const pattern of forbidden) {
        const m = pattern.exec(text);
        if (m !== null) offenders.push(`${doc.slice(REPO.length)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the generated freeze block says UNAVAILABLE rather than implying a proof", () => {
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    const start = readme.indexOf("<!-- GENERATED:freeze-status -->");
    expect(start).toBeGreaterThan(-1);
    const block = readme.slice(start, readme.indexOf("<!-- /GENERATED -->", start));
    expect(block).toContain("unavailable");
    expect(block).toContain("exits 1 by design");
  });
});
