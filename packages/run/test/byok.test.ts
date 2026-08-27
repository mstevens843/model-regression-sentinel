// The two BYOK HTTP adapters, driven end to end against a fake transport and no key.
//
// WHY THIS FILE EXISTS. `providers.test.ts` proves the credential rules: the absent-key skip, the
// non-https refusal, and one happy path for Anthropic. It does not touch what happens when the
// endpoint answers badly, and that is the whole interesting half. A drift sentinel runs unattended
// on a schedule, so the way it behaves on a 429, on a truncated body, or on a provider that has
// stopped answering IS its behaviour most days. Those paths are also the ones nobody exercises by
// hand, because producing them against a live endpoint means waiting for an outage.
//
// EVERY ASSERTION IS ON A RETURNED `ProviderResponse`, NEVER ON A THROW. Absence and failure are
// return values in this design, and a test that asserted `rejects.toThrow` would be pinning the
// opposite contract. The property that matters most is at the bottom: every failure mode carries a
// non-empty `error`, because `packages/detect/src/metrics.ts` grades exactly those records whose
// error is empty, and a failure that came back with an empty error and an empty string of text
// would be scored as a WRONG ANSWER. A provider incident read as a quality regression is the single
// most damaging thing this instrument could do, so it is checked in a loop over a table rather than
// case by case, and adding a failure mode without a reason fails that loop.
//
// WHAT WAS REJECTED. A mocking library, and a live-endpoint flag. The first would add a dependency
// to a repository whose zero-dependency claim is a product promise, to fake a seam that is one
// function wide. The second would put a code path in this repository that can spend money and
// contact a vendor, gated only by a default, and the honest state of these adapters is that they
// have never been run against a live endpoint at all.
//
// WHAT THIS IS NOT. It is not evidence that either adapter works against a real provider. Every
// byte here was written by the same person who wrote the adapter, so this file proves the adapter
// is self-consistent and proves nothing about the wire formats being right. `PROVIDER_REGISTRY`
// still says `everRun: false` for both, and it stays that way until a key exists.

import { type EvalCase, caseId, detectRefusal, promptId } from "@model-regression-sentinel/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprintOf, undisclosedFields } from "../src/fingerprint.js";
import {
  AnthropicApiProvider,
  type Fetcher,
  OpenAiCompatibleProvider,
} from "../src/providers/httpApi.js";
import { runCorpus } from "../src/runner.js";
import type { Provider, ProviderResponse } from "../src/types.js";

// A variable name no real deployment uses, so nothing here can read or clobber a real credential.
const KEY_ENV = "SENTINEL_BYOK_TEST_KEY";
const FAKE_KEY = "not-a-real-key-value-for-testing-byok";
const BASE_URL = "https://fake.invalid/v1";
const REQUEST = { system: "terse", user: "decide" };

beforeAll(() => {
  process.env[KEY_ENV] = FAKE_KEY;
});
afterAll(() => {
  Reflect.deleteProperty(process.env, KEY_ENV);
});

// ---- the fake transport ------------------------------------------------------------------------

/** What the wire is scripted to do. Everything optional; the default is a 200 carrying `body`. */
interface Wire {
  readonly status?: number;
  readonly body?: unknown;
  /** `res.json()` rejects with this: a 200 whose body is not JSON at all. */
  readonly jsonError?: Error;
  /** The fetch itself rejects with this: an outage, a DNS failure, an abort. */
  readonly transportError?: unknown;
}

/** What the adapter actually put on the wire. The only place a key is allowed to appear. */
interface SentCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface Adapter {
  readonly provider: Provider;
  readonly sent: readonly SentCall[];
}

/**
 * A `Fetcher` built from a script, hand-rolled on purpose.
 *
 * The seam is ONE FUNCTION with four inputs and three outputs, so a fake is shorter than the
 * configuration a mock would need, and it costs no dependency in a repository that ships none. It
 * also keeps the REQUEST in plain sight: half of what follows is an assertion about what did and
 * did not leave this process, and a mock that files calls away in its own registry turns that into
 * framework trivia. Response headers are not modelled because `Fetcher` does not expose them to the
 * adapter, so a scripted `retry-after` could not be read even if one were scripted.
 */
