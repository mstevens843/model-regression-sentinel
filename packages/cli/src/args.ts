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

/** A usage problem, which exits 2 rather than 1: misuse is not a regression. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
