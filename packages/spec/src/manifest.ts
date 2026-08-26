// MANIFEST.sha256: reading it, checking it, and writing it.
//
// The format is not invented here. It is `agent-context-containment/corpus/*/MANIFEST.sha256`,
// byte for byte, so that `shasum -a 256 -c corpus/canary/MANIFEST.sha256` from the repository root
// checks this project's corpus with no tool from this project involved at all. That property is the
// entire point: an integrity check a reader can run without trusting the thing being checked.
//
//   <64 lowercase hex><two spaces><repo-root-relative POSIX path>\n
//
// sorted ascending by path, LF endings, trailing newline present. Two spaces, not one plus an
// asterisk: that is coreutils text mode, and it is what the sibling files use.
//
// FREEZE.json IS EXCLUDED FROM THE MANIFEST, deliberately, so that recording or clearing a freeze
// can never trip the drift check. The sibling states this twice in its scripts and it is the kind
// of detail that is obvious only after it has bitten someone.
//
// WHAT THIS ADDS TO THE SIBLING: a writer. There is no manifest generator anywhere in
// `agent-context-containment` - its manifests are produced by hand off-repo, which is a seam where
// a mistake leaves no trace. `writeManifest` closes it. What it must never become is a command
// somebody runs to make a red check go green; `verify-corpus.sh` carries that warning in the same
// words the sibling uses.

import { readFileSync } from "node:fs";
import { bytesHash } from "./canonical.js";

/** Files that live in a corpus directory and are not cases. An explicit list, never a heuristic. */
export const SIDECARS: ReadonlySet<string> = new Set([
  "FREEZE.json", // the freeze claim, excluded from the manifest on purpose. See the header.
  "MANIFEST.sha256", // hashes, not JSON at all
  "README.md", // prose about the split
]);

export interface ManifestEntry {
  readonly sha256: string;
  /** Repo-root-relative, POSIX separators. */
  readonly path: string;
}

/** How one file compared against its recorded digest. */
export interface ManifestCheck {
  readonly path: string;
  readonly status: "ok" | "changed" | "missing";
  readonly expected: string;
  readonly actual: string | null;
}

export interface ManifestResult {
  readonly ok: boolean;
  readonly checks: readonly ManifestCheck[];
  /** Files present on disk that the manifest does not mention. An addition is drift too. */
  readonly untracked: readonly string[];
}

const LINE = /^([0-9a-f]{64}) {2}(.+)$/;

/** Parse a manifest. Malformed lines are reported, not skipped: a line nobody parsed checks nothing. */
export function parseManifest(text: string): {
  readonly entries: readonly ManifestEntry[];
  readonly malformed: readonly string[];
} {
  const entries: ManifestEntry[] = [];
  const malformed: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const m = LINE.exec(raw);
    if (m === null || m[1] === undefined || m[2] === undefined) {
      malformed.push(raw);
      continue;
    }
    entries.push({ sha256: m[1], path: m[2] });
  }
  return { entries, malformed };
}

/** Render entries in the canonical manifest form. Sorted by path, trailing newline. */
export function renderManifest(entries: readonly ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sorted.map((e) => `${e.sha256}  ${e.path}`).join("\n") + (sorted.length > 0 ? "\n" : "");
}

/**
 * Check a manifest against the filesystem.
 *
 * `readFile` is injected so this is testable without a disk, and so the same function can check a
 * corpus embedded in a tarball. Returns every problem rather than the first.
 */
export function checkManifest(
  entries: readonly ManifestEntry[],
  present: readonly string[],
  readFile: (path: string) => Uint8Array | string | null,
): ManifestResult {
  const checks: ManifestCheck[] = [];
  for (const entry of entries) {
    const bytes = readFile(entry.path);
    if (bytes === null) {
      checks.push({ path: entry.path, status: "missing", expected: entry.sha256, actual: null });
      continue;
    }
    const actual = bytesHash(bytes);
    checks.push({
      path: entry.path,
      status: actual === entry.sha256 ? "ok" : "changed",
      expected: entry.sha256,
      actual,
    });
  }
  const tracked = new Set(entries.map((e) => e.path));
  const untracked = present.filter((p) => !tracked.has(p)).sort();
  return {
    ok: checks.every((c) => c.status === "ok") && untracked.length === 0,
    checks,
    untracked,
  };
}

/** Build manifest entries by hashing raw file bytes. Sidecars are skipped. */
export function buildManifest(
  paths: readonly string[],
  readFile: (path: string) => Uint8Array | string = (p) => readFileSync(p),
): readonly ManifestEntry[] {
  return paths
    .filter((p) => !SIDECARS.has(basename(p)))
    .map((path) => ({ sha256: bytesHash(readFile(path)), path }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const basename = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};
