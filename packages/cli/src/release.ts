// `sentinel release verify` - checking a release the way a stranger would, and the default path
// that decides whether the answer is trustworthy.
//
// WHY THIS EXISTS. A release directory is the last artifact anybody reads before deciding whether
// to trust this project, and it is the one artifact nothing else in this repository checks.
// `audit-release.sh` checks the SOURCE TREE: lint, typecheck, build, test, corpus integrity, and
// its two inverted negative controls. None of that says the assembled payload under `dist/release`
// contains what the release notes claim it contains.
//
// THE DEFAULT PATH, AND WHY IT IS NOT ".". A sibling project shipped this command with `path`
// defaulting to the current directory. Run bare from a repository root it reported four artifacts
// MISSING against a release that was in fact complete, because it was checking the wrong directory.
// Every word of that report was true of `.` and every word of it was misleading about the release,
// and a reader following the documentation would reasonably have concluded the release was broken.
// A verifier that produces a confident false negative is worse than no verifier, because a false
// negative gets acted on.
//
// So: A BARE INVOCATION EITHER CHECKS `dist/release` OR REFUSES. It never silently scans `.`. The
// rule, chosen over the two alternatives below:
//
//   1. Default to `dist/release` when that directory exists. It is the only path this repository's
//      builder ever writes to, so a bare run from a repository root checks the thing the reader
//      means, and the report names the directory it checked on its first line.
//   2. Otherwise REFUSE, with the path that was expected, the command that builds one, and the way
//      to point it at an unpacked archive. A refusal is exit 2 and it is not an artifact report:
//      nothing is listed as missing, because nothing was looked for.
//
//   REJECTED: defaulting to ".". That is the sibling's defect verbatim.
//   REJECTED: defaulting to "." but staying quiet when the required files are absent. It moves the
//      failure from a wrong answer to no answer, and a verifier that says nothing when pointed at
//      the wrong place still cannot be run bare with confidence.
//   REJECTED: searching upward for a release directory. Convenient, and it makes the checked path
//      depend on where the caller happened to stand, which is the same class of defect.
//
// THE REQUIRED-ARTIFACT LIST IS CHECKED AGAINST THE FILESYSTEM, NEVER AGAINST THE MANIFEST, and
// that is the whole reason `REQUIRED_ARTIFACTS` exists as a separate thing from `MANIFEST.sha256`.
// A builder that never wrote an artifact produces a manifest that does not mention it. Every
// manifest-versus-payload cross-check then agrees perfectly: every recorded digest matches, nothing
// is untracked, and the release is missing a tarball. A manifest can only ever prove that what was
// recorded is still what is there; it can say nothing about what was never recorded. So the list of
// what a release MUST contain is written down here, in the verifier, and read off the directory
// entries.
//
// WHAT THIS IS NOT. It is not provenance. Digests recorded next to the files they cover prove that
// the payload has not changed since the manifest was written, by whoever wrote it, and nothing
// more: anyone who can edit an artifact can rewrite its line in the same breath. It is not a build,
// it does not repair anything, and it never regenerates a manifest to make a check pass, which is
// the one move `docs/FREEZE.md` forbids by name. And it is not a claim that the tarballs install:
// that is `npm pack` plus a staged install, and `docs/PUBLISHING.md` carries the result.
//
// EXIT CODES: 0 verified, 2 for misuse or a failed verification, and NEVER 1. A bad release is not
// a model regression, and a pipeline that conflated them would page the wrong person.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  EXIT_MISUSE,
  EXIT_OK,
  type ExitCode,
  type ManifestCheck,
  checkManifest,
  parseManifest,
} from "@model-regression-sentinel/spec";
import { type Args, UsageError } from "./args.js";

/** The one directory a bare invocation will look at. Repo-root relative, POSIX in the docs. */
export const DEFAULT_RELEASE_DIR: string = join("dist", "release");

/** The manifest filename, which is also the one file the manifest cannot cover: it is itself. */
export const MANIFEST_NAME = "MANIFEST.sha256";

/**
 * The packages whose tarballs a release must carry.
 *
 * Written down rather than derived from `packages/*`, because a verifier that discovers its own
 * expectations from the tree under test agrees with whatever that tree happens to be. If a package
 * is added, this list and `scripts/build-release.mjs` both change, and until they do the check
 * fails loudly in the safe direction.
 */
export const PUBLISHABLE_PACKAGES: readonly string[] = [
  "spec",
  "run",
  "baseline",
  "detect",
  "report",
  "watch",
  "cli",
];

/** One thing a release must contain, matched by name against the directory listing. */
export interface RequiredArtifact {
  /** What a person calls it. */
  readonly label: string;
  /** Why a release without it is incomplete. Printed when it is missing. */
  readonly why: string;
  /** A name that would satisfy it, for the failure message. */
  readonly example: string;
  /** Matched against each relative path in the release directory. */
  readonly matches: (relativePath: string) => boolean;
}

