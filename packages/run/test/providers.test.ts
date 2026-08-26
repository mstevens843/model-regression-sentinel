// The provider seam, exercised against real recorded responses.
//
// The CLI fixtures below are REAL responses captured from `claude -p --output-format json` on this
// machine while this project was being built, trimmed to the fields the adapter reads. Using a
// recorded response rather than an invented one is the point: an adapter tested against a fixture
// its own author imagined is an adapter tested against its author's assumptions, and the field this
// project most depends on - the dated snapshot hiding in the `modelUsage` KEY rather than in
// `canonicalModel` - is exactly the sort of thing an invented fixture gets wrong.

import { describe, expect, it } from "vitest";
import { canonicalRateKey, summariseCost } from "../src/cost.js";
import { fingerprintDiff, fingerprintOf, undisclosedFields } from "../src/fingerprint.js";
import { ClaudeCliProvider, type ExecResult } from "../src/providers/claudeCli.js";
import { AnthropicApiProvider, OpenAiCompatibleProvider } from "../src/providers/httpApi.js";
import { NoopProvider } from "../src/providers/noop.js";
import { ReplayProvider, replayTable, requestKey } from "../src/providers/replay.js";
import { skipped } from "../src/types.js";

/** Real, from `--model sonnet`. Note the alias resolves to an UNDATED identity. */
const SONNET_RESPONSE = JSON.stringify({
  is_error: false,
  duration_api_ms: 1334,
  duration_ms: 1502,
  stop_reason: "end_turn",
  total_cost_usd: 0.00084,
  result: "HOLD",
  usage: {
    input_tokens: 2,
    output_tokens: 6,
    cache_read_input_tokens: 3301,
    cache_creation_input_tokens: 0,
    service_tier: "standard",
  },
  modelUsage: {
    "claude-sonnet-5": {
      canonicalModel: "claude-sonnet-5",
      contextWindow: 1000000,
      maxOutputTokens: 64000,
      provider: "firstParty",
      costBasis: "list",
    },
  },
});

/** Real, from `--model haiku`. THE alias resolves to a DATED snapshot, and only in the key. */
const HAIKU_RESPONSE = JSON.stringify({
  is_error: false,
  duration_api_ms: 900,
  duration_ms: 1100,
  stop_reason: "end_turn",
  total_cost_usd: 0.0004,
  result: "HOLD",
  usage: {
    input_tokens: 2,
    output_tokens: 6,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 900,
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      canonicalModel: "claude-haiku-4-5",
      contextWindow: 200000,
      provider: "firstParty",
      costBasis: "list",
    },
  },
});

const fakeExec =
  (
    stdout: string,
    code = 0,
  ): ((a: readonly string[], b: string, c: number) => Promise<ExecResult>) =>
  () =>
    Promise.resolve({ code, stdout, stderr: "", timedOut: false });

const REQUEST = { system: "terse", user: "decide" };

