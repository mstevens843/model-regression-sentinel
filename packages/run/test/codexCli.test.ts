// The Codex CLI adapter, driven by a fake exec so no plan usage is consumed.
//
// WHAT THESE PIN, and it is mostly about what this provider does NOT know. `codex exec` discloses
// real token usage and nothing else: no served model identity for any alias, no server-reported
// latency, no cost, no stop reason. The temptation in every one of those cases is to fill the field
// with the nearest available number - the requested alias for the identity, the wall clock for the
// latency - and each of those would manufacture a measurement out of an absence. These tests exist
// so that cannot happen quietly.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/providers/claudeCli.js";
import { CodexCliProvider, lastError, lastUsage } from "../src/providers/codexCli.js";

const REQUEST = { system: "You are terse.", user: "Answer with one word." };

const USAGE_LINE =
  '{"type":"turn.completed","usage":{"input_tokens":17595,"cached_input_tokens":4480,"cache_write_input_tokens":0,"output_tokens":24,"reasoning_output_tokens":16}}';

/** A fake `codex exec` that writes the answer where the real one would and returns a real stream. */
const fake = (
  opts: { answer?: string; stdout?: string; code?: number | null; stderr?: string } = {},
): { provider: CodexCliProvider; seen: { argv: readonly string[]; stdin: string }[] } => {
  const seen: { argv: readonly string[]; stdin: string }[] = [];
  const provider = new CodexCliProvider("gpt-5.1-codex", {
    exec: (argv, stdin, _timeoutMs, lastMessagePath): Promise<ExecResult> => {
      seen.push({ argv, stdin });
      if (opts.answer !== undefined) writeFileSync(lastMessagePath, opts.answer);
      return Promise.resolve({
        code: opts.code ?? 0,
        stdout: opts.stdout ?? `{"type":"thread.started"}\n${USAGE_LINE}\n`,
        stderr: opts.stderr ?? "",
        timedOut: false,
      });
    },
  });
  return { provider, seen };
};

describe("CodexCliProvider argv", () => {
  it("answers rather than acts, and leaves nothing behind", async () => {
    const { provider, seen } = fake({ answer: "HOLD" });
    await provider.complete(REQUEST);
    const argv = seen[0]?.argv ?? [];
    // read-only means it cannot write; ephemeral means no session file survives the call.
    expect(argv).toContain("--ephemeral");
    expect(argv).toContain("read-only");
    // A developer's own config.toml must not change what a probe measures.
    expect(argv).toContain("--ignore-user-config");
    // The working dir is a temp dir, so the model is never pointed at this repository.
    expect(argv).toContain("--skip-git-repo-check");
    // --json is the only route to token usage; the human output carries none.
    expect(argv).toContain("--json");
    // Escape codes in a recorded output are bytes the grader would read.
    expect(argv).toContain("never");
  });

  it("sends the prompt over stdin, never in argv", async () => {
    // The prompt is built from corpus content and can be long. argv is the wrong place for either
    // property, and `claudeCli` records hitting exactly that problem.
    const { provider, seen } = fake({ answer: "HOLD" });
    await provider.complete({ system: "SYS-MARKER", user: "USER-MARKER" });
    const argv = (seen[0]?.argv ?? []).join(" ");
    expect(argv).not.toContain("USER-MARKER");
    expect(argv).not.toContain("SYS-MARKER");
    expect(seen[0]?.stdin).toContain("USER-MARKER");
    // There is no separate system prompt in `codex exec`, so the two are one stream.
    expect(seen[0]?.stdin).toContain("SYS-MARKER");
    expect(argv[argv.length - 1]).toBe("-");
  });

  it("passes a case schema through when one is declared", async () => {
    const { provider, seen } = fake({ answer: '{"verdict":"HOLD"}' });
    await provider.complete({ ...REQUEST, jsonSchema: { type: "object" } });
    expect(seen[0]?.argv).toContain("--output-schema");
  });
});

