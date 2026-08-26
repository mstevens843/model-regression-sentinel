// The commands, and the exit codes they promise.
//
// THE EXIT CODE IS THE PRODUCT. Everything else this tool prints is for a person; the exit code is
// what a pipeline reads, and it is the one output that must never be wrong. Three values, and they
// mean three different things on purpose:
//
//   0  nothing confirmed. Includes SUSPECTED_DRIFT, which is printed loudly and does not fail a
//      build, because a threshold is crossed by noise on exactly the run where noise crosses it.
//   1  a CONFIRMED regression: a gating metric cleared both nulls and reproduced on an
//      independently collected arm.
//   2  the tool could not do its job. A corpus mismatch, a missing file, a usage error, or a
//      watcher that could not reach the provider. This is deliberately NOT 1: "I could not look"
//      and "it got worse" are opposite claims, and a pipeline that conflates them will eventually
//      treat an outage as a passing build.
//
// `--gate suspected` is available for a team that would rather investigate a false alarm than miss
// a real one. It is opt-in so the choice is made deliberately.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assessStaleness, readSnapshot, writeSnapshot } from "@model-regression-sentinel/baseline";
import { compare, exitCodeFor } from "@model-regression-sentinel/detect";
import {
  gatesFor,
  renderGates,
  renderJson,
  renderMarkdown,
  renderText,
} from "@model-regression-sentinel/report";
import {
  ClaudeCliProvider,
  type RunSnapshot,
  runCorpus,
  summariseCost,
} from "@model-regression-sentinel/run";
import { type EvalCase, type Split, loadCorpus, loadSplit } from "@model-regression-sentinel/spec";
import {
  GITHUB_ACTIONS_HINT,
  LAUNCHD_HINT,
  cronSuggestion,
  initWatchFile,
  readWatchFile,
  tick,
  tickExitCode,
  writeWatchFile,
} from "@model-regression-sentinel/watch";
import { type Args, UsageError, bool, flag, required } from "./args.js";

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const corpusRoot = (args: Args): string => flag(args, "corpus", "corpus");

function casesFor(args: Args): { cases: readonly EvalCase[]; split: Split } {
  const split = flag(args, "split", "both");
  if (split === "both") return { cases: loadCorpus(corpusRoot(args)), split: "extended" };
  if (split !== "canary" && split !== "extended") {
    throw new UsageError(`--split must be canary, extended or both, not "${split}"`);
  }
  return { cases: loadSplit(join(corpusRoot(args), split), split), split };
}

/** `sentinel corpus` - what is frozen, and whether it still matches. */
export function cmdCorpus(args: Args): number {
  const { cases } = casesFor(args);
  const bySplit = new Map<string, number>();
  const byArchetype = new Map<string, number>();
  for (const c of cases) {
    bySplit.set(c.split, (bySplit.get(c.split) ?? 0) + 1);
    byArchetype.set(c.archetype, (byArchetype.get(c.archetype) ?? 0) + 1);
  }
  out(`${cases.length} cases, and they validate.`);
  out("");
  for (const [k, v] of [...bySplit].sort()) out(`  split      ${k.padEnd(24)} ${v}`);
  for (const [k, v] of [...byArchetype].sort()) out(`  archetype  ${k.padEnd(24)} ${v}`);
  const limited = cases.filter((c) => c.detectionLimit !== null);
  out("");
  out(
    `  ${limited.length} case(s) declare drift they structurally cannot detect, and are reported separately:`,
  );
  for (const c of limited) out(`    ${String(c.id)}`);
  out("");
  out("  byte integrity is checked by `pnpm verify:corpus`, or by shasum with no code from here:");
  out("    shasum -a 256 -c corpus/canary/MANIFEST.sha256");
  return 0;
}

/** `sentinel run` - collect one arm. Spends money, so it asks. */
export async function cmdRun(args: Args): Promise<number> {
  const { cases, split } = casesFor(args);
  const model = flag(args, "model", "sonnet");
  const replicates = Number(flag(args, "replicates", "10"));
  const label = flag(args, "label", "run");
  const dir = flag(args, "out", join("results", "runs"));

  if (!bool(args, "yes")) {
    out(
      `would collect ${cases.length} cases x ${replicates} replicates = ${cases.length * replicates} calls`,
    );
    out(`against the alias "${model}".`);
    out("");
    out("This spends real money. Re-run with --yes to do it.");
    out("For a cost estimate from a measured pilot rate, use `node scripts/run-study.mjs`.");
    return 0;
  }

  const provider = new ClaudeCliProvider(model);
  const gate = provider.available();
  if (!gate.ok) {
    out(`cannot run: ${gate.reason}`);
    return 2;
  }
  const snapshot = await runCorpus(provider, cases, split, {
    replicates,
    concurrency: Number(flag(args, "concurrency", "6")),
    label,
  });
  mkdirSync(dir, { recursive: true });
  const path = writeSnapshot(dir, snapshot);
  out(
    `${snapshot.records.length} calls, ${snapshot.errorCount} errors, served ${snapshot.fingerprint?.resolvedModel ?? "(never observed)"}`,
  );
  out(`written to ${path}`);
  return snapshot.errorCount === snapshot.records.length ? 2 : 0;
}

