// The end to end test, and the only one in this repository that asserts the product.
//
// THE EXIT CODE IS THE PRODUCT. Everything else this tool prints is for a person; the exit code is
// what a pipeline reads, and it is the one output that must never be wrong. Every other test in
// this workspace calls a function and inspects its return value, which is fine and which cannot see
// the three layers between a verdict and a process's status: `exitCodeFor`, the `main()` dispatch
// that returns a number, and the `.then` that assigns it to `process.exitCode` rather than calling
// `process.exit` so buffered stdout survives being piped. So this file SPAWNS THE BUILT BINARY and
// reads the real status.
//
// THE THREE VALUES MEAN THREE DIFFERENT THINGS AND ARE ASSERTED SEPARATELY.
//
//   0  nothing confirmed. The A/A pair below is two runs of the same corpus against the same alias
//      collected two minutes apart, and a drift tool that goes red on that is a drift tool nobody
//      keeps. This is the anti-vacuity case's opposite number and it is the more important of the
//      two, because a tool that never fires passes every honesty property there is.
//   1  a CONFIRMED regression. The positive control is a genuinely different model behind the same
//      command, so a run that could not produce a 1 here would be a run that cannot detect
//      anything.
//   2  the tool could not do its job. An unknown command is misuse, and misuse is not a regression.
//
// BOTH DIRECTIONS ARE REQUIRED, and that is the whole argument for this file. Either one alone is
// satisfied by a constant: a tool that always exits 0 passes the A/A case perfectly, and a tool
// that always exits 1 passes the positive control perfectly. Only the pair says the binary
// discriminates.
//
// THE RECORDED RUNS ARE OPTIONAL. `results/runs/` holds real collected data and is not something a
// fresh clone necessarily has, so the end to end cases are SKIPPED rather than failed when it is
// absent, and the skip is loud in the test name. A skipped assertion states that nothing was
// checked, which is the honest report; a passing assertion over data that was never there is not.
// The same applies to `dist/`: this package's own build is not a dependency of its own test task,
// so the binary is checked for rather than assumed.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BINARY = join(REPO, "packages", "cli", "dist", "cli.js");
const RUNS = join(REPO, "results", "runs");

const run = (path: string): string => join(RUNS, path);

/** Present only after `pnpm build`. Every case that spawns the binary is gated on it. */
const HAVE_BINARY = existsSync(BINARY);
/** Present only after a real collection. See the header: absent means skipped, never assumed. */
const HAVE_RUNS = ["baseline.json", "candidate.json", "positive-control.json"].every((name) =>
  existsSync(run(name)),
);

interface Outcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One invocation of the real binary, from the repository root.
 *
 * The cwd is load-bearing: `sentinel compare` loads `corpus/` relative to where it was invoked, the
 * same way a person running it from their project root does.
 */