describe("ClaudeCliProvider", () => {
  it("carries every flag the cost measurement depends on", () => {
    // Measured on this machine: an unflagged call reported 112,748 cache-creation tokens and cost
    // $0.451; with these flags the same call cost $0.0132 cold and $0.00084 warm. A canary set is
    // paid for on every tick forever, so losing one of these is not a style regression.
    const argv = new ClaudeCliProvider("sonnet").argv(REQUEST).join(" ");
    for (const flag of [
      "--tools",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--max-turns 1",
      "--system-prompt",
      "--output-format json",
    ]) {
      expect(argv, `${flag} is missing from the argv`).toContain(flag);
    }
  });

  it("passes a schema only when the case declares one", () => {
    expect(new ClaudeCliProvider("sonnet").argv(REQUEST)).not.toContain("--json-schema");
    const withSchema = new ClaudeCliProvider("sonnet").argv({
      ...REQUEST,
      jsonSchema: { type: "object" },
    });
    expect(withSchema).toContain("--json-schema");
  });

  it("does not put the prompt in argv, because --tools is variadic and would swallow it", () => {
    expect(new ClaudeCliProvider("sonnet").argv(REQUEST)).not.toContain("decide");
  });

  it("reads an undated alias resolution", async () => {
    const p = new ClaudeCliProvider("sonnet", { exec: fakeExec(SONNET_RESPONSE) });
    const r = await p.complete(REQUEST);
    expect(r.text).toBe("HOLD");
    expect(r.modelServed).toBe("claude-sonnet-5");
    expect(r.canonicalModel).toBe("claude-sonnet-5");
    expect(r.contextWindow).toBe(1000000);
    expect(r.apiMs).toBe(1334);
    expect(r.cacheReadTokens).toBe(3301);
    expect(r.error).toBe("");
  });

  it("takes the DATED snapshot from the modelUsage key rather than from canonicalModel", async () => {
    // The single most important line in this adapter. `canonicalModel` is the coarser identity; the
    // key is where a dated snapshot appears when the provider exposes one. Reading canonicalModel
    // instead would make this project blind to precisely the change it exists to watch.
    const p = new ClaudeCliProvider("haiku", { exec: fakeExec(HAIKU_RESPONSE) });
    const r = await p.complete(REQUEST);
    expect(r.modelServed).toBe("claude-haiku-4-5-20251001");
    expect(r.canonicalModel).toBe("claude-haiku-4-5");
  });

  it("records three latency figures and never collapses them", async () => {
    const p = new ClaudeCliProvider("sonnet", { exec: fakeExec(SONNET_RESPONSE) });
    const r = await p.complete(REQUEST);
    expect(r.apiMs).toBe(1334);
    expect(r.clientMs).toBe(1502);
    expect(r.wallMs).toBeGreaterThanOrEqual(0);
    expect(r.apiMs).toBeLessThan(r.clientMs);
  });

  it("turns a non-zero exit into a carried reason rather than a throw", async () => {
    const p = new ClaudeCliProvider("sonnet", { exec: fakeExec("", 1) });
    const r = await p.complete(REQUEST);
    expect(r.error).toContain("exit 1");
    expect(r.text).toBe("");
  });

  it("turns unparseable output into a carried reason", async () => {
    const p = new ClaudeCliProvider("sonnet", { exec: fakeExec("not json") });
    expect((await p.complete(REQUEST)).error).toBe("unparseable CLI json");
  });
});

describe("the BYOK HTTP providers", () => {
  const noKey = { ...process.env };

  it("skip cleanly with no key, naming the variable a caller has to set", () => {
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    const p = new AnthropicApiProvider("claude-sonnet-5");
    expect(p.available().ok).toBe(false);
    expect(p.available().reason).toContain("ANTHROPIC_API_KEY");
    process.env = { ...noKey };
  });

  it("take the variable NAME as a parameter, so the absent path is testable without a key", () => {
    const p = new AnthropicApiProvider("claude-sonnet-5", { apiKeyEnv: "A_KEY_THAT_IS_NOT_SET" });
    expect(p.available().reason).toContain("A_KEY_THAT_IS_NOT_SET");
  });

  it("refuse a non-https endpoint outright rather than warning", async () => {
    // A drift sentinel authenticates on a schedule forever. Sending a bearer token to a plaintext
    // endpoint once is enough.
    process.env.OPENAI_API_KEY = "not-a-real-key-value-for-testing";
    const p = new OpenAiCompatibleProvider("gpt-x", { baseUrl: "http://localhost:8000/v1" });
    expect(p.available().ok).toBe(false);
    expect(p.available().reason).toContain("non-https");
    expect((await p.complete(REQUEST)).error).toContain("SKIPPED");
    process.env = { ...noKey };
  });

  it("never let a key reach a response object", async () => {
    process.env.ANTHROPIC_API_KEY = "not-a-real-key-value-for-testing";
    let seenHeaders: Record<string, string> = {};
    const p = new AnthropicApiProvider("claude-sonnet-5", {
      fetcher: (_url, init) => {
        seenHeaders = init.headers;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              model: "claude-sonnet-5",
              content: [{ text: "HOLD" }],
              usage: { input_tokens: 2, output_tokens: 1 },
            }),
        });
      },
    });
    const r = await p.complete(REQUEST);
    // The key must be on the wire and nowhere else.
    expect(seenHeaders["x-api-key"]).toBe("not-a-real-key-value-for-testing");
    expect(JSON.stringify(r)).not.toContain("not-a-real-key-value-for-testing");
    expect(r.text).toBe("HOLD");
    process.env = { ...noKey };
  });
});

describe("NoopProvider", () => {
  it("makes absence explicit instead of letting a row vanish", async () => {
    const p = new NoopProvider("no credentials in CI");
    expect(p.available().ok).toBe(false);
    const r = await p.complete(REQUEST);
    expect(r.error).toBe("SKIPPED: no credentials in CI");
  });
});

