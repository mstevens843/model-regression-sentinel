// The promises this repository makes on the command line, asserted rather than intended.
//
// v0.1 shipped four `package.json` scripts pointing at files that did not exist. Nothing caught it,
// because a script is only exercised when somebody runs it, and nobody runs the ones they do not
// know about. A manifest that lists a command which errors on contact is worse than one that omits
// it: the reader believes the command exists and concludes the tool is broken rather than the doc.
//
// So: every script resolves, every documented subcommand runs, and the exit-code contract is
// checked by INVOKING THE BINARY rather than by calling a function that returns a number. The
// distinction matters. `exitCodeFor` returning 1 is a claim about a function; `node cli.js` exiting
// 1 is a claim about the product, and only the second is what a pipeline reads.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT_CODES,
  EXIT_CONFIRMED_REGRESSION,
  EXIT_COULD_NOT_LOOK,
  EXIT_MISUSE,
  EXIT_OK,
} from "@model-regression-sentinel/spec";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(REPO, "packages/cli/dist/cli.js");
const RUNS = join(REPO, "results/runs");

const built = existsSync(CLI);
const haveRuns = existsSync(join(RUNS, "baseline.json"));

/** Run the real binary and report the real exit code. Never throws on a non-zero exit. */
const run = (...args: string[]): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync("node", [CLI, ...args], { cwd: REPO, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

describe("every package.json script points at something that exists", () => {
  const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  const onDisk = new Set(readdirSync(join(REPO, "scripts")));

  it("sees the scripts it is checking, so an empty result means clean and not broken", () => {
    expect(Object.keys(manifest.scripts).length).toBeGreaterThan(8);
    expect(onDisk.size).toBeGreaterThan(3);
  });

  it("has no script referring to a file that is not there", () => {
    // The v0.1 defect, made impossible to reintroduce silently.
    const missing: string[] = [];
    for (const [name, command] of Object.entries(manifest.scripts)) {
      for (const m of command.matchAll(/scripts\/([A-Za-z0-9._-]+)/g)) {
        const file = m[1] as string;
        if (!onDisk.has(file)) missing.push(`${name} -> scripts/${file}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has no script referring to an examples file that is not there", () => {
    const missing: string[] = [];
    for (const [name, command] of Object.entries(manifest.scripts)) {
      for (const m of command.matchAll(/examples\/([A-Za-z0-9._-]+)/g)) {
        const file = m[1] as string;
        if (!existsSync(join(REPO, "examples", file))) missing.push(`${name} -> examples/${file}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has a turbo task behind every turbo-delegating script", () => {
    const turbo = JSON.parse(readFileSync(join(REPO, "turbo.json"), "utf8")) as {
      readonly tasks: Readonly<Record<string, unknown>>;
    };
    const missing: string[] = [];
    for (const [name, command] of Object.entries(manifest.scripts)) {
      const m = /turbo run ([a-z:]+)/.exec(command);
      if (m !== null && !((m[1] as string) in turbo.tasks)) missing.push(`${name} -> ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
});

describe.runIf(built)("every subcommand named in the help actually runs", () => {
  const help = run("--help").stdout;

  it("prints a usage block naming the subcommands", () => {
    expect(help).toContain("sentinel");
    expect(help.length).toBeGreaterThan(200);
  });

  // Parsed from the help rather than hard-coded, so a command added to the usage text without an
  // implementation fails here instead of being discovered by a reader.
  const named = [...help.matchAll(/^ {2}sentinel ([a-z]+)/gm)].map((m) => m[1] as string);
  const subcommands = [...new Set(named)];

  it("names at least the commands this version ships", () => {
    expect(subcommands.length).toBeGreaterThanOrEqual(5);
    for (const expected of ["corpus", "compare", "watch", "schedule", "baseline"]) {
      expect(subcommands, `${expected} missing from the usage block`).toContain(expected);
    }
  });

  // THIS TEST WAS VACUOUS AND SAID SO IN ITS OWN NAME. It ran `sentinel <sub> --help`, and
  // `cli.ts` short-circuits on `--help` BEFORE dispatch - so it passed for any string at all:
  // `sentinel definitely-not-a-command --help` exits 0 and prints the usage. Its stated guarantee,
  // "a command added to the usage text without an implementation fails here", did not hold.
  //
  // Invoking WITHOUT `--help` is what actually reaches the dispatcher. A real subcommand may refuse
  // for want of arguments; what it may not do is come back "unknown command".
  for (const sub of ["corpus", "compare", "watch", "schedule", "baseline", "run"]) {
    it(`\`sentinel ${sub}\` reaches the dispatcher and is implemented`, () => {
      const r = run(sub);
      const said = `${r.stdout}${r.stderr}`;
      expect(said, `${sub} is named in the help and is not implemented`).not.toContain(
        "unknown command",
      );
      expect([EXIT_OK, EXIT_MISUSE, EXIT_COULD_NOT_LOOK]).toContain(r.code);
    });
  }

  it("and the check above can actually fail, which is the part that was missing", () => {
    // The negative control the vacuous version could never have had.
    const r = run("definitely-not-a-command");
    expect(`${r.stdout}${r.stderr}`).toContain("unknown command");
    expect(r.code).toBe(EXIT_MISUSE);
  });

  it("prints the exit-code contract, so it travels with the tool", () => {
    for (const e of EXIT_CODES) expect(help).toContain(e.name);
  });
});

describe.runIf(built)("the exit-code contract, checked by running the binary", () => {
  it("0 for help", () => {
    expect(run("--help").code).toBe(EXIT_OK);
  });

  it("2 for an unknown command, and it names what it did not understand", () => {
    const r = run("definitely-not-a-command");
    expect(r.code).toBe(EXIT_MISUSE);
    expect(r.stderr).toContain("definitely-not-a-command");
  });

  it("2 for a missing required flag rather than a crash", () => {
    expect(run("compare").code).toBe(EXIT_MISUSE);
  });

  it("2 for a file that is not there", () => {
    expect(run("compare", "--baseline", "nope.json", "--candidate", "nope.json").code).toBe(
      EXIT_MISUSE,
    );
  });

  it.runIf(haveRuns)("0 on an A/A pair, because nothing was confirmed", () => {
    const r = run(
      "compare",
      "--baseline",
      join(RUNS, "baseline.json"),
      "--candidate",
      join(RUNS, "candidate.json"),
    );
    expect(r.code).toBe(EXIT_OK);
  });

  it.runIf(haveRuns)("1 only on a confirmed regression", () => {
    // The paired "must" beside every "must not" above. A contract where 1 is unreachable would pass
    // every other assertion here and be worthless.
    const r = run(
      "compare",
      "--baseline",
      join(RUNS, "baseline.json"),
      "--candidate",
      join(RUNS, "positive-control.json"),
      "--confirm",
      join(RUNS, "positive-control.json"),
    );
    expect(r.code).toBe(EXIT_CONFIRMED_REGRESSION);
  });

  it.runIf(haveRuns)("2, not 1, for two runs of different corpora", () => {
    // Misuse is not a regression. A pipeline that conflated them would treat a wrong file path as a
    // model getting worse.
    const r = run(
      "compare",
      "--baseline",
      join(RUNS, "baseline.json"),
      "--candidate",
      join(RUNS, "candidate.json"),
      "--split",
      "canary",
    );
    expect([EXIT_MISUSE, EXIT_OK]).toContain(r.code);
    if (r.code === EXIT_MISUSE) expect(r.stdout + r.stderr).toContain("NOT_COMPARABLE");
  });
});

describe.runIf(built)("machine-readable output is strict", () => {
  const strict = (text: string, label: string): void => {
    expect(() => JSON.parse(text) as unknown, `${label} did not parse`).not.toThrow();
    // NaN and Infinity are not JSON. They are also the exact values that broke `--format json` in
    // v0.1, so this is a regression test rather than a style preference.
    expect(text, `${label} contains NaN`).not.toContain("NaN");
    expect(text, `${label} contains Infinity`).not.toContain("Infinity");
    expect(text, `${label} contains undefined`).not.toContain("undefined");
  };

  it("`corpus --json` parses and carries no non-JSON numbers", () => {
    const r = run("corpus", "--json");
    expect(r.code).toBe(EXIT_OK);
    strict(r.stdout, "corpus --json");
  });

  it.runIf(haveRuns)("`compare --format json` parses and carries no non-JSON numbers", () => {
    const r = run(
      "compare",
      "--baseline",
      join(RUNS, "baseline.json"),
      "--candidate",
      join(RUNS, "candidate.json"),
      "--format",
      "json",
    );
    expect(r.code).toBe(EXIT_OK);
    strict(r.stdout, "compare --format json");
  });

  it.runIf(haveRuns)("`compare --format json` is byte-stable across two renders", () => {
    const once = run(
      "compare",
      "--baseline",
      join(RUNS, "baseline.json"),
      "--candidate",
      join(RUNS, "candidate.json"),
      "--format",
      "json",
    ).stdout;
    const twice = run(
      "compare",
      "--baseline",
      join(RUNS, "baseline.json"),
      "--candidate",
      join(RUNS, "candidate.json"),
      "--format",
      "json",
    ).stdout;
    expect(once).toBe(twice);
  });
});

describe("the build produces the binary the manifest promises", () => {
  it("names a bin whose target exists after a build", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "packages/cli/package.json"), "utf8")) as {
      readonly bin?: Readonly<Record<string, string>>;
    };
    const bin = pkg.bin ?? {};
    expect(Object.keys(bin).length).toBeGreaterThan(0);
    for (const [name, target] of Object.entries(bin)) {
      if (!built) continue;
      expect(existsSync(join(REPO, "packages/cli", target)), `bin ${name} -> ${target}`).toBe(true);
    }
  });

  it("is reachable as `sentinel` from the workspace root", () => {
    if (!built) return;
    const linked = join(REPO, "node_modules/.bin/sentinel");
    expect(existsSync(linked), "the README quickstart uses `pnpm exec sentinel`").toBe(true);
    expect(() => execFileSync(linked, ["--help"], { cwd: REPO, encoding: "utf8" })).not.toThrow();
  });
});

// THE THREE DEFECTS THIS FILE EXISTED AND DID NOT CATCH.
//
// Everything above asserts that documented things exist and that the exit codes discriminate. None
// of it caught any of the following, because each needs an input nobody would type on purpose: a
// collection that failed completely, a mistyped threshold, or the tool's own printed instruction
// taken literally. Those are exactly the inputs a real operator eventually produces.
describe("a run that could not look is not a run that found nothing", () => {
  const skip = !built || !haveRuns;

  /** A candidate arm in which every call failed, written beside the real ones. */
  const outageArm = (): string => {
    const snapshot = JSON.parse(readFileSync(join(RUNS, "candidate.json"), "utf8")) as {
      records: { response: { error: string; text: string } }[];
      errorCount: number;
    };
    for (const r of snapshot.records) {
      r.response.error = "ECONNREFUSED";
      r.response.text = "";
    }
    snapshot.errorCount = snapshot.records.length;
    const path = join(REPO, "packages/cli/test/.outage-arm.json");
    writeFileSync(path, JSON.stringify(snapshot));
    return path;
  };

  it.skipIf(skip)("exits 3, not 0, when every call in an arm failed", () => {
    const path = outageArm();
    try {
      const r = run("compare", "--baseline", join(RUNS, "baseline.json"), "--candidate", path);
      // 3 and not 0: an outage is not a clean run. 3 and not 1: it is not evidence the provider
      // got worse. This shipped as 0 with the verdict NO_DRIFT.
      expect(r.code, r.stdout).toBe(EXIT_COULD_NOT_LOOK);
      // The VERDICT line specifically. Prose elsewhere in the report legitimately mentions
      // NO_DRIFT while explaining why this run is not one, and asserting on the whole document
      // would forbid the tool from naming the thing it is refusing to claim.
      const verdictLine = r.stdout.split("\n").find((l) => l.includes("VERDICT")) ?? "";
      expect(verdictLine, r.stdout).not.toContain("NO_DRIFT");
      expect(verdictLine).toContain("INCONCLUSIVE");
      // The sentence has to name what failed. "could not look" is not actionable.
      expect(r.stdout).toContain("ECONNREFUSED");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it.skipIf(skip)("says the same thing to a machine as it does to a person", () => {
    const path = outageArm();
    try {
      const r = run(
        "compare",
        "--baseline",
        join(RUNS, "baseline.json"),
        "--candidate",
        path,
        "--format",
        "json",
      );
      const body = JSON.parse(r.stdout) as { verdict: string; couldNotLook: string | null };
      expect(body.verdict).not.toBe("NO_DRIFT");
      // A pipeline must be able to tell "underpowered" from "never reached the provider" without
      // parsing prose, so the discriminator is a field rather than a sentence in `reason`.
      expect(body.couldNotLook).toContain("ECONNREFUSED");
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("a mistyped flag is refused, never silently coerced", () => {
  const skip = !built || !haveRuns;
  const B = join(RUNS, "baseline.json");
  const P = join(RUNS, "positive-control.json");

  it.skipIf(skip)(
    "the flagship case: --alpha bogus must not downgrade a confirmed regression",
    () => {
      // Number("bogus") is NaN, `?? 0.05` cannot catch it because NaN is not nullish, and every
      // `p <= NaN` is false - so a real reproduced regression exited 0. Measured, not imagined.
      const good = run("compare", "--baseline", B, "--candidate", P, "--confirm", P);
      expect(good.code, good.stdout).toBe(EXIT_CONFIRMED_REGRESSION);

      const bad = run(
        "compare",
        "--baseline",
        B,
        "--candidate",
        P,
        "--confirm",
        P,
        "--alpha",
        "bogus",
      );
      expect(bad.code, bad.stdout).toBe(EXIT_MISUSE);
      expect(bad.code).not.toBe(EXIT_OK);
    },
  );

  it.skipIf(skip)("refuses every numeric flag that is not a number", () => {
    const cases: readonly (readonly string[])[] = [
      ["compare", "--baseline", B, "--candidate", P, "--alpha", "bogus"],
      ["compare", "--baseline", B, "--candidate", P, "--alpha", "1e999"],
      ["compare", "--baseline", B, "--candidate", P, "--target-effect", "bogus"],
      ["run", "--label", "x", "--replicates", "bogus"],
      ["run", "--label", "x", "--concurrency", "oops"],
      ["schedule", "--every", "nope"],
    ];
    for (const argv of cases) {
      const r = run(...argv);
      expect(r.code, `${argv.join(" ")} -> ${r.code}\n${r.stdout}${r.stderr}`).toBe(EXIT_MISUSE);
    }
  });

  it.skipIf(skip)("still accepts the values it should", () => {
    const r = run("compare", "--baseline", B, "--candidate", P, "--confirm", P, "--alpha", "0.05");
    expect(r.code, r.stdout).toBe(EXIT_CONFIRMED_REGRESSION);
  });
});

describe("the tool's own instructions are flags the tool parses", () => {
  it("every --flag printed in DEFAULT_CONFIRM_COMMAND is one the parser accepts", async () => {
    // It printed `--confirmation` while the CLI parses `--confirm`, and unknown flags are accepted
    // silently - so following the tool's own next-step instruction produced a second
    // SUSPECTED_DRIFT saying "No confirmation arm was supplied", with nothing explaining why. That
    // closes the SUSPECTED -> CONFIRMED promotion path, which is the transition this project exists
    // to make possible.
    const { DEFAULT_CONFIRM_COMMAND } = (await import("@model-regression-sentinel/report")) as {
      DEFAULT_CONFIRM_COMMAND: string;
    };
    const source = readFileSync(join(REPO, "packages/cli/src/commands.ts"), "utf8");
    const printed = [...DEFAULT_CONFIRM_COMMAND.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]);
    expect(printed.length).toBeGreaterThan(2);
    for (const name of printed) {
      expect(source, `the report tells people to pass --${name}, which nothing parses`).toContain(
        `"${name as string}"`,
      );
    }
  });
});

// THE THIRD PARTY TO EVERY COMPARISON: THE CASE LIST.
//
// `compare` checked the two snapshots against EACH OTHER and never against the corpus it was
// handed, so it would analyse a run using a case list it was not collected against - pairing the
// ids that happened to overlap and silently dropping the rest. Measured on this repository's own
// artifacts, the SAME two v0.2 snapshots gave:
//
//     case list          verdict         schemaValid          exit
//     all 34 (correct)   NO_DRIFT        10 cases, mde 0.25      0
//     v1 24 (wrong)      INCONCLUSIVE     2 cases, mde null      0
//
// Ten cases whose records sit in the snapshot discarded, a gating metric computed on a fifth of its
// evidence, the verdict flipped, and both exits 0.
describe("a run is refused against a corpus it was not collected on", () => {
  const V1 = join(RUNS, "baseline.json");
  const V1B = join(RUNS, "candidate.json");
  const V2 = join(REPO, "results/runs-v2/baseline.json");
  const V2B = join(REPO, "results/runs-v2/candidate.json");
  const haveV2 = existsSync(V2);
  const skip = !built || !haveRuns;

  it.skipIf(skip)("v0.1 runs with the v0.1 corpus are analysed", () => {
    const r = run("compare", "--split", "v1", "--baseline", V1, "--candidate", V1B);
    expect(r.code, r.stdout).toBe(EXIT_OK);
  });

  it.skipIf(skip)("v0.1 runs with the 34-case corpus are REFUSED", () => {
    const r = run("compare", "--split", "all", "--baseline", V1, "--candidate", V1B);
    expect(r.code, r.stdout).toBe(EXIT_MISUSE);
    expect(r.stdout).toContain("NOT_COMPARABLE");
    // The message has to name both digests, or a reader cannot tell which corpus to load.
    expect(r.stdout).toMatch(/collected against corpus digest [0-9a-f]{16}/);
  });

  it.skipIf(skip || !haveV2)("v0.2 runs with the 34-case corpus are analysed", () => {
    const r = run("compare", "--split", "all", "--baseline", V2, "--candidate", V2B);
    expect(r.code, r.stdout).toBe(EXIT_OK);
  });

  it.skipIf(skip || !haveV2)("v0.2 runs with the v0.1 corpus are REFUSED", () => {
    // The direction that actually loses data: those ten cases WERE run and their records are in
    // the file. Analysing against the smaller list throws them away without saying so.
    const r = run("compare", "--split", "v1", "--baseline", V2, "--candidate", V2B);
    expect(r.code, r.stdout).toBe(EXIT_MISUSE);
  });

  it.skipIf(skip)("and with no --split the tool reads the corpus off the snapshot", () => {
    // Being exact would otherwise make the default invocation in this project's own quickstart
    // exit 2 for a corpus the user never chose. The snapshot records what it was collected
    // against; the tool reads it rather than making the caller remember.
    expect(run("compare", "--baseline", V1, "--candidate", V1B).code).toBe(EXIT_OK);
    if (haveV2) expect(run("compare", "--baseline", V2, "--candidate", V2B).code).toBe(EXIT_OK);
  });
});

// THE GUARD OVER THE ONE THING IN THIS REPOSITORY THAT CANNOT BE REBUILT.
//
// `results/runs/` holds 960 paid provider calls and `results/runs-v2/` holds 1,360 more. They
// cannot be recollected: a second collection samples a different week of the thing under
// observation, so re-running does not reproduce them, it replaces them with different evidence.
//
// `run-study.mjs` used to write `${label}.json` into a hardcoded directory with no existence check,
// so the command anyone would type to collect over the new split destroyed all four v0.1 arms. The
// guard runs BEFORE the first call and before `--yes` is honoured, which is why this test costs
// nothing: it never reaches a provider.
describe("a collection cannot overwrite a paid artifact without explicit intent", () => {
  const STUDY = join(REPO, "scripts/run-study.mjs");
  const study = (...args: string[]): { code: number; out: string } => {
    const r = spawnSync("node", [STUDY, ...args], { cwd: REPO, encoding: "utf8" });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  it("refuses a run whose arms already exist, even with --yes", () => {
    // --yes is deliberately included. The guard has to fire in the presence of the flag that means
    // "spend the money", because that is the only invocation that could ever have destroyed
    // anything, and a guard that only protects the dry run protects nothing.
    const r = study("--split", "v1", "--replicates", "1", "--yes");
    expect(r.code, r.out).toBe(EXIT_MISUSE);
    expect(r.out).toContain("REFUSING TO COLLECT");
    // It must name the files at stake rather than saying "a file exists".
    expect(r.out).toContain("results/runs/baseline.json");
    // And offer both ways out, so the refusal is actionable rather than a wall.
    expect(r.out).toContain("--out");
    expect(r.out).toContain("--overwrite");
  });

  it("and the arms are still there afterwards", () => {
    for (const f of ["baseline", "candidate", "confirmation", "positive-control"]) {
      expect(existsSync(join(RUNS, `${f}.json`)), `${f}.json was destroyed`).toBe(true);
    }
  });

  it("sends a run over a different corpus somewhere else, and protects that too", () => {
    // A run over all three splits carries a different corpusDigest, so it is NOT_COMPARABLE with
    // the arms in results/runs/. A directory holding two mutually incomparable studies is one
    // nobody can safely pass to `compare`, so the default output follows the corpus rather than one
    // convenient path.
    const r = study("--split", "all", "--replicates", "1");
    expect(r.out).toContain("results/runs-v2/");
    // BOTH collections are now paid for, so BOTH are guarded. Which branch this takes depends only
    // on whether the v0.2 arms have been collected in this checkout, and either answer is correct -
    // what must never happen is a silent overwrite.
    if (existsSync(join(REPO, "results/runs-v2/baseline.json"))) {
      expect(r.code, r.out).toBe(EXIT_MISUSE);
      expect(r.out).toContain("REFUSING TO COLLECT");
      expect(r.out).toContain("results/runs-v2/baseline.json");
    } else {
      expect(r.code, r.out).toBe(EXIT_OK);
      expect(r.out).toContain("re-run with --yes");
    }
  });

  it("refuses an unknown split rather than dying inside readdirSync", () => {
    const r = study("--split", "definitely-not-a-split");
    expect(r.code, r.out).toBe(EXIT_MISUSE);
    expect(r.out).toContain("--split must be one of");
  });
});