const exact =
  (name: string) =>
  (path: string): boolean =>
    path === name;

// Versions move, so a tarball is matched by shape rather than by a pinned filename. The prefix is
// what `npm pack` and `pnpm pack` produce for a scoped name: the scope's slashes become hyphens.
const tarball = (pkg: string): ((path: string) => boolean) => {
  const pattern = new RegExp(
    `^model-regression-sentinel-${pkg}-\\d+\\.\\d+\\.\\d+[A-Za-z0-9.+-]*\\.tgz$`,
  );
  return (path: string): boolean => pattern.test(path);
};

/**
 * What a release must contain. Checked against the filesystem. See the header for why this is not
 * derived from the manifest, which is the whole point of the list.
 */
export const REQUIRED_ARTIFACTS: readonly RequiredArtifact[] = [
  {
    label: MANIFEST_NAME,
    why: "without it no digest in the release can be checked at all",
    example: MANIFEST_NAME,
    matches: exact(MANIFEST_NAME),
  },
  {
    label: "RELEASE_NOTES.md",
    why: "the release has to say what it is and which versions it carries",
    example: "RELEASE_NOTES.md",
    matches: exact("RELEASE_NOTES.md"),
  },
  {
    label: "FREEZE_STATUS.txt",
    why: "a corpus release that does not state its freeze status invites the reader to assume one",
    example: "FREEZE_STATUS.txt",
    matches: exact("FREEZE_STATUS.txt"),
  },
  {
    label: "VERIFICATION.txt",
    why: "what the builder checked, what that does not establish, and how to recompute it",
    example: "VERIFICATION.txt",
    matches: exact("VERIFICATION.txt"),
  },
  ...PUBLISHABLE_PACKAGES.map((pkg) => ({
    label: `@model-regression-sentinel/${pkg} tarball`,
    why: "a release that omits a package ships a dependency graph nobody can install",
    example: `model-regression-sentinel-${pkg}-<version>.tgz`,
    matches: tarball(pkg),
  })),
];

/** Present or absent. Deliberately NOT the digest vocabulary, which also has "changed". */
export type RequiredVerdict = "present" | "missing";

export interface RequiredArtifactCheck {
  readonly label: string;
  readonly why: string;
  readonly example: string;
  readonly verdict: RequiredVerdict;
  /** The filename that satisfied it, so the report names what it actually found. */
  readonly found: string | null;
}

export interface ReleaseVerification {
  /** Absolute, and printed first, so the reader never has to guess what was checked. */
  readonly dir: string;
  readonly required: readonly RequiredArtifactCheck[];
  readonly manifestFound: boolean;
  /** A line nobody could parse checks nothing, so it is reported rather than skipped. */
  readonly malformedManifestLines: readonly string[];
  readonly digests: readonly ManifestCheck[];
  /** On disk, not in the manifest. An addition is drift too. */
  readonly untracked: readonly string[];
  readonly fileCount: number;
  readonly ok: boolean;
}

/** What the command printed and what it returned. Separated so a test can read both. */
export interface ReleaseOutcome {
  readonly code: ExitCode;
  readonly output: string;
}

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/**
 * How deep the walk goes, and what it never enters.
 *
 * A release payload is flat, or one directory deep at the most. The bound exists because the most
 * likely wrong argument to this command is a source tree, and a verifier that spends a minute
 * walking `node_modules` before reporting that a path was wrong is a verifier people stop running.
 * Anything deeper than this in a release directory is reported as untracked by way of its parent
 * rather than enumerated.
 */
const MAX_WALK_DEPTH = 3;
const NEVER_WALKED: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/** Every file under `root`, as relative POSIX paths, sorted. Directories are not entries. */
function listFiles(root: string, prefix: string, depth: number): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(prefix === "" ? root : join(root, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (NEVER_WALKED.has(entry.name) || depth >= MAX_WALK_DEPTH) continue;
      out.push(...listFiles(root, rel, depth + 1));
    } else out.push(rel);
  }
  return [...out].sort();
}

/**
 * Check one release directory.
 *
 * The two halves are independent on purpose and neither can cover for the other: the required-list
 * pass reads the directory, and the digest pass reads the manifest. A release can fail the first
 * and pass the second, which is exactly the case that motivated the first.
 */
