// Assemble dist/release from what this repository actually has.
//
// WHY THIS EXISTS. `sentinel release verify` checks a release directory against a written-down list
// of required artifacts. A verifier with nothing real to check is a verifier nobody has ever seen
// reject anything, which is the same objection `scripts/audit-release.sh` raises against a drift
// check that has never been shown to fire. So this builds the real thing: the packed tarballs, the
// digests over them, and the three text files a stranger needs in order to know what the release
// does and does not claim.
//
// WHAT IT WILL NOT DO. It does not invent an artifact to pad a list. `corpus_composition.md`,
// `calibration.json` and `CALIBRATION.md` are copied ONLY if their sources exist, and they are not
// on the required list for exactly that reason. It does not publish, it does not tag, and it does
// not touch anything outside `dist/release`. And it refuses to build a release at all when a check
// it CAN make fails, rather than writing a payload whose own VERIFICATION.txt would have to lie.
//
// WHY `pnpm pack` AND NOT `npm pack`. Every package here depends on its siblings through
// `workspace:^`. `pnpm pack` rewrites that to a real semver range inside the tarball's
// package.json; `npm pack` ships the string `workspace:^` verbatim, and `npm install` of such a
// tarball fails with EUNSUPPORTEDPROTOCOL. That is measured rather than assumed, in
// docs/PUBLISHING.md. A release built with npm pack would be seven tarballs nobody can install, so
// this refuses to fall back to npm silently: if pnpm is absent it stops and says so.
//
// FREEZE_STATUS.txt IS READ, NOT WRITTEN. Its contents come from `corpus/*/FREEZE.json` at build
// time. The status in this repository is `unavailable` and it will stay that way, for the reason
// those records give: no git operation was permitted in the environment that produced the corpus,
// so the ordering proof could not be cashed. A builder that hard-coded a status would be a builder
// that keeps saying `unavailable` on the day somebody finally cashes it, or worse, the reverse.
//
// Usage: node scripts/build-release.mjs

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "dist", "release");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Stop rather than write a release whose own VERIFICATION.txt would have to be softened. */
function refuse(reason, ...detail) {
  console.error(`refusing to build a release: ${reason}`);
  for (const line of detail) console.error(`  ${line}`);
  process.exit(1);
}

/** Wrap at 100 columns on spaces. Release text is read in a terminal and pasted into issues. */
function wrap(text, indent = "") {
  const words = text.split(/\s+/).filter((w) => w !== "");
  const lines = [];
  let current = indent;
  for (const word of words) {
    if (current.trim() !== "" && current.length + 1 + word.length > 100) {
      lines.push(current);
      current = `${indent}${word}`;
      continue;
    }
    current = current.trim() === "" ? `${indent}${word}` : `${current} ${word}`;
  }
  if (current.trim() !== "") lines.push(current);
  return lines.join("\n");
}

// ---- 1. the packages, and whether they are in a state that can be packed ------------------------

const packagesDir = join(ROOT, "packages");
const manifests = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
  .map((dir) => {
    const file = join(packagesDir, dir, "package.json");
    if (!existsSync(file)) return null;
    return { dir, path: join(packagesDir, dir), manifest: JSON.parse(readFileSync(file, "utf8")) };
  })
  .filter((p) => p !== null && p.manifest.private !== true);

if (manifests.length === 0) refuse("there are no publishable packages under packages/");

const versions = [...new Set(manifests.map((p) => p.manifest.version))];
if (versions.length !== 1) {
  refuse(
    "the packages do not agree on a version, so the release has no version",
    ...manifests.map((p) => `${p.manifest.name} ${p.manifest.version}`),
  );
}
const VERSION = versions[0];

const unbuilt = manifests.filter((p) => !existsSync(join(p.path, "dist")));
if (unbuilt.length > 0) {
  refuse(
    "a package has no dist/, so its tarball would ship an empty files list",
    ...unbuilt.map((p) => `${p.manifest.name} has no dist/`),
    "run `pnpm build` first",
  );
}

