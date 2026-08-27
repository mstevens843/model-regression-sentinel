// Hand-rolled argument parsing, and why there is no dependency here.
//
// None of the three sibling projects declares a `bin` at all; they run everything through
// `node scripts/*.mjs` with `process.argv.includes(...)`. This project diverges and ships a real
// command, because its entire contract with a caller is an exit code and a tool whose contract is
// an exit code has to be runnable as a command. That divergence is written down here rather than
// left for a reader to notice.
//
// What is NOT adopted along with it is a CLI framework. commander, yargs and clipanion each bring a
// dependency tree into a process that a watcher will run on a schedule forever, to parse about a
// dozen flags. The siblings' zero-dependency discipline is worth more than the ergonomics, and the
// whole parser is forty lines.
//
// NO COLOUR ANYWHERE. Output from this command lands in CI logs, in RESULTS.md and in files people
// diff. The sibling's release report goes as far as STRIPPING ANSI from child processes, and
// constructs the escape byte from a char code so it never appears literally in the source.

export interface Args {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
  readonly rest: readonly string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const rest: string[] = [];
  let command = "";

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      if (command === "") command = token;
      else rest.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    // A flag takes a value only when the next token is not itself a flag. That keeps
    // `--tick --state x` from reading "--state" as the value of "--tick".
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      booleans.add(name);
    }
  }
  return { command, flags, booleans, rest };
}

export const flag = (args: Args, name: string, fallback: string): string =>
  args.flags.get(name) ?? fallback;

export const required = (args: Args, name: string): string => {
  const value = args.flags.get(name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
};

export const bool = (args: Args, name: string): boolean =>
  args.booleans.has(name) || args.flags.get(name) === "true";

/**
 * A flag that must be a number, validated rather than coerced.
 *
 * WHY THIS EXISTS AND WHAT IT COST TO NOT HAVE IT. Every numeric flag was read as
 * `Number(flag(args, name, default))`, and `Number("bogus")` is NaN. Downstream, `options.alpha ??
 * 0.05` cannot catch that, because NaN is not nullish - so a mistyped threshold reached the
 * detector intact and every significance test became `p <= NaN`, which is false for every p. The
 * measured consequence:
 *
 *     compare --baseline b.json --candidate positive-control.json --confirm positive-control.json
 *       -> exit 1, CONFIRMED_DRIFT
 *     ... the same command with --alpha bogus
 *       -> exit 0, INCONCLUSIVE
 *
 * A real, reproduced, cross-model regression silently downgraded to a passing build by a typo,
 * with the string "NaN" a hundred lines below the verdict as the only trace. `--alpha 1e999` is the
 * mirror image: Infinity makes everything significant.
 *
 * The same hole ran through `--replicates`, `--concurrency`, `--target-effect` and `--every`.
 * `--replicates bogus` printed "would collect 34 cases x NaN replicates = NaN calls" and exited 0;
 * with `--yes` it reached `Math.max(1, Math.floor(NaN))`, which is NaN, produced a sparse record
 * array, and wrote syntactically invalid JSON into the baseline directory.
 *
 * A REFUSAL IS THE ONLY SAFE ANSWER. Falling back to the default would be worse than the bug: the
 * user would get a run that silently ignored what they asked for, which is the same class of lie
 * this whole project is about. Misuse is exit 2.
 */
export function numberFlag(
  args: Args,
  name: string,
  fallback: number,
  bounds: { readonly min?: number; readonly max?: number; readonly integer?: boolean } = {},
): number {
  const raw = args.flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) {
    throw new UsageError(`--${name} must be a number, not "${raw}"`);
  }
  if (bounds.integer === true && !Number.isInteger(value)) {
    throw new UsageError(`--${name} must be a whole number, not "${raw}"`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new UsageError(`--${name} must be at least ${bounds.min}, not "${raw}"`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new UsageError(`--${name} must be at most ${bounds.max}, not "${raw}"`);
  }
  return value;
}

/** A usage problem, which exits 2 rather than 1: misuse is not a regression. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