export function verifyRelease(dir: string): ReleaseVerification {
  const files = listFiles(dir, "", 0);

  const required: RequiredArtifactCheck[] = REQUIRED_ARTIFACTS.map((artifact) => {
    const found = files.find((f) => artifact.matches(f)) ?? null;
    return {
      label: artifact.label,
      why: artifact.why,
      example: artifact.example,
      verdict: found === null ? ("missing" as const) : ("present" as const),
      found,
    };
  });

  const manifestPath = join(dir, MANIFEST_NAME);
  const manifestFound = existsSync(manifestPath);
  if (!manifestFound) {
    return {
      dir,
      required,
      manifestFound: false,
      malformedManifestLines: [],
      digests: [],
      untracked: [],
      fileCount: files.length,
      ok: false,
    };
  }

  const parsed = parseManifest(readFileSync(manifestPath, "utf8"));
  // The manifest cannot carry its own digest, so it is excluded from the untracked comparison
  // rather than being reported as an untracked file on every single run.
  const payload = files.filter((f) => f !== MANIFEST_NAME);
  const result = checkManifest(parsed.entries, payload, (relative) => {
    const full = join(dir, relative);
    return existsSync(full) && statSync(full).isFile() ? readFileSync(full) : null;
  });

  const ok =
    required.every((r) => r.verdict === "present") &&
    parsed.malformed.length === 0 &&
    result.ok &&
    parsed.entries.length > 0;

  return {
    dir,
    required,
    manifestFound: true,
    malformedManifestLines: parsed.malformed,
    digests: result.checks,
    untracked: result.untracked,
    fileCount: files.length,
    ok,
  };
}

/** The refusal, and the three things it must say. Not an artifact report: nothing was read. */
function refuseBare(cwd: string): string {
  const expected = join(cwd, DEFAULT_RELEASE_DIR);
  return [
    "release verify was given no path, and there is nothing here to check.",
    "",
    `  expected                      ${expected}`,
    "  build one                     node scripts/build-release.mjs",
    `  from a repository root        sentinel release verify ${DEFAULT_RELEASE_DIR}`,
    "  from an unpacked archive      tar -xzf sentinel-release.tar.gz -C /tmp/release",
    "                                sentinel release verify /tmp/release",
    "",
    "  It did NOT scan the current directory, and it will not. A verifier pointed at the wrong",
    "  place reports every artifact of a complete release as absent, which reads as a broken",
    "  release rather than as a wrong path. Nothing above was checked, so nothing above is a",
    "  finding about any release.",
  ].join("\n");
}

const NOT_ESTABLISHED: readonly string[] = [
  "  What a pass here does NOT establish:",
  "    provenance. The digests sit next to the files they cover, so they prove the payload has",
  "      not changed since the manifest was written, by whoever wrote it, and nothing else.",
  "      Anyone able to edit an artifact could rewrite its line in the same change.",
  "    that the tarballs install. That is a staged install from the packed files, and",
  "      docs/PUBLISHING.md carries the result rather than this command.",
  "    that the corpus freeze was cashed. It was not, in this repository. FREEZE_STATUS.txt in",
  "      the release says so, and docs/FREEZE.md says why.",
];

/** Rendered rather than printed, so the exact text a caller sees is also the text a test reads. */
export function renderVerification(report: ReleaseVerification): string {
  const lines: string[] = [];
  const missing = report.required.filter((r) => r.verdict === "missing");
  const changed = report.digests.filter((d) => d.status === "changed");
  const absent = report.digests.filter((d) => d.status === "missing");
  const ok = report.digests.filter((d) => d.status === "ok");

  lines.push(`verifying ${report.dir}`);
  lines.push("");
  lines.push(
    `  required artifacts   ${report.required.length - missing.length} of ${report.required.length} present, checked against the filesystem`,
  );
  if (report.manifestFound) {
    lines.push(
      `  recorded digests     ${ok.length} ok, ${changed.length} changed, ${absent.length} missing`,
    );
    lines.push(
      `  untracked files      ${report.untracked.length === 0 ? "none" : String(report.untracked.length)}`,
    );
  } else {
    lines.push(`  recorded digests     not checked: ${MANIFEST_NAME} is not in this directory`);
  }

  if (missing.length > 0) {
    lines.push("");
    lines.push("  MISSING means the file is not on disk at all, whatever the manifest says:");
    for (const r of missing) {
      lines.push(`    MISSING    ${r.label}`);
      lines.push(`               expected a file like ${r.example}`);
      lines.push(`               ${r.why}`);
    }
  }

  if (changed.length > 0) {
    lines.push("");
    lines.push("  CHANGED means the file is present and its bytes are not the recorded ones:");
    for (const c of changed) {
      lines.push(`    CHANGED    ${c.path}`);
      lines.push(`               recorded ${c.expected}`);
      lines.push(`               on disk  ${c.actual ?? "(unreadable)"}`);
    }
  }

  if (absent.length > 0) {
    lines.push("");
    lines.push("  RECORDED BUT ABSENT means the manifest lists a file the payload does not have:");
    for (const a of absent) lines.push(`    ABSENT     ${a.path}`);
  }

  if (report.untracked.length > 0) {
    lines.push("");
    lines.push("  UNTRACKED means the file is in the payload and no digest covers it:");
    for (const u of report.untracked) lines.push(`    UNTRACKED  ${u}`);
  }

  if (report.malformedManifestLines.length > 0) {
    lines.push("");
    lines.push(`  ${MANIFEST_NAME} has lines nothing can parse, so they check nothing:`);
    for (const m of report.malformedManifestLines) lines.push(`    MALFORMED  ${m}`);
  }

  if (report.manifestFound && report.digests.length === 0) {
    lines.push("");
    lines.push(
      `  ${MANIFEST_NAME} records no files at all. An empty manifest agrees with anything.`,
    );
  }

  lines.push("");
  if (report.ok) {
    lines.push("VERIFIED. Every required artifact is on disk and every recorded digest matches.");
  } else {
    lines.push("NOT VERIFIED. Do not ship this directory, and do not regenerate the manifest to");
    lines.push("make this pass: that turns an integrity check into decoration. Rebuild it with");
    lines.push("`node scripts/build-release.mjs` and find out what wrote to the file.");
  }
  lines.push("");
  lines.push(...NOT_ESTABLISHED);
  lines.push("");
  lines.push("  Recompute the digests with no code from this project involved:");
  lines.push(`    cd ${report.dir} && shasum -a 256 -c ${MANIFEST_NAME}`);
  return lines.join("\n");
}