function fakeTransport(wire: Wire): {
  readonly fetcher: Fetcher;
  readonly sent: readonly SentCall[];
} {
  const sent: SentCall[] = [];
  const status = wire.status ?? 200;
  const fetcher: Fetcher = (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    if ("transportError" in wire) return Promise.reject(wire.transportError);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () =>
        wire.jsonError === undefined ? Promise.resolve(wire.body) : Promise.reject(wire.jsonError),
    });
  };
  return { fetcher, sent };
}

/** An error with a chosen `name`, which is the only part of a thrown error the adapter reads. */
const named = (name: string): Error => Object.assign(new Error("scripted"), { name });

const anthropic = (wire: Wire): Adapter => {
  const t = fakeTransport(wire);
  const provider = new AnthropicApiProvider("claude-sonnet-5", {
    apiKeyEnv: KEY_ENV,
    fetcher: t.fetcher,
  });
  return { provider, sent: t.sent };
};

const openai = (wire: Wire): Adapter => {
  const t = fakeTransport(wire);
  const provider = new OpenAiCompatibleProvider("gpt-x", {
    apiKeyEnv: KEY_ENV,
    baseUrl: BASE_URL,
    fetcher: t.fetcher,
  });
  return { provider, sent: t.sent };
};

// The token counts are the MEASURED per-call means from `results/runs/baseline.json`, 24 cases at
// 10 replicates, so the fixture and the cost arithmetic in `docs/PROVIDERS.md` agree on one number
// rather than two.
const ANTHROPIC_OK = {
  model: "claude-sonnet-5",
  stop_reason: "end_turn",
  usage: {
    input_tokens: 468,
    output_tokens: 41,
    cache_read_input_tokens: 3301,
    cache_creation_input_tokens: 0,
  },
  content: [{ text: "HO" }, { text: "LD" }],
};

const OPENAI_OK = {
  model: "gpt-x-2026-02-11",
  usage: { prompt_tokens: 468, completion_tokens: 41 },
  choices: [{ finish_reason: "stop", message: { content: "HOLD" } }],
};

// ---- the happy path and the shapes next to it ---------------------------------------------------

