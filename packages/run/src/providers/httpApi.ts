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
// key. `packages/run/test/secrets.test.ts` scans every generated artifact for anything key-shaped.
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
      if (!res.ok) return { error: `HTTP ${res.status}`, wallMs: apiMs };
      return { doc: await res.json(), apiMs };
    } catch (cause) {
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      return { error: cause instanceof Error ? cause.name : String(cause), wallMs };
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
interface AnthropicDoc {
  readonly model?: string;
  readonly stop_reason?: string;
  readonly usage?: AnthropicUsage;
  readonly content?: readonly { readonly text?: string }[];
}

/** The Anthropic Messages API directly. No harness tokens, so its cost IS the deployed cost. */
export class AnthropicApiProvider extends HttpProvider {
  readonly name: string;
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

    const doc = out.doc as AnthropicDoc;
    const usage = doc.usage ?? {};
    const text = (doc.content ?? []).map((b) => b.text ?? "").join("");
    return {
      text,
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
      stopReason: String(doc.stop_reason ?? ""),
      error: "",
    };
  }
}

interface OpenAiDoc {
  readonly model?: string;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly choices?: readonly {
    readonly finish_reason?: string;
    readonly message?: { readonly content?: string };
  }[];
}

/** Any endpoint speaking `/v1/chat/completions`: OpenAI, vLLM, Together, OpenRouter, Ollama. */
export class OpenAiCompatibleProvider extends HttpProvider {
  readonly name: string;
  private readonly baseUrl: string;

  constructor(model: string, options: HttpOptions = {}) {
    super(model, "OPENAI_API_KEY", options);
    this.name = `openai_compatible:${model}`;
    this.baseUrl = (
      options.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
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

    const doc = out.doc as OpenAiDoc;
    const usage = doc.usage ?? {};
    const choice = (doc.choices ?? [])[0];
    return {
      text: String(choice?.message?.content ?? ""),
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
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
      stopReason: String(choice?.finish_reason ?? ""),
      error: "",
    };
  }
}
