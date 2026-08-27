// BYOK providers over plain HTTP. Two wire formats, one fetch, no new dependency.
//
// WHY `fetch` AND NOT AN SDK. Every package here declares zero runtime dependencies, and that is a
// product claim rather than an accident: the watcher runs on a schedule on somebody's build box and
// a drift sentinel that drags two vendor SDKs into that process to make two POST requests has
// already lost the argument. Node 20 ships `fetch`. The request bodies are small and stable.
//
// THE KEY IS NEVER STORED, LOGGED OR SERIALIZED. It is read from the environment AT CALL TIME and
// never enters a `ProviderResponse`, a snapshot or a report. The environment variable NAME is a
// constructor parameter rather than a constant, which makes the absent-key path testable without a
// key. `packages/run/test/byok.test.ts` drives both adapters with a fake key and asserts it appears
// nowhere in the response or in a `RunSnapshot` built from one, and
// `packages/spec/test/houseStyle.test.ts` scans every committed file for anything key-shaped.
//
// BOTH PROVIDERS ARE SHIPPED AND UNRUN IN THIS PASS, and that is stated wherever their numbers
// would appear rather than left for a reader to discover. There is no API key in the environment
// that produced this repository, so they are written, typechecked and exercised against a fake
// transport in tests, and no number in this project came from either. The sibling
// `toolcall-risk-classifier` grades its equivalents SKIPPED for exactly this reason and this
// project copies that.
//
// AN HTTPS REFUSAL, NOT A WARNING. A drift sentinel authenticates to a provider on a schedule
// forever. Sending a bearer token to a plaintext endpoint once is enough, so a non-https base URL
// is refused in `available()` rather than logged.
//
// A BODY THAT IS NOT AN ANSWER IS AN ERROR, NOT AN EMPTY STRING. This is the guard that earns its
// place. HTTP 200 with a body missing its `content` or `choices` envelope used to fall through to
// `text: ""` with `error: ""`, and `packages/detect/src/metrics.ts` grades every record whose error
// is empty. A malformed body would therefore have been scored as a wrong answer, which turns a
// provider incident into a quality regression: the exact confusion this project exists to prevent.
// So the envelope is checked, and a reply with no text AND no stop reason is refused too. An empty
// reply WITH a stop reason is left alone, because a truncation at max_tokens is the provider
// telling us what happened and dropping it would hide a real behavioural change.
//
// WHAT THIS IS NOT. It is not a retry layer, a rate limiter or a streaming client. One request, one
// answer, every failure returned rather than thrown, and the caller decides what to do about it.

import type { JsonValue } from "@model-regression-sentinel/spec";
import {
  type Availability,
  type CompletionRequest,
  type Provider,
  type ProviderResponse,
  skipped,
} from "../types.js";

const TIMEOUT_MS = 120_000;

export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface HttpOptions {
  readonly apiKeyEnv?: string;
  readonly baseUrl?: string;
  readonly fetcher?: Fetcher;
  readonly timeoutMs?: number;
}

/**
 * A status turned into the condition it names.
 *
 * `HTTP 429` alone is a number a reader has to go and look up, and these are different incidents
 * with different owners: a rate limit is capacity, a rejected credential is configuration, a 5xx
 * belongs to the provider and a 404 is usually a model id that moved. None of them is a quality
 * regression, and this string is the first thing a person reads.
 */
function httpCondition(status: number): string {
  if (status === 429) return "rate limited";
  if (status === 401 || status === 403) return "rejected credential";
  if (status === 404) return "no such endpoint or model";
  if (status >= 500) return "provider error";
  return "unexpected status";
}

abstract class HttpProvider implements Provider {
  abstract readonly name: string;
  readonly model: string;
  protected readonly apiKeyEnv: string;
  protected readonly fetcher: Fetcher;
  protected readonly timeoutMs: number;

