// The guard that stops a watch being reset by deleting a file.
//
// A watcher loses sensitivity as it runs quietly. The supported remedy is `sentinel baseline rotate`
// onto a newly collected baseline. The UNSUPPORTED remedy, which is faster and looks identical from
// the outside, is to delete the state file and run `watch --init` again.
//
// That produces a watch reporting a healthy evidence multiple, no alarm history and a short life,
// having learned nothing and forgotten everything. It is indistinguishable from a genuinely fresh
// watch, and it is WORSE than the blind one it replaced, because the blind one at least said it was
// blind. `packages/watch/test/lineage.test.ts` demonstrates that `initWatchFile` itself cannot tell
// the difference, which is why the guard has to live at the command boundary. This file is that
// guard, tested by running the real binary.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_MISUSE, EXIT_OK } from "@model-regression-sentinel/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(REPO, "packages/cli/dist/cli.js");
const RUNS = join(REPO, "results/runs");
const ready = existsSync(CLI) && existsSync(join(RUNS, "baseline.json"));

const run = (...args: string[]) => {
  const r = spawnSync("node", [CLI, ...args], { cwd: REPO, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

let scratch = "";
let state = "";

beforeAll(() => {
  if (!ready) return;
  scratch = mkdtempSync(join(tmpdir(), "mrs-restart-"));
  state = join(scratch, "watch.json");
});
afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

describe.runIf(ready)("watch --init refuses to overwrite an existing watch", () => {
  it("initialises cleanly the first time", () => {
    const r = run("watch", "--init", "--baseline", join(RUNS, "baseline.json"), "--state", state);
    expect(r.code).toBe(EXIT_OK);
    expect(existsSync(state)).toBe(true);
  });

  it("refuses the second time, and exits 2 rather than silently resetting", () => {
    const r = run("watch", "--init", "--baseline", join(RUNS, "baseline.json"), "--state", state);
    expect(r.code).toBe(EXIT_MISUSE);
    expect(r.out).toContain("refusing to overwrite");
  });

  it("names the command that does it properly, so the refusal is a route and not a wall", () => {
    const r = run("watch", "--init", "--baseline", join(RUNS, "baseline.json"), "--state", state);
    expect(r.out).toContain("sentinel baseline rotate");
    expect(r.out).toContain("sentinel watch --status");
  });

  it("reports what would have been lost", () => {
    const r = run("watch", "--init", "--baseline", join(RUNS, "baseline.json"), "--state", state);
    expect(r.out).toMatch(/generation \d+/);
    expect(r.out).toMatch(/tick\(s\) in/);
  });

  it("leaves the existing watch byte-identical after refusing", () => {
    // A refusal that damaged the thing it was protecting would be worse than no refusal.
    const before = readFileSync(state, "utf8");
    run("watch", "--init", "--baseline", join(RUNS, "baseline.json"), "--state", state);
    expect(readFileSync(state, "utf8")).toBe(before);
  });
});

describe.runIf(ready)(
  "baseline rotate is the supported route, and it is not a rubber stamp",
  () => {
    it("refuses to rotate onto the baseline already being watched", () => {
      const r = run(
        "baseline",
        "rotate",
        "--state",
        state,
        "--baseline",
        join(RUNS, "baseline.json"),
      );
      expect(r.code).toBe(EXIT_MISUSE);
      expect(r.out).toContain("IS the one already being watched");
      expect(r.out).toContain("Nothing was written");
    });

    it("plans without writing unless --yes is given", () => {
      const before = readFileSync(state, "utf8");
      const r = run(
        "baseline",
        "rotate",
        "--state",
        state,
        "--baseline",
        join(RUNS, "candidate.json"),
      );
      expect(r.code).toBe(EXIT_OK);
      expect(r.out).toContain("Nothing has been written");
      expect(readFileSync(state, "utf8")).toBe(before);
    });

    it("says what carries forward and what is discarded, before doing either", () => {
      const r = run(
        "baseline",
        "rotate",
        "--state",
        state,
        "--baseline",
        join(RUNS, "candidate.json"),
      );
      expect(r.out).toContain("CARRIED FORWARD");
      expect(r.out).toContain("DISCARDED");
    });

    it("applies with --yes, advances the generation, and keeps lifetime ticks", () => {
      const r = run(
        "baseline",
        "rotate",
        "--state",
        state,
        "--baseline",
        join(RUNS, "candidate.json"),
        "--reason",
        "spent_sensitivity",
        "--yes",
      );
      expect(r.code).toBe(EXIT_OK);
      expect(r.out).toContain("generation 2");

      const file = JSON.parse(readFileSync(state, "utf8")) as {
        readonly lineage?: { readonly generation: number; readonly rotations: readonly unknown[] };
      };
      expect(file.lineage?.generation).toBe(2);
      expect(file.lineage?.rotations).toHaveLength(1);
    });

    it("refuses to rotate backwards in time after the rotation", () => {
      const r = run(
        "baseline",
        "rotate",
        "--state",
        state,
        "--baseline",
        join(RUNS, "baseline.json"),
        "--yes",
      );
      expect(r.code).toBe(EXIT_MISUSE);
      expect(r.out).toContain("moves forward in time");
    });

    it("refuses when there is no watch to rotate", () => {
      const r = run(
        "baseline",
        "rotate",
        "--state",
        join(scratch, "does-not-exist.json"),
        "--baseline",
        join(RUNS, "candidate.json"),
      );
      expect(r.code).toBe(EXIT_MISUSE);
      expect(r.out).toContain("nothing to rotate");
    });
  },
);

describe.runIf(ready)("watch --status never reports a regression", () => {
  it("exits 0 whatever the debt says", () => {
    // A dull instrument and a worse provider must not share an alert channel.
    const r = run("watch", "--status", "--state", state);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain("never sets a regression exit code");
  });

  it("emits strict JSON under --json", () => {
    const r = run("watch", "--status", "--state", state, "--json");
    expect(r.code).toBe(EXIT_OK);
    expect(() => JSON.parse(r.out) as unknown).not.toThrow();
    expect(r.out).not.toContain("NaN");
    expect(r.out).not.toContain("Infinity");
  });

  it("reports lifetime ticks separately from this generation's", () => {
    const r = run("watch", "--status", "--state", state, "--json");
    const j = JSON.parse(r.out) as {
      readonly ticks: number;
      readonly lifetimeTicks: number;
      readonly rotations: number;
    };
    expect(j.rotations).toBe(1);
    expect(j.lifetimeTicks).toBeGreaterThanOrEqual(j.ticks);
  });
});