describe("ReplayProvider", () => {
  const table = replayTable([
    { requestSha256: requestKey(REQUEST), response: { ...skipped(""), text: "A", error: "" } },
    { requestSha256: requestKey(REQUEST), response: { ...skipped(""), text: "B", error: "" } },
  ]);

  it("joins by content, so a prompt edit invalidates loudly", async () => {
    const p = new ReplayProvider(table, "t", "m");
    expect((await p.complete(REQUEST)).text).toBe("A");
    const edited = await p.complete({ ...REQUEST, user: "decide " });
    expect(edited.error).toBe("cache miss");
    expect(p.missCount()).toBe(1);
  });

  it("serves replicates in recorded order and then wraps", async () => {
    const p = new ReplayProvider(table, "t", "m");
    expect((await p.complete(REQUEST)).text).toBe("A");
    expect((await p.complete(REQUEST)).text).toBe("B");
    expect((await p.complete(REQUEST)).text).toBe("A");
  });

  it("never reaches the network on a miss", async () => {
    const p = new ReplayProvider(new Map(), "t", "m");
    expect((await p.complete(REQUEST)).error).toBe("cache miss");
  });

  it("names a perturbation in the provider name, so a perturbed run cannot pass as a real one", () => {
    const p = new ReplayProvider(table, "t", "m", {
      perturb: (r) => r,
      perturbLabel: "drop-30",
      draw: () => 0.5,
    });
    expect(p.name).toContain("drop-30");
  });

  it("refuses to perturb without a seeded generator", async () => {
    const p = new ReplayProvider(table, "t", "m", { perturb: (r) => r, perturbLabel: "x" });
    await expect(p.complete(REQUEST)).rejects.toThrow(/seeded/);
  });
});

describe("cost", () => {
  it("maps a dated served model onto its rate-card key by longest prefix", () => {
    expect(canonicalRateKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(canonicalRateKey("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(canonicalRateKey("something-else")).toBe("something-else");
  });

  it("reports two bounds and marks an unknown model rather than reporting zero", () => {
    const rows = [
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 3301,
        cacheCreateTokens: 0,
        harnessCostUsd: 0.00084,
      },
    ];
    const known = summariseCost("claude-sonnet-5", rows);
    expect(known.harnessUsdPerCall).toBeCloseTo(0.00084, 6);
    expect(known.bareApiUsdPerCall).toBeCloseTo(100e-6 * 2 + 50e-6 * 10, 9);
    expect(known.rateUnknown).toBe(false);
    // The harness figure is the upper bound and the computed one the lower.
    expect(known.harnessUsdPerCall).toBeGreaterThan(known.bareApiUsdPerCall);
    expect(summariseCost("some-other-vendor-model", rows).rateUnknown).toBe(true);
  });
});

describe("the provider identity fingerprint", () => {
  const sonnet = fingerprintOf("claude_cli", "sonnet", {
    ...skipped(""),
    modelServed: "claude-sonnet-5",
    canonicalModel: "claude-sonnet-5",
    contextWindow: 1000000,
    maxOutputTokens: 64000,
    costBasis: "list",
    serviceTier: "standard",
    error: "",
  });

  it("is stable for identical facts and changes when any of them changes", () => {
    expect(
      fingerprintOf("claude_cli", "sonnet", {
        ...skipped(""),
        modelServed: "claude-sonnet-5",
        canonicalModel: "claude-sonnet-5",
        contextWindow: 1000000,
        maxOutputTokens: 64000,
        costBasis: "list",
        serviceTier: "standard",
        error: "",
      }).sha256,
    ).toBe(sonnet.sha256);
    const shrunk = fingerprintOf("claude_cli", "sonnet", {
      ...skipped(""),
      modelServed: "claude-sonnet-5",
      canonicalModel: "claude-sonnet-5",
      contextWindow: 200000,
      maxOutputTokens: 64000,
      costBasis: "list",
      serviceTier: "standard",
      error: "",
    });
    expect(shrunk.sha256).not.toBe(sonnet.sha256);
    expect(fingerprintDiff(sonnet, shrunk)).toEqual([
      { field: "contextWindow", before: "1000000", after: "200000" },
    ]);
  });

  it("names the fields a provider declined to expose rather than implying they were stable", () => {
    // Measured: the `haiku` alias exposes a dated snapshot and `sonnet` does not, so a tool that
    // assumed a dated id exists would report "no identity change" for a provider that never had one
    // to show.
    const partial = fingerprintOf("other", "alias", {
      ...skipped(""),
      modelServed: "x",
      error: "",
    });
    expect(undisclosedFields(partial)).toEqual([
      "contextWindow",
      "maxOutputTokens",
      "canonicalModel",
      "serviceTier",
    ]);
    expect(undisclosedFields(sonnet)).toEqual([]);
  });
});
