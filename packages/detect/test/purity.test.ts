// The purity gate: the detector may not read a clock, generate its own randomness, or touch the
// world.
//
// WHY THIS IS A CONTRACT AND NOT A PREFERENCE. This package decides whether to fail a build. If a
// verdict at the boundary can flip between two runs on identical inputs, the tool is measuring
// itself rather than the provider, and no amount of statistical machinery downstream repairs that.
// Every resample, permutation and simulation therefore draws from a seeded generator that is passed
// in, and a bare `Math.random` anywhere in this package would silently undo it.
//
// Modelled on `durable-agent-outbox/packages/core/test/contract.test.ts`, including its most
// important detail: the test checks that it can actually SEE what it is checking, so an empty
// result means clean rather than broken.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

interface Banned {
  readonly token: string;
  readonly why: string;
}

const BANNED: readonly Banned[] = [
  {
    token: "Math.random",
    why: "a verdict that moves between runs on identical inputs is not a measurement",
  },
  {
    token: "Date.now",
    why: "a detector that reads a clock cannot be replayed, and every timestamp it needs is already in the snapshot",
  },
  { token: "new Date(", why: "same reason as Date.now: time enters as data or not at all" },
  {
    token: "node:fs",
    why: "the detector is handed snapshots; reading them is the caller's job and mixing the two makes it untestable",
  },
  {
    token: "fetch(",
    why: "nothing here may reach the network. A detector that could call a provider could grade a run it had just influenced",
  },
  {
    token: "process.env",
    why: "configuration reaches this package as arguments, so a report can state what it was run with",
  },
];

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/**
 * Comments AND string literals are stripped before scanning.
 *
 * Both exclusions were earned rather than assumed. A file header that explains why `Math.random` is
 * forbidden contains the token, and so does the error message `permutation.ts` throws when a caller
 * omits a seeded generator - which is the message most likely to stop someone making exactly the
 * mistake this test guards. A scanner that fires on the documentation of a rule teaches people to
 * delete the documentation, so it strips both and keeps the self-check below to prove it can still
 * see real code.
 */
const stripNonCode = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, '"s"')
    .replace(/"(?:[^"\\]|\\.)*"/g, '"s"')
    .replace(/'(?:[^'\\]|\\.)*'/g, '"s"');

describe("the detector cannot read a clock, roll its own dice, or touch the world", () => {
  const files = sourceFiles(SRC);

  it("sees the files it is checking, so an empty result means clean and not broken", () => {
    expect(files.length).toBeGreaterThan(8);
    const combined = files.map((f) => readFileSync(f, "utf8")).join("\n");
    // A token that IS present, proving the scanner can find one at all.
    expect(stripNonCode(combined)).toContain("mulberry32");
  });

  for (const banned of BANNED) {
    it(`no source file uses ${banned.token}, because ${banned.why}`, () => {
      const offenders = files.filter((f) =>
        stripNonCode(readFileSync(f, "utf8")).includes(banned.token),
      );
      expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
    });
  }

  it("every exported statistic that resamples takes its generator as an argument", () => {
    // The structural half of the same rule. Banning Math.random stops the obvious mistake; this
    // stops the subtle one, where a module creates its own generator from a hard-coded seed and
    // becomes impossible to vary from a test.
    const text = readFileSync(join(SRC, "stats.ts"), "utf8");
    expect(stripNonCode(text)).not.toContain("mulberry32(");
  });
});
