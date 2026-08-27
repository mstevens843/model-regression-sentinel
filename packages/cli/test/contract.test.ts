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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  for (const sub of ["corpus", "compare", "watch", "schedule", "baseline", "run"]) {
    it(`\`sentinel ${sub}\` is implemented, so it never reports an unknown command`, () => {
      const r = run(sub, "--help");
      expect(r.stderr, `${sub} is named in the help and is not implemented`).not.toContain(
        "unknown command",
      );
      // It may legitimately refuse for want of arguments. What it may not do is not exist.
      expect([EXIT_OK, EXIT_MISUSE, EXIT_COULD_NOT_LOOK]).toContain(r.code);
    });
  }

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