function sentinel(...argv: readonly string[]): Outcome {
  const result = spawnSync(process.execPath, [BINARY, ...argv], {
    cwd: REPO,
    encoding: "utf8",
    // Generous, because a comparison runs 500 calibration splits and a power simulation per metric.
    timeout: 120_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("the binary this test spawns is the binary that ships", () => {
  it("is built, so a skipped end to end suite below means missing and not broken", () => {
    // Stated as an assertion rather than left implicit. If this ever fails the fix is `pnpm build`,
    // and knowing that is worth more than a suite that silently checked nothing.
    expect(HAVE_BINARY, `${BINARY} is missing; run pnpm build`).toBe(true);
  });
});

describe("the command answers a person before it answers a pipeline", () => {
  it.runIf(HAVE_BINARY)("prints the usage and exits 0 on --help", () => {
    const { status, stdout } = sentinel("--help");
    expect(status).toBe(0);
    expect(stdout).toContain("sentinel - watch a pinned model alias");
    expect(stdout).toContain("sentinel compare --baseline <file> --candidate <file>");
    // The exit codes are documented in the usage itself, because they are the contract.
    expect(stdout).toContain("exit codes");
  });

  it.runIf(HAVE_BINARY)("prints the usage and exits 0 on no arguments at all", () => {
    const { status, stdout } = sentinel();
    expect(status).toBe(0);
    expect(stdout).toContain("sentinel - watch a pinned model alias");
  });

  it.runIf(HAVE_BINARY)(
    "exits 2 on an unknown command and names the command it did not know",
    () => {
      // 2 and not 1: misuse is not a regression, and a pipeline that conflates the two will
      // eventually treat a typo as a passing build or a crash as a regression.
      const { status, stderr } = sentinel("compair");
      expect(status).toBe(2);
      expect(stderr).toContain('unknown command "compair"');
      // The usage follows the error, so the fix is on screen rather than a second command away.
      expect(stderr).toContain("sentinel compare --baseline");
    },
  );

  it.runIf(HAVE_BINARY)("exits 2 when a required flag is missing, naming the flag", () => {
    const { status, stderr } = sentinel("compare");
    expect(status).toBe(2);
    expect(stderr).toContain("--baseline is required");
  });
});

describe("the exit code discriminates on real collected runs", () => {
  it.runIf(HAVE_BINARY && HAVE_RUNS)(
    "exits 0 on a real A/A pair, because the tool must stay quiet",
    () => {
      // baseline.json and candidate.json are two collections of one frozen corpus against one
      // alias, two minutes apart. There is no drift in them to find, and a tool that goes red here
      // is a tool that gets removed from the pipeline the second time it happens.
      const { status, stdout } = sentinel(
        "compare",
        "--baseline",
        run("baseline.json"),
        "--candidate",
        run("candidate.json"),
      );
      expect(status).toBe(0);
      expect(stdout).toContain("DRIFT REPORT");
      expect(stdout).not.toContain("CONFIRMED_DRIFT");
    },
  );

  it.runIf(HAVE_BINARY && HAVE_RUNS)("exits 1 on a confirmed real cross-model difference", () => {
    // The other direction, and the reason the case above is evidence of anything. positive-control
    // is a genuinely different model behind the same command, passed as the confirmation arm as
    // well, so the finding is required to reproduce before it is allowed to fail a build.
    const { status, stdout } = sentinel(
      "compare",
      "--baseline",
      run("baseline.json"),
      "--candidate",
      run("positive-control.json"),
      "--confirm",
      run("positive-control.json"),
    );
    expect(status).toBe(1);
    expect(stdout).toContain("CONFIRMED_DRIFT");
  });

  it.runIf(HAVE_BINARY && HAVE_RUNS)("emits parseable JSON under --format json", () => {
    // The machine-readable arm of the same comparison. It is `canonicalJson`, so a NaN anywhere in
    // the document is a hard failure rather than a silent null, and this is the case that catches
    // it.
    const { status, stdout } = sentinel(
      "compare",
      "--baseline",
      run("baseline.json"),
      "--candidate",
      run("candidate.json"),
      "--format",
      "json",
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      readonly schemaVersion: number;
      readonly verdict: string;
      readonly exitCode: number;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.verdict).toBe("INCONCLUSIVE");
    // The document says the code the process returned. Two renderings of one decision, agreeing.
    expect(parsed.exitCode).toBe(status);
  });

  it.runIf(HAVE_BINARY && HAVE_RUNS)("exits 2 when handed a file that does not exist", () => {
    // A missing file is the tool being unable to do its job, not the provider having moved.
    const { status } = sentinel(
      "compare",
      "--baseline",
      run("no-such-run.json"),
      "--candidate",
      run("candidate.json"),
    );
    expect(status).toBe(2);
  });
});

describe("commands that spend money print a plan and do nothing without consent", () => {
  it.runIf(HAVE_BINARY)("describes the calls it would make and exits 0 without --yes", () => {
    // No provider is reached and no key is required: `cmdRun` returns before constructing one. A
    // tool that could spend money on a typo is a tool nobody runs on a schedule.
    const { status, stdout } = sentinel("run", "--label", "dry", "--replicates", "2");
    expect(status).toBe(0);
    expect(stdout).toContain("This spends real money. Re-run with --yes to do it.");
    expect(stdout).toContain("would collect");
  });

  it.runIf(HAVE_BINARY)("prints scheduler wiring rather than shipping a daemon", () => {
    const { status, stdout } = sentinel("schedule", "--every", "30");
    expect(status).toBe(0);
    expect(stdout).toContain("There is no daemon.");
    expect(stdout).toContain("cron:");
  });
});
