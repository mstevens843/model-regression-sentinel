// Generate the case-composition table in docs/CORPUS.md, and fail CI when it is stale.
//
// WHY A GENERATOR RATHER THAN A HAND-WRITTEN TABLE. A composition table is a claim about the
// corpus, and a claim that is maintained by hand is a claim that goes wrong silently. This project
// already has a worked example of what that costs: `results/CALIBRATION.md` recorded, correctly at
// the time, that `schemaValid` exists on only two cases and that the suite therefore cannot reach
// NO_DRIFT. Two cases is precisely the sort of number a reader will not re-count, and precisely the
// sort that becomes false the moment somebody adds a split. So the count is derived from the corpus
// on every run, and `--check` fails when the file and the corpus disagree.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not rewrite the prose around the table. The markers are
// narrow on purpose: everything outside them is argument, and an argument nobody wrote by hand is
// an argument nobody is accountable for.
//
// DELIBERATE DUPLICATION, the same trade `scripts/write-manifest.mjs` makes and for the same
// reason. This reads the corpus with `JSON.parse` rather than importing
// @model-regression-sentinel/spec, because a docs generator that needs `dist/` cannot be run on a
// fresh clone or in a pre-commit hook. What it duplicates is small: the sidecar list and the
// meaning of `detectionLimit`. It does NOT duplicate validation, and it is not a corpus checker;
// `checkCorpus` is, and packages/spec/test/corpusV2.test.ts is where the corpus is asserted valid.
//
// Usage: node scripts/case-composition.mjs [--check]
//   --check  exit 1 if docs/CORPUS.md would change, and print a diff-shaped summary. Never writes.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHECK = process.argv.includes("--check");

const DOC = join(ROOT, "docs", "CORPUS.md");
const OPEN = "<!-- GENERATED:case-composition -->";
const CLOSE = "<!-- /GENERATED -->";

// The same explicit list write-manifest.mjs uses. Never a heuristic: a rule like "skip anything
// that is not an array" would also skip a genuinely malformed case file.
const SIDECARS = new Set(["FREEZE.json", "MANIFEST.sha256", "README.md"]);

const ARCHETYPES = [
  "constrained_categorical",
  "constrained_numeric",
  "free_form",
  "structured_json",
];

/** Every case on disk, with the split it was found under. Order is split then file then position. */
function readCorpus() {
  const corpus = join(ROOT, "corpus");
  const splits = readdirSync(corpus, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const cases = [];
  for (const split of splits) {
    for (const file of readdirSync(join(corpus, split)).sort()) {
      if (SIDECARS.has(file) || !file.endsWith(".json")) continue;
      const parsed = JSON.parse(readFileSync(join(corpus, split, file), "utf8"));
      if (!Array.isArray(parsed)) {
        console.error(`corpus/${split}/${file} is not an array of cases`);
        process.exit(2);
      }
      for (const c of parsed) cases.push({ ...c, foundIn: split });
    }
  }
  return { splits, cases };
}

const count = (cases, predicate) => cases.filter(predicate).length;

function render(splits, cases) {
  const lines = [];

  const header = ARCHETYPES.map((a) => `\`${a}\``).join(" | ");
  const rule = ARCHETYPES.map(() => "---:|").join("");
  lines.push(`| split | ${header} | total |`);
  lines.push(`|---|${rule}---:|`);
  for (const split of splits) {
    const inSplit = cases.filter((c) => c.foundIn === split);
    const cells = ARCHETYPES.map((a) => String(count(inSplit, (c) => c.archetype === a)));
    lines.push(`| \`${split}\` | ${cells.join(" | ")} | **${inSplit.length}** |`);
  }
  const totals = ARCHETYPES.map((a) => String(count(cases, (c) => c.archetype === a)));
  lines.push(`| **all** | ${totals.map((t) => `**${t}**`).join(" | ")} | **${cases.length}** |`);
  lines.push("");

  lines.push("| provenance origin | cases |");
  lines.push("|---|---:|");
  const origins = new Map();
  for (const c of cases) {
    const key =
      c.provenance?.kind === "derived" ? `derived from \`${c.provenance.from}\`` : "original";
    origins.set(key, (origins.get(key) ?? 0) + 1);
  }
  for (const [key, n] of [...origins].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    lines.push(`| ${key} | ${n} |`);
  }
  lines.push("");

  // The out-of-scope row. A corpus with none of these is a rigged corpus, so the number is printed
  // beside the totals rather than left for a reader to work out.
  const limited = count(cases, (c) => c.detectionLimit !== null);
  const schemaCases = count(cases, (c) => c.input?.jsonSchema !== undefined);
  const traced = count(cases, (c) => c.sourceTrace !== undefined);
  lines.push("| property | cases |");
  lines.push("|---|---:|");
  lines.push(`| declare a \`detectionLimit\`, and are reported in their own row | ${limited} |`);
  lines.push(
    `| declare a \`jsonSchema\`, so \`schemaValid\` is producible on them | ${schemaCases} |`,
  );
  lines.push(`| carry a \`sourceTrace\` | ${traced} |`);
  lines.push(`| total | ${cases.length} |`);

  return lines.join("\n");
}

if (!existsSync(DOC)) {
  console.error(`docs/CORPUS.md does not exist. This script fills a block in it, it does not
create the document: the prose around the table is the argument, and an argument nobody wrote by
hand is an argument nobody is accountable for.`);
  process.exit(2);
}

const { splits, cases } = readCorpus();
const table = render(splits, cases);

const current = readFileSync(DOC, "utf8");
const from = current.indexOf(OPEN);
const to = current.indexOf(CLOSE);
if (from === -1 || to === -1 || to < from) {
  console.error(`docs/CORPUS.md is missing the generated block. Put these two markers in it:
  ${OPEN}
  ${CLOSE}`);
  process.exit(2);
}

const next = `${current.slice(0, from + OPEN.length)}\n\n${table}\n\n${current.slice(to)}`;

if (next === current) {
  console.log(
    `  unchanged  docs/CORPUS.md  (${cases.length} cases across ${splits.length} splits)`,
  );
  process.exit(0);
}

if (CHECK) {
  console.error("  WOULD CHANGE  docs/CORPUS.md");
  console.error("");
  console.error("The case-composition table does not match the corpus on disk.");
  console.error("If you added or edited cases deliberately, run `pnpm docs:composition`.");
  console.error("If you did not, find out what changed the corpus before you regenerate anything,");
  console.error("and read scripts/verify-corpus.sh, which says the same thing at more length.");
  process.exit(1);
}

writeFileSync(DOC, next);
console.log(`  written    docs/CORPUS.md  (${cases.length} cases across ${splits.length} splits)`);
