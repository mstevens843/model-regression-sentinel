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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assessStaleness, readSnapshot, writeSnapshot } from "@model-regression-sentinel/baseline";
import { compare, exitCodeFor, extractMetrics } from "@model-regression-sentinel/detect";
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
import {
  EXIT_CODE_HELP,
  EXIT_CONFIRMED_REGRESSION,
  EXIT_COULD_NOT_LOOK,
  EXIT_MISUSE,
  EXIT_OK,
  type EvalCase,
  type Split,
  loadCorpus,
  loadSplit,
} from "@model-regression-sentinel/spec";
import {
  GITHUB_ACTIONS_HINT,
  LAUNCHD_HINT,
  type RotationReason,
  cronSuggestion,
  debtReport,
  identityOf,
  initWatchFile,
  lineageOf,
  planRotation,
  readWatchFile,
  renderDebt,
  rotateWatchFile,
  tick,
  tickExitCode,
  writeWatchFile,
} from "@model-regression-sentinel/watch";
import { type Args, UsageError, bool, flag, required } from "./args.js";

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const corpusRoot = (args: Args): string => flag(args, "corpus", "corpus");

// `both` is kept as the name for "every split" rather than renamed to `all`, because it is what the
// README, the examples and anyone's existing scripts already pass. It now loads three splits rather
// than two, which is the additive change v0.2 makes; a run collected with it is NOT comparable
// against the recorded runs under results/runs/, which were collected on canary plus extended only.
function casesFor(args: Args): { cases: readonly EvalCase[]; split: Split } {
  const split = flag(args, "split", "both");
  if (split === "both") return { cases: loadCorpus(corpusRoot(args)), split: "extended" };
  if (split !== "canary" && split !== "extended" && split !== "schema") {
    throw new UsageError(`--split must be canary, extended, schema or both, not "${split}"`);
  }
  return { cases: loadSplit(join(corpusRoot(args), split), split), split };
}

