// The `codex` CLI as a provider, and the first one here whose identity is entirely undisclosed.
//
// WHY IT EXISTS. Every measured number in this repository came through one vendor's CLI. "One
// provider, one model family, one machine" is limitation #3 in docs/LIMITATIONS.md, and the two
// BYOK HTTP adapters that would close it need an API key this environment does not have. `codex
// exec` needs no API key either: it runs on the local Codex plan session in `CODEX_HOME`, the same
// way `claude -p` runs on a Claude plan session. So a second vendor becomes reachable without a
// credential, and the sibling project `agent-context-containment` already proved the invocation in
// `scripts/lib/model-provider.mjs`. The argv below is that file's, plus `--json`.
//
// THIS DOES NOT CLOSE THE BYOK GAP AND MUST NOT BE READ AS DOING SO. `anthropic_api` and
// `openai_compatible` speak to deployed HTTP endpoints and remain shipped and unrun. A plan-backed
// CLI is a third thing: it proves the seam is not Anthropic-shaped, and it proves nothing about
// what either HTTP adapter does on a real endpoint.
//
// WHAT THIS PROVIDER DOES NOT DISCLOSE, measured on this machine rather than assumed. This is the
// important part, because it is the opposite of the `claude` CLI and it is exactly the case the
// README's wedge section describes:
//
//   NO SERVED MODEL IDENTITY, AT ALL. The `--json` event stream carries `thread.started`,
//   `item.completed` and `turn.completed`, and not one of them names a model. Requesting an alias
//   tells you nothing about what answered it. `claude` reports `claude-haiku-4-5-20251001` for the
//   `haiku` alias; `codex` reports nothing for any alias. So `modelServed` and `canonicalModel` are
//   recorded as EMPTY, which `metadataOf` maps to `not_exposed`, and `undisclosedFields` lists
//   them. THE ONE THING NOT DONE HERE IS TO INVENT ONE: writing the requested alias into
//   `modelServed` would manufacture a stable identity out of an absent one, and a drift watcher
//   whose identity check can never fire is worse than one that says it cannot see.
//
//   NO SERVER-REPORTED LATENCY. `claude` returns `duration_api_ms` and `duration_ms` beside the
//   wall time, so three figures are recorded and the report says which is which. Codex returns
//   neither, so `apiMs` and `clientMs` are 0 and only `wallMs` is real. CONSEQUENCE, STATED
//   PLAINLY: `metrics.ts` reads `apiMs` for the `latencyMs` metric, so a comparison of two
//   codex_cli runs will show `latencyMs` as a constant zero. That is a metric this adapter cannot
//   produce, not a provider that answers instantly, and `latencyMs` is non-gating so it cannot
//   fail a build. It is listed in the provider registry note and in docs/PROVIDERS.md.
//
//   NO COST. `harnessCostUsd` is 0 because the plan does not price a call. Cost is non-gating.
//
//   NO STOP REASON.
//
// WHAT IT DOES DISCLOSE, and it is more than the HTTP adapters get from a bare Messages response:
// real `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens` and `output_tokens` from
// the `turn.completed` event.
//
// ONE COMPLETION, NOT AN AGENT LOOP. `-s read-only` means it answers rather than acts, and the
// working directory is a fresh temp dir with `--skip-git-repo-check`, so the model is never pointed
// at this repository. A probe that could read the corpus it is being graded on would be measuring
// the harness.
//
// THE PROMPT GOES OVER STDIN, for the same reason it does in `claudeCli.ts` and in the sibling: it
// is built from corpus content, it can be long, and argv is the wrong place for either property.
//
// THERE IS NO SEPARATE SYSTEM PROMPT. `codex exec` takes one instruction stream, so the case's
// system and user text are concatenated with a blank line between them. That is a real difference
// from the `claude` adapter, where `--system-prompt` is its own flag, and it means the rendered
// request differs between the two providers even for one case. It does not affect `corpusDigest`,
// which is computed over the case's rendered request rather than over any provider's argv.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Availability,
  type CompletionRequest,
  type Provider,
  type ProviderResponse,
  skipped,
} from "../types.js";
import type { ExecResult } from "./claudeCli.js";