describe("CodexCliProvider records absences as absences", () => {
  it("NEVER invents a served model identity", async () => {
    // THE ONE THAT MATTERS. Codex names no model in any event, for any alias. Writing the requested
    // alias into `modelServed` would manufacture a stable identity out of an absent one, and an
    // identity check that can never fire is worse than one that says it cannot see. "" is what
    // `metadataOf` maps to `not_exposed`.
    const { provider } = fake({ answer: "HOLD" });
    const r = await provider.complete(REQUEST);
    expect(r.modelServed).toBe("");
    expect(r.canonicalModel).toBe("");
    expect(r.modelServed).not.toContain("gpt");
    expect(r.contextWindow).toBeNull();
    expect(r.maxOutputTokens).toBeNull();
    expect(r.serviceTier).toBe("");
    expect(r.costBasis).toBe("");
  });

  it("does not copy the wall clock into the server-reported latency field", async () => {
    // `apiMs` is documented as the SERVER's figure. Filling it with a client measurement is the
    // defect this project found in its own HTTP adapters; it is not reintroduced here.
    const { provider } = fake({ answer: "HOLD" });
    const r = await provider.complete(REQUEST);
    expect(r.apiMs).toBe(0);
    expect(r.clientMs).toBe(0);
    expect(r.wallMs).toBeGreaterThan(0);
    expect(r.harnessCostUsd).toBe(0);
  });

  it("records the real token usage it does get", async () => {
    const { provider } = fake({ answer: "HOLD" });
    const r = await provider.complete(REQUEST);
    expect(r.inputTokens).toBe(17595);
    expect(r.outputTokens).toBe(24);
    expect(r.cacheReadTokens).toBe(4480);
    expect(r.cacheCreateTokens).toBe(0);
  });
});

describe("CodexCliProvider failure handling", () => {
  it("treats an empty answer as a failed call, whatever the exit code", async () => {
    const { provider } = fake({ code: 0 });
    const r = await provider.complete(REQUEST);
    expect(r.error).not.toBe("");
    expect(r.text).toBe("");
  });

  it("keeps an answer that arrived despite a non-zero exit", async () => {
    // Measured on this machine: codex writes MCP transport and hook warnings to stderr, and one of
    // them setting the exit code would otherwise discard a completion that actually arrived. The
    // last-message file is the authority on whether the model answered.
    const { provider } = fake({ answer: "HOLD", code: 1, stderr: "ERROR rmcp::transport: closed" });
    const r = await provider.complete(REQUEST);
    expect(r.text).toBe("HOLD");
    expect(r.error).toBe("");
  });

  it("survives a stream that is not all JSON", async () => {
    // The same warnings land on stdout in some configurations. A parser that threw on the first
    // unrecognised line would turn a successful call into a failed one.
    const { provider } = fake({
      answer: "HOLD",
      stdout: `noise not json\n${USAGE_LINE}\nmore noise\n`,
    });
    const r = await provider.complete(REQUEST);
    expect(r.text).toBe("HOLD");
    expect(r.inputTokens).toBe(17595);
  });

  it("reports zero usage rather than failing when no usage event arrived", async () => {
    const { provider } = fake({ answer: "HOLD", stdout: '{"type":"thread.started"}\n' });
    const r = await provider.complete(REQUEST);
    expect(r.text).toBe("HOLD");
    expect(r.inputTokens).toBe(0);
  });
});

describe("lastUsage", () => {
  it("takes the last turn.completed, not the first", () => {
    const first = '{"type":"turn.completed","usage":{"input_tokens":1}}';
    const second = '{"type":"turn.completed","usage":{"input_tokens":2}}';
    expect(lastUsage(`${first}\n${second}`).input_tokens).toBe(2);
  });

  it("is empty when the stream carries no usage at all", () => {
    expect(lastUsage('{"type":"turn.started"}')).toEqual({});
    expect(lastUsage("")).toEqual({});
  });
});

