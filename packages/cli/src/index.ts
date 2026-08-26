// The public surface of @model-regression-sentinel/cli.
//
// The command bodies are exported so they can be driven from a test or from another script without
// spawning a process, which is the only reason this package has a library entry point at all. The
// binary is `cli.ts` and it is thin.
//
// Hand-curated, like every barrel here. `export *` would publish whatever happens to be exported
// today and turn every internal rename into someone else's breaking change.

// ---- commands -------------------------------------------------------------------------------------
export { USAGE, cmdCompare, cmdCorpus, cmdRun, cmdSchedule, cmdWatch } from "./commands.js";

// ---- argument parsing ------------------------------------------------------------------------------
export { UsageError, bool, flag, parseArgs, required } from "./args.js";

// ---- types ------------------------------------------------------------------------------------------
export type { Args } from "./args.js";