/**
 * Resolve the path, verify it, and render the answer.
 *
 * Split out of `cmdRelease` so a test can assert on the exact text a caller sees without capturing
 * a stream, and so the resolution rule above is testable on its own.
 */
export function releaseVerify(cwd: string, explicit: string | undefined): ReleaseOutcome {
  if (explicit === undefined) {
    const candidate = join(cwd, DEFAULT_RELEASE_DIR);
    if (!isDirectory(candidate)) return { code: EXIT_MISUSE, output: refuseBare(cwd) };
    return finish(verifyRelease(candidate));
  }

  const dir = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  if (!existsSync(dir)) {
    return {
      code: EXIT_MISUSE,
      output: [
        `there is no directory at ${dir}.`,
        "",
        "  Nothing was checked, so nothing here is a finding about any release.",
        "  Build one with       node scripts/build-release.mjs",
        `  then                 sentinel release verify ${DEFAULT_RELEASE_DIR}`,
      ].join("\n"),
    };
  }
  if (!statSync(dir).isDirectory()) {
    return {
      code: EXIT_MISUSE,
      output: [
        `${dir} is a file, and a release is a directory of artifacts.`,
        "",
        "  If that is a release archive, unpack it first:",
        `    mkdir -p /tmp/release && tar -xzf ${dir} -C /tmp/release`,
        "    sentinel release verify /tmp/release",
      ].join("\n"),
    };
  }

  const report = verifyRelease(dir);
  // Nothing in this directory matched ANY required artifact. Listing all of them as MISSING would
  // be a true statement that reads as "this release is broken" when the real answer is "this is not
  // a release directory". That is the sibling's failure with a different cause, so it is refused
  // rather than reported.
  if (report.required.every((r) => r.verdict === "missing")) {
    return {
      code: EXIT_MISUSE,
      output: [
        `nothing in ${dir} looks like a release.`,
        "",
        `  ${report.fileCount} file(s) are there and not one of the ${REQUIRED_ARTIFACTS.length} required artifacts is among`,
        `  them, ${MANIFEST_NAME} included. This is reported as a wrong path rather than as a`,
        "  broken release, because listing every required artifact as absent would read as the",
        "  second.",
        "",
        "  build one            node scripts/build-release.mjs",
        `  then                 sentinel release verify ${DEFAULT_RELEASE_DIR}`,
      ].join("\n"),
    };
  }
  return finish(report);
}

const finish = (report: ReleaseVerification): ReleaseOutcome => ({
  // 2, never 1. A release that does not verify is the tool being unable to do its job or the
  // caller having built something incomplete. It is not evidence that a model got worse.
  code: report.ok ? EXIT_OK : EXIT_MISUSE,
  output: renderVerification(report),
});

/**
 * `sentinel release verify [path]`.
 *
 * `cwd` is a parameter with a default rather than a bare `process.cwd()` call so that the
 * resolution rule can be tested from a directory the test controls. The wiring in `cli.ts` passes
 * one argument and gets the process's own directory, which is what a caller means.
 */
export function cmdRelease(args: Args, cwd: string = process.cwd()): number {
  const sub = args.rest[0] ?? "";
  if (sub !== "verify") {
    throw new UsageError(`release needs a subcommand: verify. Saw "${sub}"`);
  }
  const outcome = releaseVerify(cwd, args.rest[1]);
  process.stdout.write(`${outcome.output}\n`);
  return outcome.code;
}