/** Codex reasons before answering, so a one-word reply is not a fast reply. Measured at 6.3s. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** The only event that carries usage. Everything else in the stream is progress. */
interface CodexUsage {
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly cache_write_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
}

export interface CodexCliOptions {
  readonly binary?: string;
  readonly timeoutMs?: number;
  /** Injected so tests can drive the adapter without a subprocess or a plan call. */
  readonly exec?: (
    argv: readonly string[],
    stdin: string,
    timeoutMs: number,
    lastMessagePath: string,
  ) => Promise<ExecResult>;
}

export class CodexCliProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly endpoint = "cli";
  readonly tokenSource = "cli_usage" as const;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly exec: NonNullable<CodexCliOptions["exec"]>;

  constructor(model: string, options: CodexCliOptions = {}) {
    // An empty model means "whatever Codex is configured to use", which is a real and common way to
    // invoke it - and the ONLY way that works on a ChatGPT plan, where naming a model can be
    // rejected outright ("The 'gpt-5.1-codex' model is not supported when using Codex with a
    // ChatGPT account"). It is recorded as the literal string "default" rather than "" so the
    // provider name reads `codex_cli:default` instead of `codex_cli:`, and so a watch pinned to it
    // has something to compare. That is a description of what was ASKED for, which is all
    // `requestedModel` ever claims to be; what actually served the call is separately recorded as
    // not disclosed.
    this.model = model.trim() === "" ? "default" : model;
    this.name = `codex_cli:${this.model}`;
    this.binary = options.binary ?? "codex";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.exec = options.exec ?? runSubprocess;
  }

  available(): Availability {
    // Deliberately not a `which` probe. `claudeCli` makes the same choice: an absent binary shows
    // up as a failed call with the OS error attached, which is a better message than a guess made
    // before the attempt.
    return { ok: true, reason: "" };
  }

  /**
   * The argv, and every flag is load-bearing.
   *
   *   --ephemeral            no session files on disk, so a probe leaves nothing behind.
   *   --skip-git-repo-check  the working dir is a temp dir, not a repository.
   *   --ignore-user-config   a developer's own `config.toml` cannot change what a probe measures.
   *                          Without it the same case costs and answers differently per laptop.
   *   -s read-only           it answers; it does not act.
   *   --color never          escape codes in a recorded output are bytes the grader would read.
   *   --json                 the only route to token usage. Human output has none.
   *   -o <file>              the final message, clean, without the progress chatter.
   *   -                      prompt on stdin.
   *
   * `approval: never` is already the default for `codex exec` and is confirmed in its banner, so
   * there is no approvals flag to pass.
   */
  argv(lastMessagePath: string, schemaPath?: string): readonly string[] {
    const argv = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-s",
      "read-only",
      "--color",
      "never",
      "--json",
      "-C",
      join(lastMessagePath, ".."),
      "-o",
      lastMessagePath,
    ];
    // "default" is this adapter's word for "pass no -m at all". It must not reach the argv.
    if (this.model !== "default") argv.push("-m", this.model);
    if (schemaPath !== undefined) argv.push("--output-schema", schemaPath);
    argv.push("-");
    return argv;
  }

  async complete(request: CompletionRequest): Promise<ProviderResponse> {
    const started = process.hrtime.bigint();
    const wall = (): number => Number(process.hrtime.bigint() - started) / 1e6;

    // A temp dir per call, removed in `finally`. The last-message file and the schema are the only
    // artifacts and neither belongs in the repository.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-codex-"));
    const lastMessagePath = join(dir, "last.txt");
    try {
      let schemaPath: string | undefined;
      if (request.jsonSchema !== undefined) {
        schemaPath = join(dir, "schema.json");
        writeFileSync(schemaPath, JSON.stringify(request.jsonSchema));
      }

      // One instruction stream. See the header: codex exec has no separate system prompt.
      const prompt =
        request.system.trim() === "" ? request.user : `${request.system}\n\n${request.user}`;

      let out: ExecResult;
      try {
        out = await this.exec(
          [this.binary, ...this.argv(lastMessagePath, schemaPath)],
          prompt,
          this.timeoutMs,
          lastMessagePath,
        );
      } catch (cause) {
        return { ...skipped("exec failed"), wallMs: wall(), error: describe(cause) };
      }
      const wallMs = wall();

      if (out.timedOut) return { ...skipped("timeout"), wallMs, error: "timeout" };

      let text = "";
      try {
        text = readFileSync(lastMessagePath, "utf8");
      } catch {
        text = "";
      }

      // A NON-ZERO EXIT WITH NO ANSWER IS A FAILED CALL. A non-zero exit WITH an answer is not:
      // codex writes MCP and hook warnings to stderr on this machine, and one of them setting the
      // exit code would otherwise discard a completion that arrived. The last-message file is the
      // authority on whether the model answered.
      if (text.trim() === "") {
        // THE REASON IS ON STDOUT, NOT STDERR, and reading only stderr threw it away. Measured: a
        // run with an unsupported model recorded `exit 1: ` with an empty stderr, while the event
        // stream carried "The 'gpt-5.1-codex' model is not supported when using Codex with a
        // ChatGPT account." That is the same defect this project fixed in its HTTP adapters, where
        // a non-200 body was discarded and every 400 read as `unexpected status`. A failed call
        // whose reason is unreadable is a failed call nobody can act on.
        const reason = lastError(out.stdout);
        const detail = reason !== "" ? reason : out.stderr.trim();
        return {
          ...skipped("no answer"),
          wallMs,
          error: `exit ${String(out.code)}: ${detail.slice(0, 300)}`,
        };
      }

      const usage = lastUsage(out.stdout);
      return {
        text,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cached_input_tokens ?? 0,
        cacheCreateTokens: usage.cache_write_input_tokens ?? 0,
        // NOT EXPOSED, and 0 rather than the wall time on purpose. Copying a client measurement
        // into the field documented as "server-reported" is the defect this project found in its
        // own HTTP adapters; it is not going to be introduced here deliberately.
        apiMs: 0,
        clientMs: 0,
        wallMs,
        harnessCostUsd: 0,
        // EMPTY, NOT THE REQUESTED ALIAS. See the header. `metadataOf` reads "" as `not_exposed`
        // and `undisclosedFields` lists it, which is the honest rendering of a provider that
        // declines to say what served the call.
        modelServed: "",
        canonicalModel: "",
        contextWindow: null,
        maxOutputTokens: null,
        serviceTier: "",
        costBasis: "",
        stopReason: "",
        error: "",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * The usage from the last `turn.completed` event in the JSONL stream.
 *
 * Parsed line by line and tolerantly: the stream also carries `thread.started`, `item.completed`
 * and, on this machine, MCP transport warnings that are not JSON at all. A parser that threw on the
 * first unrecognised line would turn a successful call into a failed one.
 */
export function lastUsage(stdout: string): CodexUsage {
  let found: CodexUsage = {};
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; usage?: CodexUsage };
      if (event.type === "turn.completed" && event.usage !== undefined) found = event.usage;
    } catch {
      // Not an event line. Skip it rather than failing the call.
    }
  }
  return found;
}

/**
 * The last error the event stream reported, or "" if it reported none.
 *
 * Codex signals failure through `item.completed` items of type `error`, a top-level `error` event,
 * and `turn.failed`. The message is sometimes a bare string and sometimes a JSON envelope from the
 * API, so the envelope is unwrapped when it parses and passed through when it does not.
 */
export function lastError(stdout: string): string {
  let found = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        message?: string;
        error?: { message?: string };
        item?: { type?: string; message?: string };
      };
      const raw =
        event.type === "turn.failed"
          ? event.error?.message
          : event.type === "error"
            ? event.message
            : event.item?.type === "error"
              ? event.item.message
              : undefined;
      if (raw !== undefined && raw !== "") found = unwrap(raw);
    } catch {
      // Not an event line.
    }
  }
  return found;
}

/** An API error arrives as a JSON string inside a message field. Unwrap it when it is one. */
function unwrap(message: string): string {
  try {
    const doc = JSON.parse(message) as { error?: { message?: string } };
    return doc.error?.message ?? message;
  } catch {
    return message;
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