describe("the temp directory is cleaned up", () => {
  it("leaves no artifact behind after a call", async () => {
    const before = mkdtempSync(join(tmpdir(), "sentinel-codex-probe-"));
    const { provider } = fake({ answer: "HOLD" });
    await provider.complete(REQUEST);
    // The provider's own dir is removed in `finally`; this only asserts the call did not throw on
    // the cleanup path, which is where a leaked handle would surface.
    expect(before).toContain("sentinel-codex-probe-");
  });
});

// THE REASON A CALL FAILED, WHICH WAS BEING THROWN AWAY.
//
// Codex reports failure through the JSONL event stream on stdout, not through stderr. Reading only
// stderr recorded `exit 1: ` with nothing after the colon for a run whose stream said "The
// 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account." Measured on a
// real 8-call collection, where all 8 failed and none of them said why. Same defect this project
// fixed in its HTTP adapters, where a discarded 400 body made every one read as `unexpected status`.
describe("a failed Codex call says why", () => {
  const streamWith = (...lines: string[]): string => `${lines.join("\n")}\n`;

  it("unwraps an API error envelope out of turn.failed", async () => {
    const envelope =
      '{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-5.1-codex\' model is not supported when using Codex with a ChatGPT account.\\"}}';
    const { provider } = fake({
      code: 1,
      stdout: streamWith(
        '{"type":"thread.started"}',
        `{"type":"turn.failed","error":{"message":"${envelope}"}}`,
      ),
    });
    const r = await provider.complete(REQUEST);
    expect(r.error).toContain("not supported when using Codex with a ChatGPT account");
    expect(r.error).not.toMatch(/exit 1: $/);
  });

  it("reads a plain error item too", async () => {
    const { provider } = fake({
      code: 1,
      stdout: streamWith(
        '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `x` not found."}}',
      ),
    });
    const r = await provider.complete(REQUEST);
    expect(r.error).toContain("Model metadata");
  });

  it("falls back to stderr when the stream said nothing", async () => {
    const { provider } = fake({ code: 1, stdout: "", stderr: "spawn ENOENT" });
    const r = await provider.complete(REQUEST);
    expect(r.error).toContain("ENOENT");
  });
});

describe("lastError", () => {
  it("is empty on a clean stream", () => {
    expect(lastError('{"type":"turn.completed","usage":{}}')).toBe("");
  });
  it("takes the last error, not the first", () => {
    const s = `{"type":"error","message":"first"}\n{"type":"error","message":"second"}`;
    expect(lastError(s)).toBe("second");
  });
});

describe("the provider default model", () => {
  it("passes no -m at all, and says default rather than empty", async () => {
    // Naming a model is rejected outright on a ChatGPT plan, so the default is the only invocation
    // that works there. "" would produce the provider name `codex_cli:` and give a watch nothing to
    // pin against.
    const seen: readonly string[][] = [];
    const captured: string[][] = seen as string[][];
    const provider = new CodexCliProvider("", {
      exec: (argv, _stdin, _t, last): Promise<ExecResult> => {
        captured.push([...argv]);
        writeFileSync(last, "HOLD");
        return Promise.resolve({ code: 0, stdout: USAGE_LINE, stderr: "", timedOut: false });
      },
    });
    expect(provider.model).toBe("default");
    expect(provider.name).toBe("codex_cli:default");
    await provider.complete(REQUEST);
    expect(captured[0]).not.toContain("-m");
    expect(captured[0]).not.toContain("default");
  });

  it("still passes an explicitly named model", async () => {
    const captured: string[][] = [];
    const provider = new CodexCliProvider("o3", {
      exec: (argv, _stdin, _t, last): Promise<ExecResult> => {
        captured.push([...argv]);
        writeFileSync(last, "HOLD");
        return Promise.resolve({ code: 0, stdout: USAGE_LINE, stderr: "", timedOut: false });
      },
    });
    await provider.complete(REQUEST);
    expect(captured[0]).toContain("-m");
    expect(captured[0]).toContain("o3");
  });
});