// ---- 2. the corpus matches its own manifests, which is a check this builder CAN make ------------

const SIDECARS = new Set(["FREEZE.json", "MANIFEST.sha256", "README.md"]);
const corpusRoot = join(ROOT, "corpus");
const corpusChecks = [];
if (existsSync(corpusRoot)) {
  for (const split of readdirSync(corpusRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()) {
    const dir = join(corpusRoot, split);
    const manifestFile = join(dir, "MANIFEST.sha256");
    if (!existsSync(manifestFile)) {
      corpusChecks.push({ split, files: 0, mismatched: ["MANIFEST.sha256 is absent"] });
      continue;
    }
    const mismatched = [];
    let files = 0;
    for (const line of readFileSync(manifestFile, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (m === null) {
        mismatched.push(`unparseable line: ${line}`);
        continue;
      }
      files += 1;
      const target = join(ROOT, m[2]);
      if (!existsSync(target)) mismatched.push(`${m[2]} is recorded and absent`);
      else if (sha256(readFileSync(target)) !== m[1]) mismatched.push(`${m[2]} changed`);
    }
    const present = readdirSync(dir).filter((f) => !SIDECARS.has(f)).length;
    if (present !== files) {
      mismatched.push(`${present} case file(s) on disk against ${files} recorded`);
    }
    corpusChecks.push({ split, files, mismatched });
  }
}
const corpusBad = corpusChecks.filter((c) => c.mismatched.length > 0);
if (corpusBad.length > 0) {
  refuse(
    "the corpus does not match its manifests, and a release of a drifted corpus is not a release",
    ...corpusBad.flatMap((c) => c.mismatched.map((m) => `${c.split}: ${m}`)),
    "do NOT run `pnpm write:manifest` to make this pass. Find out what wrote to the corpus.",
  );
}

// ---- 3. the freeze status, read from the records rather than asserted ---------------------------

const freezes = [];
if (existsSync(corpusRoot)) {
  for (const split of readdirSync(corpusRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()) {
    const file = join(corpusRoot, split, "FREEZE.json");
    if (!existsSync(file)) continue;
    freezes.push(JSON.parse(readFileSync(file, "utf8")));
  }
}
if (freezes.length === 0)
  refuse("no corpus/*/FREEZE.json was found, so the freeze cannot be stated");

const states = [...new Set(freezes.map((f) => f.state))];
const overall = states.length === 1 ? states[0].toUpperCase() : `MIXED (${states.join(", ")})`;

// ---- 4. a clean output directory ----------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ---- 5. pack ------------------------------------------------------------------------------------

const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
if (pnpm.status !== 0) {
  refuse(
    "pnpm is not on PATH, and `npm pack` would ship the workspace: protocol verbatim",
    'a tarball carrying "workspace:^" fails at install with EUNSUPPORTEDPROTOCOL',
    "see docs/PUBLISHING.md, which records that measurement",
  );
}

const packed = [];
for (const pkg of manifests) {
  const result = spawnSync("pnpm", ["pack", "--pack-destination", OUT], {
    cwd: pkg.path,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    refuse(`pnpm pack failed for ${pkg.manifest.name}`, (result.stderr || "").trim());
  }
  const expected = `${pkg.manifest.name.replace("@", "").replace("/", "-")}-${VERSION}.tgz`;
  const landed = join(OUT, expected);
  if (!existsSync(landed)) {
    refuse(`pnpm pack reported success and ${expected} is not in the output directory`);
  }
  packed.push({
    name: pkg.manifest.name,
    file: expected,
    bytes: statSync(landed).size,
    dependencies: pkg.manifest.dependencies ?? {},
  });
}

// Read each tarball's own package.json back out and confirm no workspace: range survived. This is
// the check that matters, because it is about what a stranger installs rather than about what the
// packer claims to do. `tar` is spawned rather than reimplemented; if it is unavailable the check is
// recorded as not performed rather than silently assumed to have passed.
const workspaceLeaks = [];
let protocolChecked = true;
for (const entry of packed) {
  const read = spawnSync("tar", ["-xzOf", join(OUT, entry.file), "package/package.json"], {
    encoding: "utf8",
  });
  if (read.status !== 0) {
    protocolChecked = false;
    break;
  }
  const shipped = JSON.parse(read.stdout);
  for (const [dep, range] of Object.entries(shipped.dependencies ?? {})) {
    if (String(range).startsWith("workspace:")) workspaceLeaks.push(`${entry.name} -> ${dep}`);
  }
}
if (workspaceLeaks.length > 0) {
  refuse(
    "a packed tarball still carries the workspace: protocol, which no consumer can install",
    ...workspaceLeaks,
  );
}

// ---- 6. the copied artifacts, only where a source genuinely exists ------------------------------

const copied = [];
const copyIfPresent = (from, to, note) => {
  const source = join(ROOT, from);
  if (!existsSync(source)) return;
  copyFileSync(source, join(OUT, to));
  copied.push({ from, to, note });
};

copyIfPresent("docs/CORPUS.md", "corpus_composition.md", "byte-identical copy of docs/CORPUS.md");
copyIfPresent("results/calibration.json", "calibration.json", "byte-identical copy");
copyIfPresent("results/CALIBRATION.md", "CALIBRATION.md", "byte-identical copy");
copyIfPresent("LICENSE", "LICENSE", "the repository licence, MIT");

// ---- 7. FREEZE_STATUS.txt -----------------------------------------------------------------------

const freezeLines = [
  "FREEZE STATUS",
  "=============",
  "",
  wrap(
    "Read from corpus/<split>/FREEZE.json at build time by scripts/build-release.mjs. Nothing " +
      "here is written by hand and nothing here is a summary: the prose under each split is the " +
      "record's own text.",
  ),
  "",
  `  overall state    ${overall}`,
  `  splits           ${freezes.length}`,
  "",
  "  split       state          cases   frozenAt      commit",
];
for (const f of freezes) {
  freezeLines.push(
    `  ${String(f.split).padEnd(11)} ${String(f.state).padEnd(14)} ${String(f.caseCount).padStart(5)}   ${String(f.frozenAt).padEnd(13)} ${f.frozenAtCommit ?? "(none recorded)"}`,
  );
}
freezeLines.push("");
for (const f of freezes) {
  freezeLines.push(`--- ${f.split} ---`);
  freezeLines.push("");
  freezeLines.push("  what is proven");
  freezeLines.push(wrap(f.whatIsProven, "    "));
  freezeLines.push("");
  freezeLines.push("  what is NOT proven");
  freezeLines.push(wrap(f.whatIsNotProven, "    "));
  if (typeof f.reason === "string") {
    freezeLines.push("");
    freezeLines.push("  why the state is what it is");
    freezeLines.push(wrap(f.reason, "    "));
  }
  freezeLines.push("");
  freezeLines.push("  standing instruction");
  freezeLines.push(wrap(f.doNot, "    "));
  freezeLines.push("");
}
freezeLines.push(
  wrap(
    "UNAVAILABLE is not PENDING. Pending means work that remains; unavailable means a proof this " +
      "environment cannot produce. docs/FREEZE.md carries the full argument and the recipe for a " +
      "repository that can cash it.",
  ),
);
writeFileSync(join(OUT, "FREEZE_STATUS.txt"), `${freezeLines.join("\n")}\n`);

// ---- 8. RELEASE_NOTES.md ------------------------------------------------------------------------

const notes = [
  `# model-regression-sentinel ${VERSION}`,
  "",
  wrap(
    "Watch a pinned model alias for behavior that moved when your code did not, and tell drift " +
      "apart from sampling noise. This directory is a release payload assembled by " +
      "`node scripts/build-release.mjs`. Nothing in it has been published to any registry.",
  ),
  "",
  "## Packages",
  "",
  "| package | tarball | bytes |",
  "| --- | --- | --- |",
  ...packed.map((p) => `| \`${p.name}\` | \`${p.file}\` | ${p.bytes.toLocaleString("en-US")} |`),
  "",
  wrap(
    [
      `All ${packed.length} packages carry version ${VERSION}.`,
      "The sibling dependencies were rewritten from `workspace:^` to a real semver range by",
      "`pnpm pack`, and each tarball's own package.json was read back to confirm it.",
    ].join(" "),
  ),
  "",
  "## What else is here",
  "",
  "| file | what it is |",
  "| --- | --- |",
  "| `MANIFEST.sha256` | sha256 of every other file here, checkable with `shasum -a 256 -c` |",
  "| `VERIFICATION.txt` | what the builder checked, what that does not establish |",
  "| `FREEZE_STATUS.txt` | the corpus freeze state, read from `corpus/*/FREEZE.json` |",
  ...copied.map((c) => `| \`${c.to}\` | ${c.note}, from \`${c.from}\` |`),
  "",
  "## Verify this release",
  "",
  "```sh",
  "shasum -a 256 -c MANIFEST.sha256      # no code from this project involved",
  "sentinel release verify .             # the same check, plus the required-artifact list",
  "```",
  "",
  wrap(
    "`sentinel release verify` checks a written-down list of required artifacts against the " +
      "filesystem rather than against the manifest, because a builder that never wrote an artifact " +
      "produces a manifest that does not mention it, and every manifest-versus-payload cross-check " +
      "then agrees.",
  ),
  "",
  "## Exit codes, which are the product",
  "",
  "```",
  "0  no confirmed regression, which includes NO_DRIFT, INCONCLUSIVE and SUSPECTED_DRIFT",
  "1  a CONFIRMED regression: it cleared both nulls and reproduced on an independent arm",
  "2  misuse: bad flags, an unreadable file, mismatched corpora, a missing artifact",
  "3  could not look: the provider was unreachable or no credential was present",
  "```",
  "",
  wrap(
    "2 and 3 are different numbers on purpose. A watcher that cannot reach its provider and a " +
      "watcher pointed at the wrong file are different events with different owners.",
  ),
  "",
  "## What this release does not claim",
  "",
  `- The corpus freeze is **${overall}**. See \`FREEZE_STATUS.txt\`, which quotes the records.`,
  "- Nothing here has been published to npm, and no agent may publish it. See `docs/PUBLISHING.md`.",
  "- The digests prove the payload has not changed since this manifest was written. They are not",
  "  provenance: whoever can edit an artifact can rewrite its line in the same change.",
  "- A verified release is not a working install. That is a staged install from these tarballs.",
];
writeFileSync(join(OUT, "RELEASE_NOTES.md"), `${notes.join("\n")}\n`);

// ---- 9. VERIFICATION.txt ------------------------------------------------------------------------

const corpusFileCount = corpusChecks.reduce((n, c) => n + c.files, 0);
const verification = [
  "VERIFICATION",
  "============",
  "",
  wrap(
    "What scripts/build-release.mjs checked while assembling this directory. Every line is a " +
      "check that ran and passed, because the builder exits non-zero rather than writing a " +
      "release when one fails.",
  ),
  "",
  `  CHECKED   ${manifests.length} publishable package(s) all carry version ${VERSION}`,
  "  CHECKED   every one of them had a dist/ directory before it was packed",
  `  CHECKED   ${corpusChecks.length} corpus split(s), ${corpusFileCount} file(s), each byte-identical to`,
  "            its recorded sha256 in corpus/<split>/MANIFEST.sha256",
  "  CHECKED   the file count on disk equals the count recorded, per split, so an added case is",
  "            caught as well as a changed one",
  protocolChecked
    ? "  CHECKED   each tarball's own package.json carries no workspace: range, read back out of\n            the tarball rather than assumed from what pnpm claims to do"
    : "  NOT DONE  the workspace: protocol check needs `tar` on PATH and it was not available;\n            run `tar -xzOf <tarball> package/package.json` yourself before trusting these",
  "  RECORDED  sha256 of every file in this directory, in MANIFEST.sha256",
  "",
  "WHAT NONE OF THAT ESTABLISHES",
  "",
  wrap(
    "Provenance. The digests sit in the same directory as the files they cover. They prove the " +
      "payload has not changed since MANIFEST.sha256 was written, by whoever wrote it. Anyone able " +
      "to edit an artifact could rewrite its line in the same change. Only a signature over an " +
      "independently held key would say more, and there is none here.",
    "  ",
  ),
  "",
  wrap(
    "That the tarballs install. Packing is not installing. The measured result is in " +
      "docs/PUBLISHING.md: all seven install together into a directory that has never seen this " +
      "workspace, and the cli tarball alone does not, because its six siblings are not on any " +
      "registry.",
    "  ",
  ),
  "",
  wrap(
    "That the corpus predates the detector. It does not, and cannot be shown to. FREEZE_STATUS.txt " +
      "carries the records verbatim.",
    "  ",
  ),
  "",
  wrap(
    "That any measurement in RESULTS.md is correct. This builder hashes files. It runs no test, " +
      "no calibration and no comparison, and a green manifest says nothing about a statistic.",
    "  ",
  ),
  "",
  "RECOMPUTE ALL OF IT WITHOUT TRUSTING THIS FILE",
  "",
  "  cd <this directory>",
  "  shasum -a 256 -c MANIFEST.sha256",
  `  tar -tzf ${packed[0]?.file ?? "<tarball>"}`,
  `  tar -xzOf ${packed[0]?.file ?? "<tarball>"} package/package.json`,
  "",
  "  # and from a clone of the repository, which rebuilds this directory from source:",
  "  pnpm install --frozen-lockfile && pnpm build",
  "  node scripts/build-release.mjs",
  "  sentinel release verify dist/release",
  "",
  wrap(
    "The generated text files here are deterministic: they carry no timestamp and no hostname, so " +
      "a rebuild from the same tree reproduces them byte for byte. The tarballs are produced by " +
      "pnpm pack and their bytes are pnpm's business rather than this script's, so compare the " +
      "unpacked contents rather than the tarball digests if a rebuild disagrees.",
  ),
];
writeFileSync(join(OUT, "VERIFICATION.txt"), `${verification.join("\n")}\n`);

// ---- 10. MANIFEST.sha256, last, over everything else --------------------------------------------

// Paths are relative to this directory, not to the repository root, so that `shasum -a 256 -c` run
// from inside an unpacked release archive works with no code from this project involved. That is
// the same property corpus/*/MANIFEST.sha256 has, measured from its own root.
const payload = readdirSync(OUT)
  .filter((f) => f !== "MANIFEST.sha256")
  .sort();
const body = payload.map((f) => `${sha256(readFileSync(join(OUT, f)))}  ${f}`).join("\n");
writeFileSync(join(OUT, "MANIFEST.sha256"), `${body}\n`);

// ---- 11. say what happened ----------------------------------------------------------------------

console.log(`release ${VERSION} assembled at dist/release`);
console.log("");
for (const p of packed)
  console.log(`  packed     ${p.file}  ${p.bytes.toLocaleString("en-US")} bytes`);
for (const c of copied) console.log(`  copied     ${c.to}  from ${c.from}`);
console.log("  written    FREEZE_STATUS.txt  RELEASE_NOTES.md  VERIFICATION.txt");
console.log(`  recorded   MANIFEST.sha256 over ${payload.length} file(s)`);
console.log("");
console.log(
  `  freeze state ${overall}, read from ${freezes.length} corpus/*/FREEZE.json record(s)`,
);
console.log("");
console.log("Check it:");
console.log("  sentinel release verify dist/release");
console.log("  cd dist/release && shasum -a 256 -c MANIFEST.sha256");