describe("AnthropicApiProvider against a fake transport", () => {
  it("reads text, token counts and the served identity out of the Messages wire format", async () => {
    const a = anthropic({ body: ANTHROPIC_OK });
    const r = await a.provider.complete(REQUEST);
    // Two content blocks joined, because the wire format returns an array and a reader that took
    // only the first block would silently truncate any multi-block answer.
    expect(r.text).toBe("HOLD");
    expect(r.inputTokens).toBe(468);
    expect(r.outputTokens).toBe(41);
    expect(r.cacheReadTokens).toBe(3301);
    expect(r.cacheCreateTokens).toBe(0);
    expect(r.modelServed).toBe("claude-sonnet-5");
    expect(r.stopReason).toBe("end_turn");
    expect(r.error).toBe("");
    // No harness sits between this and the endpoint, so there is no overhead to subtract.
    expect(r.harnessCostUsd).toBe(0);
    // Exactly one request, and it went to the injected fetcher rather than to the network.
    expect(a.sent.length).toBe(1);
    expect(a.sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(a.sent[0]?.headers["anthropic-version"]).toBe(AnthropicApiProvider.VERSION);
  });

  it("returns zero counts when usage is absent, and zero is NOT distinguishable from unreported", async () => {
    // The finding, pinned as a test rather than written in a comment. `ProviderResponse` types the
    // counts as `number`, so a provider that omitted `usage` entirely and a provider that reported
    // four honest zeroes produce the same object. The capability fields are `number | null` because
    // that distinction was made there; it was not made here.
    const absent = await anthropic({
      body: { model: "m", stop_reason: "end_turn", content: [{ text: "HOLD" }] },
    }).provider.complete(REQUEST);
    const zeroed = await anthropic({
      body: {
        model: "m",
        stop_reason: "end_turn",
        content: [{ text: "HOLD" }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }).provider.complete(REQUEST);
    const counts = (r: ProviderResponse): readonly unknown[] => [
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      r.cacheCreateTokens,
      r.error,
    ];
    expect(counts(absent)).toEqual([0, 0, 0, 0, ""]);
    expect(counts(absent)).toEqual(counts(zeroed));
  });

  it("leaves modelServed empty when the body carries no model, and the fingerprint says so", async () => {
    const r = await anthropic({
      body: { stop_reason: "end_turn", content: [{ text: "HOLD" }] },
    }).provider.complete(REQUEST);
    expect(r.modelServed).toBe("");
    const f = fingerprintOf("anthropic_api", "claude-sonnet-5", r);
    expect(f.resolvedModel).toBe("");
    // Not a known value that happens to be empty. An empty string compares equal to the next empty
    // string forever, so without this a provider that never said what it served would read as a
    // provider whose identity was perfectly stable.
    expect(undisclosedFields(f)).toContain("resolvedModel");
  });

  it("treats a 429 as an outage: not a refusal, not a wrong answer, and named in words", async () => {
    const r = await anthropic({ status: 429 }).provider.complete(REQUEST);
    expect(r.error).toContain("429");
    expect(r.error).toContain("rate limited");
    // `metrics.ts` drops a record when `error !== ""` and grades it otherwise, so a non-empty error
    // IS the mechanism that keeps this out of the quality sample.
    expect(r.error).not.toBe("");
    expect(r.text).toBe("");
    expect(detectRefusal(r.text).refused).toBe(false);
    expect(r.stopReason).toBe("");
  });
});

describe("OpenAiCompatibleProvider against a fake transport", () => {
  it("reads text, token counts and the served identity out of the chat-completions format", async () => {
    const a = openai({ body: OPENAI_OK });
    const r = await a.provider.complete(REQUEST);
    expect(r.text).toBe("HOLD");
    expect(r.inputTokens).toBe(468);
    expect(r.outputTokens).toBe(41);
    expect(r.modelServed).toBe("gpt-x-2026-02-11");
    expect(r.stopReason).toBe("stop");
    expect(r.error).toBe("");
    expect(r.harnessCostUsd).toBe(0);
    expect(a.sent.length).toBe(1);
    expect(a.sent[0]?.url).toBe(`${BASE_URL}/chat/completions`);
  });

  it("reports zero cache tokens because the format has none, which is not the same as none used", async () => {
    // The same collapse as the Anthropic usage case and a sharper version of it: these two zeroes
    // are structural. `/v1/chat/completions` has no cache accounting for this adapter to read, so
    // the value is "not exposed by the wire format" and the type can only say 0.
    const r = await openai({ body: OPENAI_OK }).provider.complete(REQUEST);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheCreateTokens).toBe(0);
    const withoutUsage = await openai({
      body: { model: "m", choices: [{ finish_reason: "stop", message: { content: "HOLD" } }] },
    }).provider.complete(REQUEST);
    expect(withoutUsage.inputTokens).toBe(0);
    expect(withoutUsage.outputTokens).toBe(0);
    expect(withoutUsage.error).toBe("");
  });

  it("leaves modelServed empty when the body carries no model, and the fingerprint says so", async () => {
    const r = await openai({
      body: { choices: [{ finish_reason: "stop", message: { content: "HOLD" } }] },
    }).provider.complete(REQUEST);
    expect(r.modelServed).toBe("");
    expect(undisclosedFields(fingerprintOf("openai_compatible", "gpt-x", r))).toContain(
      "resolvedModel",
    );
  });

  it("treats a 429 as an outage: not a refusal, not a wrong answer, and named in words", async () => {
    const r = await openai({ status: 429 }).provider.complete(REQUEST);
    expect(r.error).toContain("429");
    expect(r.error).toContain("rate limited");
    expect(r.text).toBe("");
    expect(detectRefusal(r.text).refused).toBe(false);
  });
});

// ---- the property that matters more than any single case ----------------------------------------

interface FailureRow {
  readonly label: string;
  readonly make: (wire: Wire) => Adapter;
  readonly wire: Wire;
  /** A substring the error must contain. A status number alone is not a condition. */
  readonly names: string;
}

/** Failure modes that look the same in both wire formats. */
const SHARED: readonly { readonly label: string; readonly wire: Wire; readonly names: string }[] = [
  { label: "rate limit", wire: { status: 429 }, names: "rate limited" },
  { label: "server error", wire: { status: 500 }, names: "provider error" },
  { label: "gateway unavailable", wire: { status: 503 }, names: "provider error" },
  { label: "unauthorized", wire: { status: 401 }, names: "rejected credential" },
  { label: "forbidden", wire: { status: 403 }, names: "rejected credential" },
  { label: "model or endpoint gone", wire: { status: 404 }, names: "no such endpoint or model" },
  { label: "a 200 whose envelope is missing", wire: { body: { id: "x" } }, names: "malformed" },
  { label: "a 200 carrying a JSON scalar", wire: { body: 7 }, names: "malformed" },
  { label: "a 200 carrying a JSON string", wire: { body: "ok" }, names: "malformed" },
  { label: "a 200 carrying a literal null", wire: { body: null }, names: "malformed" },
  {
    label: "a body that is not JSON at all",
    wire: { jsonError: named("SyntaxError") },
    names: "transport failure",
  },
  {
    label: "the provider unreachable",
    wire: { transportError: named("TypeError") },
    names: "transport failure",
  },
  { label: "a timeout", wire: { transportError: named("AbortError") }, names: "timed out" },
  {
    label: "a transport that throws a non-Error",
    wire: { transportError: "boom" },
    names: "non-Error throw",
  },
];

const FAILURES: readonly FailureRow[] = [
  ...SHARED.flatMap((row) => [
    { ...row, label: `anthropic_api: ${row.label}`, make: anthropic },
    { ...row, label: `openai_compatible: ${row.label}`, make: openai },
  ]),
  // Format-specific: an envelope that is present and carries no answer at all.
  {
    label: "anthropic_api: an empty content array with no stop reason",
    make: anthropic,
    wire: { body: { model: "m", content: [] } },
    names: "empty response",
  },
  {
    label: "anthropic_api: a null content block",
    make: anthropic,
    wire: { body: { model: "m", content: [null] } },
    names: "empty response",
  },
  {
    label: "openai_compatible: an empty choices array",
    make: openai,
    wire: { body: { model: "m", choices: [] } },
    names: "empty response",
  },
  {
    label: "openai_compatible: a choice with neither content nor finish_reason",
    make: openai,
    wire: { body: { model: "m", choices: [{}] } },
    names: "empty response",
  },
];

describe("every BYOK failure mode is a return value with a reason on it", () => {
  it("returns rather than throws, for every scripted failure", async () => {
    const thrown: string[] = [];
    for (const row of FAILURES) {
      try {
        await row.make(row.wire).provider.complete(REQUEST);
      } catch (cause) {
        thrown.push(`${row.label}: ${String(cause)}`);
      }
    }
    expect(thrown).toEqual([]);
  });

  it("carries an error naming the condition, for every scripted failure", async () => {
    // A loop over a table rather than a test each, so a failure mode added without a reason is
    // caught by the table growing rather than by somebody remembering to write an assertion.
    const silent: string[] = [];
    for (const row of FAILURES) {
      const r = await row.make(row.wire).provider.complete(REQUEST);
      if (r.error === "" || !r.error.includes(row.names)) {
        silent.push(`${row.label}: error=${JSON.stringify(r.error)}, wanted "${row.names}"`);
      }
    }
    expect(silent).toEqual([]);
  });

  it("returns nothing a grader could score, for every scripted failure", async () => {
    // The one that would hurt. `packages/detect/src/metrics.ts` grades every record whose error is
    // empty, so a failure that came back empty-and-quiet would be scored as a wrong answer and a
    // provider outage would arrive in the report as a quality regression.
    const gradeable: string[] = [];
    for (const row of FAILURES) {
      const r = await row.make(row.wire).provider.complete(REQUEST);
      if (r.error === "" || r.text !== "" || detectRefusal(r.text).refused)
        gradeable.push(row.label);
    }
    expect(gradeable).toEqual([]);
  });

  it("records a latency figure even when the call never produced an answer", async () => {
    // A round that is timing out is a round whose latency is the story, and zeroing it would make
    // an outage look instantaneous.
    const unreachable = await anthropic({
      transportError: named("TypeError"),
    }).provider.complete(REQUEST);
    expect(unreachable.wallMs).toBeGreaterThan(0);
    const malformed = await openai({ body: { id: "x" } }).provider.complete(REQUEST);
    expect(malformed.apiMs).toBeGreaterThan(0);
    expect(malformed.wallMs).toBeGreaterThan(0);
  });

  it("keeps the table covering both adapters, so it cannot shrink quietly", () => {
    const anth = FAILURES.filter((r) => r.label.startsWith("anthropic_api")).length;
    const oai = FAILURES.filter((r) => r.label.startsWith("openai_compatible")).length;
    expect(anth).toBeGreaterThanOrEqual(SHARED.length);
    expect(oai).toBeGreaterThanOrEqual(SHARED.length);
    expect(new Set(FAILURES.map((r) => r.label)).size).toBe(FAILURES.length);
  });
});

// ---- a key never reaches an artifact ------------------------------------------------------------

/** A case that exists only in memory. Never written to disk, never part of the frozen corpus. */
const FIXTURE_CASE: EvalCase = {
  schemaVersion: 1,
  id: caseId("byok-fixture-001"),
  split: "canary",
  archetype: "constrained_categorical",
  title: "A fixture case used only to build a RunSnapshot in memory",
  promptId: promptId("terse-v1"),
  input: { system: "", user: "Answer HOLD or RETRY." },
  graders: [{ kind: "exact", expected: "HOLD" }],
  requiredSignals: ["quality"],
  detectionLimit: null,
  provenance: { kind: "original" },
  authoredAt: "2026-08-26",
  note: "Not a corpus case. It exists so a snapshot can be built without touching the corpus.",
};

describe("a key never reaches an artifact", () => {
  it("puts the OpenAI-compatible key in the authorization header and nowhere else", async () => {
    const a = openai({ body: OPENAI_OK });
    const r = await a.provider.complete(REQUEST);
    expect(a.sent[0]?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    // And not in the request body either, which is the other thing that gets recorded.
    expect(a.sent[0]?.body).not.toContain(FAKE_KEY);
  });

  it("keeps the key out of a RunSnapshot built from a real call, for both adapters", async () => {
    // A snapshot is the artifact that gets written to disk and committed, so this is the assertion
    // that actually protects a user. Two replicates so the records array is populated.
    for (const make of [anthropic, openai]) {
      const wire = make === anthropic ? ANTHROPIC_OK : OPENAI_OK;
      const a = make({ body: wire });
      const snapshot = await runCorpus(a.provider, [FIXTURE_CASE], "canary", {
        replicates: 2,
        concurrency: 1,
        now: () => new Date(0),
      });
      expect(snapshot.errorCount).toBe(0);
      expect(snapshot.records.length).toBe(2);
      expect(JSON.stringify(snapshot)).not.toContain(FAKE_KEY);
    }
  });

  it("keeps the key out of every failure response too, which is where a naive echo would show", async () => {
    const leaked: string[] = [];
    for (const row of FAILURES) {
      const r = await row.make(row.wire).provider.complete(REQUEST);
      if (JSON.stringify(r).includes(FAKE_KEY)) leaked.push(row.label);
    }
    expect(leaked).toEqual([]);
  });

  it("reports a harness cost of zero, which inverts the two cost bounds on this path", async () => {
    // Worth pinning because it is a trap for a reader. `summariseCost` calls the harness figure the
    // upper bound and the rate-card figure the lower one, and that ordering holds for the CLI
    // provider, which injects context. A BYOK call injects nothing, so its harness figure is 0 and
    // the computed figure is the WHOLE cost. On this path the rate-card number is the only real
    // one, which is why `docs/PROVIDERS.md` prices a live run from the rate card and labels it
    // COMPUTED rather than quoting a measured figure that does not exist.
    const a = anthropic({ body: ANTHROPIC_OK });
    const snapshot = await runCorpus(a.provider, [FIXTURE_CASE], "canary", {
      replicates: 1,
      concurrency: 1,
      now: () => new Date(0),
    });
    expect(snapshot.cost.harnessUsdPerCall).toBe(0);
    expect(snapshot.cost.rateUnknown).toBe(false);
    expect(snapshot.cost.bareApiUsdPerCall).toBeCloseTo(468e-6 * 2 + 41e-6 * 10, 9);
    expect(snapshot.cost.bareApiUsdPerCall).toBeGreaterThan(snapshot.cost.harnessUsdPerCall);
  });
});
