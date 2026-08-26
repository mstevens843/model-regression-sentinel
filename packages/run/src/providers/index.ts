// The provider registry.
//
// Hand-curated rather than a directory scan, so that adding a provider is a decision with a name on
// it. Every entry states its credential and whether this project has ever actually run it, and that
// second column is the one a reader should look at first.

export { ClaudeCliProvider } from "./claudeCli.js";
export type { ClaudeCliOptions, ExecResult } from "./claudeCli.js";
export { AnthropicApiProvider, OpenAiCompatibleProvider } from "./httpApi.js";
export type { Fetcher } from "./httpApi.js";
export { ReplayProvider, replayTable, requestKey } from "./replay.js";
export type { Perturbation, ReplayOptions } from "./replay.js";
export { NoopProvider } from "./noop.js";

/** What exists, what it needs, and whether a number in this repository ever came from it. */
export interface ProviderEntry {
  readonly id: string;
  readonly credential: string;
  readonly everRun: boolean;
  readonly note: string;
}

export const PROVIDER_REGISTRY: readonly ProviderEntry[] = [
  {
    id: "claude_cli",
    credential: "an authenticated local `claude` CLI",
    everRun: true,
    note: "The only provider actually run. Every measured number in this repository came from it. It injects harness context, so its cost is reported as an upper bound beside a computed bare-API lower bound.",
  },
  {
    id: "anthropic_api",
    credential: "ANTHROPIC_API_KEY",
    everRun: false,
    note: "Shipped and UNRUN. There is no key in the environment that produced this repository. Its cost would be the deployed cost, with no harness overhead to subtract.",
  },
  {
    id: "openai_compatible",
    credential: "OPENAI_API_KEY plus OPENAI_BASE_URL",
    everRun: false,
    note: "Shipped and UNRUN. Speaks /v1/chat/completions, so it also reaches vLLM, Together, OpenRouter and Ollama. Proves the seam is not Anthropic-shaped; proves nothing about behavior against those endpoints.",
  },
  {
    id: "replay",
    credential: "none",
    everRun: true,
    note: "Replays recorded outputs, keyed by request hash. What the tests and both calibration studies use, so neither ever spends money.",
  },
  {
    id: "noop",
    credential: "none",
    everRun: true,
    note: "Returns SKIPPED with a reason for every call. What CI uses when no credential exists, so an absent measurement is visible rather than missing.",
  },
];