  protected constructor(model: string, defaultKeyEnv: string, options: HttpOptions) {
    this.model = model;
    this.apiKeyEnv = options.apiKeyEnv ?? defaultKeyEnv;
    this.fetcher = options.fetcher ?? (globalThis.fetch as unknown as Fetcher);
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  available(): Availability {
    const key = process.env[this.apiKeyEnv];
    if (key === undefined || key === "") {
      return { ok: false, reason: `${this.apiKeyEnv} is not set` };
    }
    return { ok: true, reason: "" };
  }

  abstract complete(request: CompletionRequest): Promise<ProviderResponse>;

  /**
   * A call that completed on the wire and did not come back with a usable answer.
   *
   * The latency is kept, because the round trip really happened and a run that is timing out is a
   * run whose latency is the story. Everything else is zeroed and the reason is carried.
   */
  protected noAnswer(apiMs: number, reason: string): ProviderResponse {
    return { ...skipped("no usable answer"), apiMs, clientMs: apiMs, wallMs: apiMs, error: reason };
  }

  protected async post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ doc: unknown; apiMs: number } | { error: string; wallMs: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = process.hrtime.bigint();
    try {
      const res = await this.fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const apiMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (!res.ok) {
        return { error: `HTTP ${res.status}: ${httpCondition(res.status)}`, wallMs: apiMs };
      }
      return { doc: await res.json(), apiMs };
    } catch (cause) {
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      // The error's NAME and nothing else. A message is text this process did not author, and this
      // catch is the one place a credential could plausibly ride back into an artifact by way of a
      // stringified request. The timeout sentence is the exception and it is built from this
      // instance's own configured value, so it still carries no foreign bytes.
      const name = cause instanceof Error ? cause.name : "non-Error throw";
      return {
        error:
          name === "AbortError"
            ? `timed out after ${this.timeoutMs}ms`
            : `transport failure: ${name}`,
        wallMs,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}
/** Every field optional and every block nullable, because this is decoded JSON and not a promise. */
interface AnthropicDoc {
  readonly model?: string;
  readonly stop_reason?: string;
  readonly usage?: AnthropicUsage;
  readonly content?: readonly ({ readonly text?: string } | null)[];
}

/** The Anthropic Messages API directly. No harness tokens, so its cost IS the deployed cost. */
export class AnthropicApiProvider extends HttpProvider {
  readonly name: string;
  readonly endpoint = "https://api.anthropic.com";
  readonly tokenSource = "anthropic_usage" as const;
  static readonly VERSION = "2023-06-01";

  constructor(model: string, options: HttpOptions = {}) {
    super(model, "ANTHROPIC_API_KEY", options);
    this.name = `anthropic_api:${model}`;
  }

  async complete(request: CompletionRequest): Promise<ProviderResponse> {
    const gate = this.available();
    if (!gate.ok) return skipped(gate.reason);

    const body: Record<string, JsonValue> = {
      model: this.model,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      max_tokens: request.maxOutputTokens ?? 1024,
    };
    const out = await this.post(
      "https://api.anthropic.com/v1/messages",
      {
        // Read at call time. Never held on the instance, never serialized.
        "x-api-key": process.env[this.apiKeyEnv] as string,
        "anthropic-version": AnthropicApiProvider.VERSION,
      },
      body,
    );
    if ("error" in out)
      return { ...skipped("request failed"), wallMs: out.wallMs, error: out.error };

    // `?? {}` rather than a cast alone, so a JSON scalar or a literal `null` body reaches the
    // envelope check instead of throwing on a property read.
    const doc = (out.doc ?? {}) as AnthropicDoc;
    const blocks = Array.isArray(doc.content) ? doc.content : null;
    if (blocks === null) return this.noAnswer(out.apiMs, "malformed response: no content array");

    const text = blocks.map((b) => b?.text ?? "").join("");
    const stopReason = String(doc.stop_reason ?? "");
    if (text === "" && stopReason === "") {
      return this.noAnswer(out.apiMs, "empty response with no stop reason");
    }

    const usage = doc.usage ?? {};
    return {
      text,
      // Zero when the provider did not report a count, and the two are NOT distinguishable in this
      // type. See the note on `ProviderResponse` in ../types.ts.
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
      apiMs: out.apiMs,
      clientMs: out.apiMs,
      wallMs: out.apiMs,
      // Zero, and that is correct rather than missing: this path pays no harness overhead, so the
      // measured and computed cost bounds coincide and the report says so.
      harnessCostUsd: 0,
      modelServed: String(doc.model ?? ""),
      canonicalModel: "",
      contextWindow: null,
      maxOutputTokens: null,
      serviceTier: "",
      costBasis: "",
      stopReason,
      error: "",
    };
  }
}

interface OpenAiChoice {
  readonly finish_reason?: string;
  readonly message?: { readonly content?: string } | null;
}
interface OpenAiDoc {
  readonly model?: string;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly choices?: readonly (OpenAiChoice | null)[];
}

/** Any endpoint speaking `/v1/chat/completions`: OpenAI, vLLM, Together, OpenRouter, Ollama. */
export class OpenAiCompatibleProvider extends HttpProvider {
  readonly name: string;
  readonly tokenSource = "openai_usage" as const;
  /** The ORIGIN only. A base URL can carry a query string and therefore a credential. */
  readonly endpoint: string;
  private readonly baseUrl: string;

  constructor(model: string, options: HttpOptions = {}) {
    super(model, "OPENAI_API_KEY", options);
    this.name = `openai_compatible:${model}`;
    this.baseUrl = (
      options.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    this.endpoint = originOf(this.baseUrl);
  }

  override available(): Availability {
    const base = super.available();
    if (!base.ok) return base;
    if (!this.baseUrl.startsWith("https://")) {
      return { ok: false, reason: `refusing a non-https endpoint: ${this.baseUrl}` };
    }
    return { ok: true, reason: "" };
  }

  async complete(request: CompletionRequest): Promise<ProviderResponse> {
    const gate = this.available();
    if (!gate.ok) return skipped(gate.reason);

    const body: Record<string, JsonValue> = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      max_tokens: request.maxOutputTokens ?? 1024,
    };
    if (request.jsonSchema !== undefined) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "case", strict: true, schema: request.jsonSchema },
      };
    }
    const out = await this.post(
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${process.env[this.apiKeyEnv] as string}` },
      body,
    );
    if ("error" in out)
      return { ...skipped("request failed"), wallMs: out.wallMs, error: out.error };

    const doc = (out.doc ?? {}) as OpenAiDoc;
    const choices = Array.isArray(doc.choices) ? doc.choices : null;
    if (choices === null) return this.noAnswer(out.apiMs, "malformed response: no choices array");

    const choice = choices[0];
    const text = String(choice?.message?.content ?? "");
    const stopReason = String(choice?.finish_reason ?? "");
    if (text === "" && stopReason === "") {
      return this.noAnswer(out.apiMs, "empty response with no stop reason");
    }

    const usage = doc.usage ?? {};
    return {
      text,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      // Zero because this wire format has no cache accounting to read, NOT because the provider
      // reported no cache activity. The two are indistinguishable here and the doc says so.
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      apiMs: out.apiMs,
      clientMs: out.apiMs,
      wallMs: out.apiMs,
      harnessCostUsd: 0,
      modelServed: String(doc.model ?? ""),
      canonicalModel: "",
      contextWindow: null,
      maxOutputTokens: null,
      serviceTier: "",
      costBasis: "",
      stopReason,
      error: "",
    };
  }
}

/**
 * The origin of a base URL, or a marker when it cannot be parsed.
 *
 * Only the origin is recorded. A base URL can legitimately carry a query string, and a query string
 * is one of the places people put credentials, so storing the whole thing in an artifact that gets
 * committed and diffed would be a way to leak one by accident.
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unparseable";
  }
}
