#!/usr/bin/env node
// The `sentinel` entry point.
//
// Thin on purpose: it parses, dispatches, and turns a thrown error into an exit code and a sentence.
// Everything that could be worth testing lives in `commands.ts` and in the packages beneath it, so
// that the part which cannot easily be tested is the part with nothing in it.
//
// `process.exitCode` is set rather than `process.exit()` called, so buffered stdout is flushed
// before the process ends. A report truncated by a hard exit is the kind of defect that only shows
// up when the output is piped, which is exactly when it matters.

import { UsageError, parseArgs } from "./args.js";
import {
  USAGE,
  cmdBaseline,
  cmdCompare,
  cmdCorpus,
  cmdRun,
  cmdSchedule,
  cmdWatch,
} from "./commands.js";
import { cmdRelease } from "./release.js";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "" || args.command === "help" || args.booleans.has("help")) {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (args.command) {
    case "corpus":
      return cmdCorpus(args);
    case "run":
      return await cmdRun(args);
    case "compare":
      return cmdCompare(args);
    case "watch":
      return await cmdWatch(args);
    case "baseline":
      return cmdBaseline(args);
    case "release":
      return cmdRelease(args);
    case "schedule":
      return cmdSchedule(args);
    default:
      throw new UsageError(`unknown command "${args.command}"`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    if (cause instanceof UsageError) {
      process.stderr.write(`${cause.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    // Everything else is 2 as well, and deliberately not 1 (see exitCodes.ts for all four). An unexpected failure means the tool
    // could not do its job, which is a different claim from "the provider got worse", and a
    // pipeline that conflates the two will eventually treat a crash as a regression.
    process.stderr.write(
      `${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}\n`,
    );
    process.exitCode = 2;
  });
