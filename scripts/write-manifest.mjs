// Write MANIFEST.sha256 for each frozen corpus split.
//
// THIS IS THE GAP THIS PROJECT CLOSES IN ITS SIBLING. `agent-context-containment` ships six
// MANIFEST.sha256 files and NO GENERATOR: they were produced by hand, off-repo, with an implied
// `shasum -a 256 corpus/holdout/*.json` and a manual deletion of the FREEZE.json line. That is a
// seam where a mistake leaves no trace, and it is the reason its STATUS.md has to track manifest
// regeneration as a human decision rather than a command anyone can re-run.
//
// WHAT THIS MUST NEVER BECOME is the command somebody runs to make a red check go green. Running it
// after a corpus edit is correct. Running it because `verify:corpus` failed is the single move that
// turns a working integrity check into decoration, and `verify-corpus.sh` says so at the moment of
// failure, in the sibling's own words.
//
// DELIBERATE DUPLICATION. The hashing here is `node:crypto` inline rather than an import from
// @model-regression-sentinel/spec, because this script has to run before anything is built - a
// manifest writer that needs `dist/` cannot be used on a fresh clone. The duplication is real and
// is pinned rather than left to drift: packages/spec/test/manifest.test.ts asserts that this
// script's output is byte-identical to what `buildManifest` and `renderManifest` produce.
//
// Usage: node scripts/write-manifest.mjs [--check]
//   --check  exit 1 if any manifest would change, and print which. Never writes.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECK = process.argv.includes("--check");

// Explicit, never a heuristic. A rule like "skip anything that is not an array" would also skip a
// genuinely malformed case file, which is exactly the failure the manifest exists to make loud.
// FREEZE.json is excluded so that recording or clearing a freeze never trips the drift check.
const SIDECARS = new Set(["FREEZE.json", "MANIFEST.sha256", "README.md"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const splits = readdirSync(join(ROOT, "corpus"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let changed = 0;
for (const split of splits) {
  const dir = join(ROOT, "corpus", split);
  const entries = readdirSync(dir)
    .filter((f) => !SIDECARS.has(f))
    .sort()
    .map((f) => ({ sha256: sha256(readFileSync(join(dir, f))), path: `corpus/${split}/${f}` }));

  // Sorted by path, two spaces, trailing newline. This is coreutils TEXT mode, which is what makes
  // `shasum -a 256 -c` from the repository root work with no tool from this project involved.
  const body =
    entries.map((e) => `${e.sha256}  ${e.path}`).join("\n") + (entries.length ? "\n" : "");
  const target = join(dir, "MANIFEST.sha256");
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";

  if (current === body) {
    console.log(`  unchanged  corpus/${split}/MANIFEST.sha256  (${entries.length} files)`);
    continue;
  }
  changed += 1;
  if (CHECK) {
    console.error(`  WOULD CHANGE  corpus/${split}/MANIFEST.sha256`);
    continue;
  }
  writeFileSync(target, body);
  console.log(`  written    corpus/${split}/MANIFEST.sha256  (${entries.length} files)`);
}

if (CHECK && changed > 0) {
  console.error("");
  console.error("A manifest is out of date with the corpus on disk.");
  console.error(
    "If you edited the corpus deliberately, run `pnpm write:manifest` and say so in RESULTS.md.",
  );
  console.error("If you did not, find out what wrote to the file before you regenerate anything.");
  process.exitCode = 1;
}
