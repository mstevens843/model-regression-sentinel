// House-style gates that apply to the whole repository.
//
// Two of these are the sibling projects' conventions turned into tests rather than intentions. The
// dash rule is audited in `durable-agent-outbox/RESULTS.md` under its own heading; the secret scan
// is `agent-context-containment/packages/conformance/test/modeljudge.test.ts` and its Python twin.
// Both are cheap and both catch a class of mistake that is embarrassing rather than subtle, which
// is exactly the kind worth automating.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".turbo", ".git", "coverage", "baselines"]);

/**
 * Directories holding RECORDED PROVIDER OUTPUT, which is evidence and not prose.
 *
 * The dash rule is about text this project AUTHORS. A model writes what it writes, and the recorded
 * runs under `results/runs/` contain em-dashes because the provider produced them: one baseline
 * reply reads "not semantic correctness - so a payment destination", with an em-dash where that
 * hyphen is.
 *
 * Those bytes must stay verbatim. `packages/baseline` stores raw outputs precisely so a later
 * analysis can ask new questions of an old run, every grader re-derives its verdict from that text,
 * and both calibration studies re-read it thousands of times. Rewriting a recorded output to satisfy
 * a style rule would falsify the measurement, which is a far worse outcome than an em-dash sitting
 * in a data file. So the scan skips them, deliberately and on the record, rather than the rule being
 * quietly weakened everywhere.
 */
// Any directory of RECORDED PROVIDER OUTPUT, not just the first one.
//
// This was `["runs"]`, and the first fresh collection landed in `results/runs-v2/` - so the style
// scan reached bytes the model wrote and the suite went red for a dash the provider chose. The
// exclusion is about what the bytes ARE, not about which directory they happen to be in: a recorded
// output is evidence, every grader re-derives its verdict from that exact text, and rewriting one
// to satisfy a style rule would falsify the measurement.
//
// The guard below is what keeps this from becoming a blanket: every excluded directory must
// actually contain recorded runs, checked file by file.
const EVIDENCE_DIRS = (name: string): boolean => name === "runs" || name.startsWith("runs-");
const TEXT = /\.(ts|tsx|mjs|js|json|md|yml|yaml|sh|txt)$/;

function walk(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || EVIDENCE_DIRS(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (TEXT.test(entry)) out.push(full);
  }
  return out;
}

describe("house style", () => {
  const files = walk(REPO);

  it("sees the tree it is checking, so an empty result means clean and not broken", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith("README.md") || f.endsWith("package.json"))).toBe(true);
  });

  it("contains no em-dash, en-dash or any other dash variant", () => {
    // Built from char codes so this file does not itself contain the characters it forbids.
    const variants = [0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d].map((c) =>
      String.fromCharCode(c),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const v of variants) {
        const at = text.indexOf(v);
        if (at !== -1) {
          const line = text.slice(0, at).split("\n").length;
          offenders.push(`${file.slice(REPO.length)}:${line}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contains nothing shaped like an API key", () => {
    // A BYOK tool must never write a credential into a committed file. The pattern is assembled in
    // pieces so this file does not match itself.
    const patterns = [
      new RegExp(`sk${"-"}ant${"-"}[A-Za-z0-9_-]{16,}`),
      new RegExp(`sk${"-"}[A-Za-z0-9]{32,}`),
      /\bAKIA[0-9A-Z]{16}\b/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const p of patterns) if (p.test(text)) offenders.push(file.slice(REPO.length));
    }
    expect(offenders).toEqual([]);
  });

  it("opens every source file with a comment block, because that is the house's strongest rule", () => {
    const sources = files.filter((f) => f.endsWith(".ts") && f.includes(`${join("src")}${"/"}`));
    expect(sources.length).toBeGreaterThan(20);
    const bare: string[] = [];
    for (const file of sources) {
      // A shebang has to be the first bytes of an executable, so the header follows it rather than
      // preceding it. The rule is that the file EXPLAINS ITSELF before it does anything, and a
      // shebang does not do anything.
      const head = readFileSync(file, "utf8")
        .trimStart()
        .replace(/^#![^\n]*\n/, "")
        .trimStart();
      if (!head.startsWith("//")) bare.push(file.slice(REPO.length));
    }
    expect(bare).toEqual([]);
  });

  it("keeps the recorded runs verbatim, which is why the dash scan skips them", () => {
    // Guards the exclusion above from becoming a blanket. If `results/runs/` ever stops holding
    // recorded provider output, this exclusion has to be revisited rather than inherited.
    const results = join(REPO, "results");
    if (!existsSync(results)) return;
    const excluded = readdirSync(results).filter(EVIDENCE_DIRS);
    // The exclusion must cover something, or this test certifies an empty set.
    expect(
      excluded.length,
      "no recorded-run directory exists to justify the exclusion",
    ).toBeGreaterThan(0);
    for (const dir of excluded) {
      const runs = join(results, dir);
      const entries = readdirSync(runs).filter((f) => f.endsWith(".json"));
      expect(entries.length, `${dir} is excluded from the dash scan and is empty`).toBeGreaterThan(
        0,
      );
      for (const entry of entries) {
        const snapshot = JSON.parse(readFileSync(join(runs, entry), "utf8")) as {
          readonly records?: readonly unknown[];
        };
        expect(Array.isArray(snapshot.records), `${dir}/${entry} is not a recorded run`).toBe(true);
      }
    }
  });

  it("ends every relative import with .js, as NodeNext requires", () => {
    const sources = files.filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/from\s+"(\.[^"]*)"/g)) {
        const spec = m[1] as string;
        if (!spec.endsWith(".js")) offenders.push(`${file.slice(REPO.length)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses no TypeScript enum anywhere", () => {
    const offenders = files
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /^\s*(export\s+)?(const\s+)?enum\s/m.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(REPO.length));
    expect(offenders).toEqual([]);
  });
});
