// The manifest, and the pin that keeps its two implementations from drifting apart.
//
// `scripts/write-manifest.mjs` hashes with `node:crypto` inline rather than importing this package,
// because a manifest writer that needs `dist/` cannot be used on a fresh clone. That duplication is
// real, and the sibling project's equivalent problem - two ECE implementations kept in sync only by
// intent - is solved there by a test asserting they agree. The same move is made here: the script's
// output must be byte-identical to what `buildManifest` and `renderManifest` produce, over the real
// corpus.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bytesHash } from "../src/canonical.js";
import {
  SIDECARS,
  buildManifest,
  checkManifest,
  parseManifest,
  renderManifest,
} from "../src/manifest.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

describe("MANIFEST.sha256", () => {
  it("uses the exact line format the sibling uses, so plain shasum -c reads it", () => {
    const text = readFileSync(join(REPO, "corpus/canary/MANIFEST.sha256"), "utf8");
    for (const line of text.split("\n").filter((l) => l !== "")) {
      // 64 lowercase hex, exactly two spaces, a repo-root-relative POSIX path.
      expect(line).toMatch(/^[0-9a-f]{64} {2}corpus\/[a-z_]+\/[A-Za-z0-9_.-]+$/);
    }
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("is sorted by path, so a diff shows a content change rather than a reordering", () => {
    const { entries } = parseManifest(
      readFileSync(join(REPO, "corpus/extended/MANIFEST.sha256"), "utf8"),
    );
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("excludes FREEZE.json, so recording a freeze never trips the drift check", () => {
    for (const split of ["canary", "extended", "schema"]) {
      const text = readFileSync(join(REPO, `corpus/${split}/MANIFEST.sha256`), "utf8");
      expect(text).not.toContain("FREEZE.json");
      expect(SIDECARS.has("FREEZE.json")).toBe(true);
    }
  });

  it("matches what the standalone script writes, byte for byte", () => {
    // THE PIN. If these ever disagree, one of the two is wrong and nothing else would say so.
    for (const split of ["canary", "extended", "schema"]) {
      const dir = join(REPO, "corpus", split);
      const files = readdirSync(dir)
        .filter((f) => !SIDECARS.has(f))
        .sort()
        .map((f) => join(dir, f));
      const fromLibrary = renderManifest(
        buildManifest(files).map((e) => ({ ...e, path: e.path.slice(REPO.length) })),
      );
      const fromScript = readFileSync(join(dir, "MANIFEST.sha256"), "utf8");
      expect(
        fromLibrary,
        `${split} disagrees between the library and scripts/write-manifest.mjs`,
      ).toBe(fromScript);
    }
  });

  it("the script's --check mode fails on a corpus edit and says so", () => {
    // A negative control for the writer itself. The check that only ever passes proves nothing.
    const scratch = mkdtempSync(join(tmpdir(), "mrs-manifest-"));
    try {
      const target = join(REPO, "corpus/canary/outbox.json");
      const original = readFileSync(target);
      writeFileSync(join(scratch, "backup.json"), original);
      writeFileSync(target, Buffer.concat([original, Buffer.from(" ")]));
      let code = 0;
      try {
        execFileSync("node", [join(REPO, "scripts/write-manifest.mjs"), "--check"], {
          cwd: REPO,
          stdio: "pipe",
        });
      } catch (cause) {
        code = (cause as { status?: number }).status ?? 1;
      }
      writeFileSync(target, original);
      expect(code, "a corpus edit did not make --check fail").not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports a changed file, a missing file and an untracked file separately", () => {
    // Three different problems that a single boolean would flatten into one.
    const entries = [
      { sha256: bytesHash("a"), path: "a.json" },
      { sha256: bytesHash("b"), path: "b.json" },
    ];
    const result = checkManifest(entries, ["a.json", "b.json", "c.json"], (p) =>
      p === "a.json" ? "a" : p === "b.json" ? "CHANGED" : null,
    );
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.path === "a.json")?.status).toBe("ok");
    expect(result.checks.find((c) => c.path === "b.json")?.status).toBe("changed");
    expect(result.untracked).toEqual(["c.json"]);
  });

  it("treats an added file as drift, because an addition changes the instrument too", () => {
    const entries = [{ sha256: bytesHash("a"), path: "a.json" }];
    expect(checkManifest(entries, ["a.json", "new.json"], () => "a").ok).toBe(false);
  });

  it("reports a malformed line rather than skipping it", () => {
    // A line nobody parsed checks nothing, and silently skipping it is how a manifest quietly stops
    // covering a file.
    const { entries, malformed } = parseManifest("not a manifest line\n");
    expect(entries).toEqual([]);
    expect(malformed.length).toBe(1);
  });
});