/** `sentinel corpus` - what is frozen, and whether it still matches. */
export function cmdCorpus(args: Args): number {
  const { cases } = casesFor(args);

  if (bool(args, "json")) {
    // Machine-readable because a composition table is exactly the thing a CI job wants to assert on,
    // and parsing a human table is how a check starts silently passing after a column moves.
    const byArchetype: Record<string, number> = {};
    const bySplit: Record<string, number> = {};
    for (const c of cases) {
      byArchetype[c.archetype] = (byArchetype[c.archetype] ?? 0) + 1;
      bySplit[c.split] = (bySplit[c.split] ?? 0) + 1;
    }
    out(
      JSON.stringify(
        {
          schemaVersion: 1,
          total: cases.length,
          bySplit,
          byArchetype,
          withDetectionLimit: cases
            .filter((c) => c.detectionLimit !== null)
            .map((c) => String(c.id)),
          derived: cases.filter((c) => c.provenance.kind === "derived").length,
          original: cases.filter((c) => c.provenance.kind === "original").length,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }
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
  return EXIT_OK;
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
    return EXIT_OK;
  }

  const provider = new ClaudeCliProvider(model);
  const gate = provider.available();
  if (!gate.ok) {
    // COULD NOT LOOK, not misuse. The invocation was fine and the credential was absent, which is
    // the world's problem rather than the caller's. v0.1 returned 2 here while `watch --tick`
    // already returned 3 for the identical condition, and an exit-code contract that disagrees with
    // itself between two commands of the same tool is worse than one that is simply coarse.
    out(`cannot run: ${gate.reason}`);
    return EXIT_COULD_NOT_LOOK;
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
  // Every call failed. Nothing was learned about the provider and nothing about the invocation was
  // wrong, so this is the same "could not look" the watcher reports rather than a regression or a
  // typo.
  return snapshot.errorCount === snapshot.records.length ? EXIT_COULD_NOT_LOOK : EXIT_OK;
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

  if (bool(args, "status")) {
    const report = debtReport(readWatchFile(statePath));
    if (bool(args, "json")) out(JSON.stringify(report, null, 2));
    else out(renderDebt(report));
    // A dull instrument is never a regression. Reporting the debt returns zero, always.
    return EXIT_OK;
  }

  if (bool(args, "init")) {
    // THE ACCIDENTAL-RESTART GUARD. Deleting a state file and re-initialising produces a watch that
    // reports a healthy evidence multiple, no alarm history and a short life, having learned nothing
    // and forgotten everything. That watch is indistinguishable from a genuinely fresh one and is
    // worse than the blind watch it replaced, because the blind watch at least said it was blind.
    // So init refuses to write over an existing watch and names the command that does it properly.
    if (existsSync(statePath)) {
      const existing = readWatchFile(statePath);
      const lineage = lineageOf(existing);
      out(`refusing to overwrite the watch at ${statePath}.`);
      out("");
      out(
        `  it is on generation ${lineage.generation}, ${existing.ticks} tick(s) in, watching "${existing.requestedModel}"`,
      );
      out(
        `  since ${existing.startedAt}, with ${existing.identityAlerts.length} identity alert(s).`,
      );
      out("");
      out("  Overwriting it would clear the accumulated evidence debt without changing what is");
      out("  being measured, which is the one reset this protocol exists to prevent. To adopt a");
      out("  newly collected baseline and keep the record:");
      out("");
      out(`    sentinel baseline rotate --state ${statePath} --baseline <new-snapshot.json>`);
      out("");
      out("  To see what would be lost first:");
      out("");
      out(`    sentinel watch --status --state ${statePath}`);
      return EXIT_MISUSE;
    }
    const baseline = readSnapshot(required(args, "baseline"));
    const file = initWatchFile({ snapshot: baseline, cases, now: new Date() });
    mkdirSync(dirname(statePath), { recursive: true });
    writeWatchFile(statePath, file);
    out(`watching ${file.cases.length} case(s) of "${file.requestedModel}" from ${file.startedAt}`);
    out(`state at ${statePath}`);
    out("");
    out("Your scheduler owns the schedule. There is no daemon:");
    out(`  ${cronSuggestion(Number(flag(args, "every", "60")))}`);
    return EXIT_OK;
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

/**
 * `sentinel baseline rotate` - the only supported way to clear accumulated evidence debt.
 *
 * It requires a NEWLY COLLECTED SNAPSHOT and refuses everything else, because every other route to
 * a clean-looking watch is a route to a watch that has forgotten why it was dull. The refusal list
 * lives in `planRotation` so that it cannot be bypassed by calling the applier directly, and every
 * refusal is printed rather than the first, since a caller who fixes one and hits the next learns
 * to distrust the tool.
 */
export function cmdBaseline(args: Args): number {
  const sub = args.rest[0] ?? "";
  if (sub !== "rotate") {
    throw new UsageError(`baseline needs a subcommand: rotate. Saw "${sub}"`);
  }

  const statePath = flag(args, "state", join(".sentinel", "watch.json"));
  if (!existsSync(statePath)) {
    out(
      `no watch at ${statePath}. There is nothing to rotate; start one with \`sentinel watch --init\`.`,
    );
    return EXIT_MISUSE;
  }

  const file = readWatchFile(statePath);
  const { cases } = casesFor(args);
  const candidate = readSnapshot(required(args, "baseline"));
  const reason = flag(args, "reason", "operator") as RotationReason;

  // Seedability is computed here rather than inside the planner, because grading is the caller's
  // job and `extractMetrics` is the only thing allowed to decide what passed.
  const quality = extractMetrics(cases, candidate).get("quality");
  const seedable = (quality?.perCase ?? []).filter((c) => c.values.length > 0).length;

  const decision = planRotation({
    current: lineageOf(file).baseline,
    lineage: file.lineage,
    states: file.cases,
    candidate,
    seedableCases: seedable,
    reason,
    config: file.config,
  });

  if (!decision.ok) {
    out(`refusing to rotate the watch at ${statePath}:`);
    out("");
    for (const refusal of decision.refusals) out(`  REFUSED  ${refusal}`);
    out("");
    out("  Nothing was written. The watch is unchanged and its debt is unchanged.");
    return EXIT_MISUSE;
  }

  const plan = decision.plan;
  const before = debtReport(file, file.config);

  if (!bool(args, "yes")) {
    out(`rotation PLAN for ${statePath}. Nothing has been written.`);
    out("");
    out(
      `  from  ${plan.from.label} captured ${plan.from.capturedAt} (${plan.from.replicates} replicates)`,
    );
    out(
      `  to    ${plan.to.label} captured ${plan.to.capturedAt} (${plan.to.replicates} replicates)`,
    );
    out(`  reason ${plan.reason}`);
    out("");
    out(`  closing generation ${plan.closingGeneration} after ${file.ticks} tick(s)`);
    out(
      `  the dullest case currently needs ${plan.evidenceMultipleAtClose.toFixed(1)}x the evidence a fresh watch would`,
    );
    out(
      `  cases alarmed at close: ${plan.casesAlarmed.length === 0 ? "none" : plan.casesAlarmed.join(", ")}`,
    );
    out("");
    out("  CARRIED FORWARD: identity alerts, confirmations, and the full rotation history.");
    out("  DISCARDED: the e-process wealth, which was accumulated against the old baseline's p0");
    out("  and would be arithmetic across two different questions if it were kept.");
    for (const w of plan.warnings) {
      out("");
      out(`  WARNING  ${w}`);
    }
    out("");
    out("  Re-run with --yes to apply it.");
    return EXIT_OK;
  }

  const rotated = rotateWatchFile(file, plan, {
    snapshot: candidate,
    cases,
    now: new Date(),
    ...(file.config === undefined ? {} : { config: file.config }),
  });
  writeWatchFile(statePath, rotated);
  const after = debtReport(rotated, rotated.config);

  out(`rotated ${statePath} to generation ${lineageOf(rotated).generation}.`);
  out("");
  out(
    `  evidence multiple  ${before.worst?.evidenceMultiple.toFixed(1) ?? "n/a"}x  ->  ${after.worst?.evidenceMultiple.toFixed(1) ?? "n/a"}x`,
  );
  out(`  lifetime ticks     ${after.lifetimeTicks} across ${after.rotations + 1} baseline(s)`);
  out(
    `  carried forward    ${rotated.identityAlerts.length} identity alert(s), ${rotated.confirmations.length} confirmation record(s)`,
  );
  for (const w of plan.warnings) out(`  WARNING  ${w}`);
  return EXIT_OK;
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
  return EXIT_OK;
}

export const USAGE: string = `sentinel - watch a pinned model alias for behavior that moved when your code did not

  sentinel corpus [--split canary|extended|schema|both]
      What is frozen, and whether it validates.

  sentinel run --label <name> [--model sonnet] [--replicates 10] [--split both] [--out dir] --yes
      Collect one arm. Prints a plan and does nothing without --yes.

  sentinel compare --baseline <file> --candidate <file> [--confirm <file>]
                   [--format text|md|json] [--out <file>] [--gate confirmed|suspected]
      The headline command. Exit 1 ONLY on a confirmed regression.

  sentinel watch --init --baseline <file> [--state .sentinel/watch.json]
  sentinel watch --tick [--state .sentinel/watch.json] [--snapshot <file>] [--replicates 3]
      One tick per invocation. Your scheduler owns the schedule.

  sentinel watch --status [--state .sentinel/watch.json] [--json]
      How much sensitivity this watch has spent, and whether to rotate. Never a regression.

  sentinel baseline rotate --baseline <new-snapshot> [--state ...] [--reason ...] [--yes]
      The only supported way to clear accumulated evidence debt. Prints a plan without --yes.

  sentinel release verify [path]
      Check an unpacked release against its manifest and a required-artifact list. Refuses a bare
      invocation rather than reporting a complete release as broken.

  sentinel schedule [--every 60]
      Copy-pasteable cron, launchd and GitHub Actions wiring.

exit codes
${EXIT_CODE_HELP}
`;