/** `sentinel compare` - the headline command. */
export function cmdCompare(args: Args): number {
  const { cases } = casesFor(args);
  const baseline = readSnapshot(required(args, "baseline"));
  const candidate = readSnapshot(required(args, "candidate"));
  const confirmPath = args.flags.get("confirm");
  const confirmation = confirmPath === undefined ? undefined : readSnapshot(confirmPath);

  const result = compare(cases, baseline, candidate, {
    alpha: Number(flag(args, "alpha", "0.05")),
    ...(confirmation === undefined ? {} : { confirmation }),
    ...(args.flags.has("target-effect")
      ? { targetEffect: Number(required(args, "target-effect")) }
      : {}),
  });

  const staleness = assessStaleness(baseline, new Date());
  const context = {
    stalenessNote: staleness.note,
    baselineCost: baseline.cost,
    candidateCost: candidate.cost,
    corpusDigest: baseline.corpusDigest,
    ...(candidate.fingerprint === null ? {} : { candidateFingerprint: candidate.fingerprint }),
    ...(confirmation === undefined ? {} : { confirmationLabel: confirmation.label }),
  };

  const format = flag(args, "format", "text");
  const rendered =
    format === "json"
      ? renderJson(result, context)
      : format === "md" || format === "markdown"
        ? renderMarkdown(result, context)
        : renderText(result);

  const target = args.flags.get("out");
  if (target === undefined) out(rendered);
  else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered.endsWith("\n") ? rendered : `${rendered}\n`);
    out(`written to ${target}`);
  }

  if (format === "text" && target === undefined) out(renderGates(gatesFor(result)));

  const gate = bool(args, "gate-suspected") || flag(args, "gate", "confirmed") === "suspected";
  return exitCodeFor(result, gate ? "suspected" : "confirmed");
}

/** `sentinel watch --init` and `sentinel watch --tick`. */
export async function cmdWatch(args: Args): Promise<number> {
  const statePath = flag(args, "state", join(".sentinel", "watch.json"));
  const { cases, split } = casesFor(args);

  if (bool(args, "init")) {
    const baseline = readSnapshot(required(args, "baseline"));
    const file = initWatchFile({ snapshot: baseline, cases, now: new Date() });
    mkdirSync(dirname(statePath), { recursive: true });
    writeWatchFile(statePath, file);
    out(`watching ${file.cases.length} case(s) of "${file.requestedModel}" from ${file.startedAt}`);
    out(`state at ${statePath}`);
    out("");
    out("Your scheduler owns the schedule. There is no daemon:");
    out(`  ${cronSuggestion(Number(flag(args, "every", "60")))}`);
    return 0;
  }

  if (!bool(args, "tick")) {
    throw new UsageError("watch needs --init or --tick");
  }

  const file = readWatchFile(statePath);
  const snapshotPath = args.flags.get("snapshot");
  let snapshot: RunSnapshot;
  if (snapshotPath !== undefined) {
    snapshot = readSnapshot(snapshotPath);
  } else {
    // Collect the round now. A tick that cannot reach the provider must say so rather than
    // reporting quiet, which is what `could_not_look` is for.
    const provider = new ClaudeCliProvider(file.requestedModel);
    snapshot = await runCorpus(provider, cases, split, {
      replicates: Number(flag(args, "replicates", "3")),
      concurrency: Number(flag(args, "concurrency", "4")),
      label: "tick",
    });
  }

  const result = tick({ file, cases, snapshot, now: new Date() });
  writeWatchFile(statePath, result.file);

  out(`tick ${result.file.ticks}: ${result.status}`);
  out(`  ${result.note}`);
  if (result.alarmedCases.length > 0) out(`  alarmed: ${result.alarmedCases.join(", ")}`);
  for (const change of result.identityChanges) {
    out(`  identity: ${change.field} ${change.before} -> ${change.after}`);
  }
  const cost = summariseCost(
    snapshot.fingerprint?.resolvedModel ?? file.requestedModel,
    snapshot.records.map((r) => r.response),
  );
  out(
    `  this round cost $${(cost.harnessUsdPerCall * snapshot.records.length).toFixed(4)} measured`,
  );
  return tickExitCode(result);
}

/** `sentinel schedule` - copy-pasteable scheduler wiring. There is deliberately no daemon. */
export function cmdSchedule(args: Args): number {
  const every = Number(flag(args, "every", "60"));
  out("There is no daemon. A long-running process needs a real clock and real timers, which the");
  out(
    "contract tests forbid in anything testable, and a drift sequence has to replay deterministically.",
  );
  out("");
  out("cron:");
  out(`  ${cronSuggestion(every)}`);
  out("");
  out(LAUNCHD_HINT);
  out("");
  out(GITHUB_ACTIONS_HINT);
  return 0;
}

export const USAGE = `sentinel - watch a pinned model alias for behavior that moved when your code did not

  sentinel corpus [--split canary|extended|both]
      What is frozen, and whether it validates.

  sentinel run --label <name> [--model sonnet] [--replicates 10] [--split both] [--out dir] --yes
      Collect one arm. Prints a plan and does nothing without --yes.

  sentinel compare --baseline <file> --candidate <file> [--confirm <file>]
                   [--format text|md|json] [--out <file>] [--gate confirmed|suspected]
      The headline command. Exit 1 ONLY on a confirmed regression.

  sentinel watch --init --baseline <file> [--state .sentinel/watch.json]
  sentinel watch --tick [--state .sentinel/watch.json] [--snapshot <file>] [--replicates 3]
      One tick per invocation. Your scheduler owns the schedule.

  sentinel schedule [--every 60]
      Copy-pasteable cron, launchd and GitHub Actions wiring.

exit codes
  0  nothing confirmed, including a suspected finding
  1  a CONFIRMED regression, reproduced on an independent arm
  2  the tool could not do its job: misuse, a corpus mismatch, or a provider it could not reach
`;
