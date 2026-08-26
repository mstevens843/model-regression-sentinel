// The `claude` CLI as a provider, with its distortions measured rather than absorbed.
//
// WHY THIS PROVIDER EXISTS. There is no LLM API key anywhere in the environment that produced this
// repository: checked in the process environment, and no .env file exists in this project or in any
// of its siblings. The alternative was to ship the whole thing unrun. Running it through an
// already-authenticated local CLI produces real outputs, real latencies and real token counts, and
// the distortions it introduces are measured and printed rather than glossed. The same choice, for
// the same reason, is made in `toolcall-risk-classifier/src/toolcall_risk/bench/providers/
// claude_cli.py`, and the argv here is that file's plus three flags this project measured.
//
// WHAT WAS MEASURED ON THIS MACHINE, NOT ASSUMED:
//
//   THE HARNESS INJECTS ITS OWN CONTEXT AND IT IS EXPENSIVE. An unflagged call reported 112,748
//   cache-creation tokens and cost $0.451. Almost all of it was MCP tool schemas that belong to the
//   coding agent, not to this project. Adding `--tools "" --strict-mcp-config` and supplying a
//   short `--system-prompt` took it to 3,301 tokens and $0.0132, and to $0.00084 once the prompt
//   cache was warm. That is a factor of roughly 500 on the identical question. A canary set is paid
//   for on every tick forever, so this is the difference between a watcher that runs and one that
//   gets switched off.
//
//   THE ALIAS RESOLUTION IS VISIBLE AND IS THE POINT. `--model sonnet` reported serving
//   `claude-sonnet-5`; `--model haiku` reported serving `claude-haiku-4-5-20251001`, a dated
//   snapshot. The alias-to-identity mapping is exactly the surface this project watches, and this
//   provider exposes it for free.
//
//   THREE LATENCY FIGURES ARE AVAILABLE AND ALL THREE ARE RECORDED. `duration_api_ms` is the
//   server's, `duration_ms` is the CLI's, and the subprocess wall time is measured here. The true
//   deployed latency is between them and THIS PROJECT DID NOT MEASURE IT, because there is no API
//   key. The report says that sentence rather than picking whichever number flatters the argument.
//
// THE PROMPT GOES OVER STDIN. `--tools` is variadic and will swallow a positional prompt argument.
// The sibling records hitting exactly that, and the fix is the same here.

import { spawn } from "node:child_process";
import type { JsonValue } from "@model-regression-sentinel/spec";
import {
  type Availability,
  type CompletionRequest,
  type Provider,
  type ProviderResponse,
  skipped,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 180_000;

interface CliUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly service_tier?: string;
}

interface CliModelUsage {
  readonly canonicalModel?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly provider?: string;
  readonly costBasis?: string;
}

interface CliResult {
  readonly result?: string;
  readonly is_error?: boolean;
  readonly stop_reason?: string;
  readonly duration_api_ms?: number;
  readonly duration_ms?: number;
  readonly total_cost_usd?: number;
  readonly usage?: CliUsage;
  readonly modelUsage?: Readonly<Record<string, CliModelUsage>>;
}

export interface ClaudeCliOptions {
  readonly binary?: string;
  readonly timeoutMs?: number;
  /** Injected so tests can drive the provider without a subprocess. */
  readonly exec?: (
    argv: readonly string[],
    stdin: string,
    timeoutMs: number,
  ) => Promise<ExecResult>;
}

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export class ClaudeCliProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly exec: (
    argv: readonly string[],
    stdin: string,
    timeoutMs: number,
  ) => Promise<ExecResult>;

  constructor(model: string, options: ClaudeCliOptions = {}) {
    this.name = `claude_cli:${model}`;
    this.model = model;
    this.binary = options.binary ?? "claude";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.exec = options.exec ?? runSubprocess;
  }

  available(): Availability {
    return { ok: true, reason: "" };
  }

  /**
   * The argv, and every flag is load-bearing.
   *
   *   --tools ""              strips the tool schemas. The single biggest cost lever measured.
   *   --strict-mcp-config     drops MCP servers configured elsewhere on the machine, which is where
   *                           the 112,748 injected tokens actually came from.
   *   --disable-slash-commands and --no-session-persistence
   *                           keep a probe from picking up local customization, so the same case
   *                           costs the same on someone else's laptop.
   *   --max-turns 1           one completion, no agent loop. A probe that could call tools would be
   *                           measuring the harness, not the model.
   *   --system-prompt         replaces the default system prompt with the case's short one.
   */
  argv(request: CompletionRequest): readonly string[] {
    const argv = [
      "-p",
      "--output-format",
      "json",
      "--model",
      this.model,
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--max-turns",
      "1",
      "--system-prompt",
      request.system,
    ];
    if (request.jsonSchema !== undefined) {
      argv.push("--json-schema", JSON.stringify(request.jsonSchema as JsonValue));
    }
    return argv;
  }

  async complete(request: CompletionRequest): Promise<ProviderResponse> {
    const started = process.hrtime.bigint();
    const wall = (): number => Number(process.hrtime.bigint() - started) / 1e6;

    let out: ExecResult;
    try {
      out = await this.exec([this.binary, ...this.argv(request)], request.user, this.timeoutMs);
    } catch (cause) {
      return { ...skipped("exec failed"), wallMs: wall(), error: describe(cause) };
    }
    const wallMs = wall();

    if (out.timedOut) return { ...skipped("timeout"), wallMs, error: "timeout" };
    if (out.code !== 0 || out.stdout.trim() === "") {
      return {
        ...skipped("non-zero exit"),
        wallMs,
        error: `exit ${String(out.code)}: ${out.stderr.trim().slice(0, 200)}`,
      };
    }

    let doc: CliResult;
    try {
      doc = JSON.parse(out.stdout) as CliResult;
    } catch {
      return { ...skipped("unparseable"), wallMs, error: "unparseable CLI json" };
    }

    const usage = doc.usage ?? {};
    const modelUsage = doc.modelUsage ?? {};
    // The KEY of modelUsage is the served identity and is the more specific of the two: measured on
    // this machine, requesting `haiku` gives key `claude-haiku-4-5-20251001` against canonicalModel
    // `claude-haiku-4-5`. Taking the key rather than canonicalModel is what makes a dated snapshot
    // visible where the provider exposes one.
    const servedKey = Object.keys(modelUsage)[0] ?? "";
    const served = servedKey === "" ? undefined : modelUsage[servedKey];

    return {
      text: String(doc.result ?? ""),
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
      apiMs: doc.duration_api_ms ?? 0,
      clientMs: doc.duration_ms ?? 0,
      wallMs,
      harnessCostUsd: doc.total_cost_usd ?? 0,
      modelServed: servedKey,
      canonicalModel: served?.canonicalModel ?? "",
      contextWindow: served?.contextWindow ?? null,
      maxOutputTokens: served?.maxOutputTokens ?? null,
      serviceTier: usage.service_tier ?? "",
      costBasis: served?.costBasis ?? "",
      stopReason: doc.stop_reason ?? "",
      error: doc.is_error === true ? "is_error" : "",
    };
  }
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

function runSubprocess(
  argv: readonly string[],
  stdin: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const [bin, ...args] = argv;
    const child = spawn(bin as string, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
