// The forty line argument parser, and the one rule in it that is not obvious.
//
// WHY THIS FILE EXISTS AT ALL. There is no CLI framework here, deliberately: commander, yargs and
// clipanion each bring a dependency tree into a process a watcher will run on a schedule forever,
// to parse about a dozen flags. The price of that decision is that the parser's edge cases are this
// project's problem, and there is exactly one that matters.
//
// `--a --b` MUST PARSE AS TWO BOOLEANS AND NOT AS `--a` WITH THE VALUE "--b". The naive loop reads
// the next token as a value whenever there is one, and under it `sentinel watch --tick --state x`
// silently becomes "--tick with value --state" plus a stray positional, so the watch never ticks
// and nothing says why. That is not a crash, it is a command that quietly does something else,
// which is the worst shape a CLI bug can take. Every other test here is a guard rail around that
// one.
//
// A USAGE ERROR EXITS 2 AND NOT 1, everywhere in this tool: misuse is not a regression. `required`
// is where most usage errors are born, so it must name the flag it wanted rather than saying that
// something was missing.

import { describe, expect, it } from "vitest";
import { UsageError, bool, flag, parseArgs, required } from "../src/args.js";

describe("the parser reads a flag, a boolean and a command", () => {
  it("takes the following token as a flag's value", () => {
    const args = parseArgs(["compare", "--baseline", "runs/baseline.json"]);
    expect(args.command).toBe("compare");
    expect(args.flags.get("baseline")).toBe("runs/baseline.json");
    expect(args.booleans.size).toBe(0);
  });

  it("treats a trailing flag with no value as a boolean", () => {
    const args = parseArgs(["run", "--yes"]);
    expect(args.booleans.has("yes")).toBe(true);
    expect(args.flags.has("yes")).toBe(false);
  });

  it("does NOT read the next flag as the previous flag's value", () => {
    // THE test in this file. Under the naive loop `--tick` would carry the value "--state", the
    // watch would never tick, and nothing would say why.
    const args = parseArgs(["watch", "--tick", "--state", ".sentinel/watch.json"]);
    expect(args.booleans.has("tick")).toBe(true);
    expect(args.flags.has("tick")).toBe(false);
    expect(args.flags.get("state")).toBe(".sentinel/watch.json");
  });

  it("handles a run of bare booleans without swallowing any of them", () => {
    const args = parseArgs(["--a", "--b", "--c"]);
    expect([...args.booleans].sort()).toEqual(["a", "b", "c"]);
    expect(args.flags.size).toBe(0);
  });

  it("takes the first bare token as the command and every later one as rest", () => {
    const args = parseArgs(["compare", "--alpha", "0.01", "extra", "more"]);
    expect(args.command).toBe("compare");
    expect(args.rest).toEqual(["extra", "more"]);
  });

  it("finds the command even when flags come first", () => {
    // The order a person types is not the order a parser may require.
    expect(parseArgs(["--format", "json", "compare"]).command).toBe("compare");
  });

  it("returns an empty command for no arguments at all, which is how the binary prints usage", () => {
    const args = parseArgs([]);
    expect(args.command).toBe("");
    expect(args.rest).toEqual([]);
    expect(args.flags.size).toBe(0);
  });

  it("keeps the last value when a flag is repeated, rather than silently keeping the first", () => {
    // Not a design decision worth defending either way, and worth pinning so a refactor has to
    // decide deliberately rather than by accident.
    expect(parseArgs(["--split", "canary", "--split", "extended"]).flags.get("split")).toBe(
      "extended",
    );
  });

  it("accepts a value that only looks like a path, including one with an equals sign in it", () => {
    // There is no `--flag=value` form here. A token containing an equals sign is an ordinary value.
    const args = parseArgs(["--out", "results/a=b.json"]);
    expect(args.flags.get("out")).toBe("results/a=b.json");
  });
});

describe("the accessors say what they mean", () => {
  it("falls back rather than throwing for an optional flag", () => {
    const args = parseArgs(["compare"]);
    expect(flag(args, "format", "text")).toBe("text");
    expect(flag(parseArgs(["compare", "--format", "json"]), "format", "text")).toBe("json");
  });

  it("reads a boolean from either the bare form or an explicit true", () => {
    expect(bool(parseArgs(["run", "--yes"]), "yes")).toBe(true);
    expect(bool(parseArgs(["run", "--yes", "true"]), "yes")).toBe(true);
    expect(bool(parseArgs(["run"]), "yes")).toBe(false);
    // Anything that is not the literal "true" is not a yes. A caller who typed `--yes maybe` has
    // not consented to spending money.
    expect(bool(parseArgs(["run", "--yes", "maybe"]), "yes")).toBe(false);
  });

  it("throws a UsageError naming the flag it wanted", () => {
    // A usage error exits 2 rather than 1 everywhere in this tool, so the class matters as much as
    // the message: misuse is not a regression.
    expect(() => required(parseArgs(["compare"]), "baseline")).toThrowError(UsageError);
    expect(() => required(parseArgs(["compare"]), "baseline")).toThrowError(
      "--baseline is required",
    );
  });

  it("returns the value rather than throwing when the flag is present", () => {
    expect(required(parseArgs(["compare", "--baseline", "b.json"]), "baseline")).toBe("b.json");
  });

  it("carries the UsageError name, so a catch block can branch on it across a bundle boundary", () => {
    const error = new UsageError("--x is required");
    expect(error.name).toBe("UsageError");
    expect(error instanceof Error).toBe(true);
  });
});
