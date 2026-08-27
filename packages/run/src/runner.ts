// Executing a frozen corpus against a provider, and what a run records.
//
// REPLICATES ARE THE WHOLE POINT, and they are the thing an ordinary eval runner does not do. With
// one sample per case there is no way to separate drift from nondeterminism, because there is
// nothing to estimate the nondeterminism FROM. Every claim `packages/detect` makes rests on having
// several draws per case in each arm, and this is where they come from. A run with one replicate is
// accepted, because a user may want a smoke test, and it is marked so that the detector refuses to
// return a verdict from it rather than returning a confident wrong one.
//
// RAW OUTPUTS ARE KEPT, NOT SCORES. A snapshot stores the text the model produced. Storing only
// grades would make the archive answer exactly the questions someone thought of on the day it was
// collected, and this project needs the opposite: the A/A false-positive study, the injected-drift
// power curve and every future grader fix all re-read old outputs. It is also the rule that lets a
// parser bug be fixed retroactively for free, which the sibling learned the hard way when its
// substring matcher had been scoring refusals as confident answers for a whole release.
//
// THE CORPUS DIGEST TRAVELS WITH THE RUN. A snapshot records a hash over the rendered requests it
// actually issued. Comparing two runs of DIFFERENT corpora is not a drift measurement, it is a
// category error, and `packages/detect` refuses it by comparing digests rather than trusting a
// label. This is the same reasoning as keying the replay cache by content.
//
// ORDER IS DETERMINISTIC AND CONCURRENCY IS BOUNDED. Cases are issued in sorted id order, and the
// concurrency limit exists because a provider under a burst is a provider whose latency is
// measuring the burst. The sibling's note applies exactly: concurrency is for throughput only, and
// mixing a parallel run into a latency percentile is the most common way this kind of benchmark
// gets faked. Latency here is therefore reported with its collection concurrency attached.

import { readFileSync } from "node:fs";
import {
  type EvalCase,
  type Split,
  canonicalHash,
  getPrompt,
  promptHash,
} from "@model-regression-sentinel/spec";
import { type CostBounds, summariseCost } from "./cost.js";
import { type ProviderFingerprint, fingerprintOf } from "./fingerprint.js";
import { type ProviderMetadata, type TokenSource, metadataOf } from "./metadata.js";
import { requestKey } from "./providers/replay.js";
import { type CompletionRequest, type Provider, type ProviderResponse, threw } from "./types.js";

/**
 * The version of the adapters in THIS repository.
 *
 * Recorded on every run because a rewritten adapter can change what the numbers mean while the
 * provider holds perfectly still: a different flag set, a different field read for the served model,
 * a different place the token counts come from. A comparison that spans an adapter change is not
 * measuring only the provider, and this is what makes that visible.
 */
export // HAND-MAINTAINED AND ALREADY WRONG ONCE: this read "0.2.0" while packages/run/package.json read
// "0.1.0". The field exists so a comparison can say "the adapter changed between these two arms",
// and a constant that does not move when the adapter does means `diffMetadata` CERTIFIES stability
// across the one change that moved the numbers. Read from the manifest so it cannot drift again.
const ADAPTER_VERSION: string = (() => {
  try {
    return (
      (
        JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
          version?: string;
        }
      ).version ?? "unknown"
    );
  } catch {
    // A bundled consumer may not ship package.json beside the entry point. "unknown" is the honest
    // answer and, unlike a stale literal, it cannot be mistaken for a version that held still.
    return "unknown";
  }
})();

/** Turn a case plus its versioned prompt into the exact request that will be issued. */
export function renderRequest(evalCase: EvalCase): CompletionRequest {
  const prompt = getPrompt(evalCase.promptId);
  const base: CompletionRequest = {
    // The case may override the registry system prompt with its own; in this corpus it never does,
    // and the empty string means "use the prompt version's".
    system: evalCase.input.system === "" ? prompt.system : evalCase.input.system,
    user: evalCase.input.user,
  };
  return {
    ...base,
    ...(evalCase.input.jsonSchema === undefined ? {} : { jsonSchema: evalCase.input.jsonSchema }),
    ...(evalCase.input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: evalCase.input.maxOutputTokens }),
  };
}

/** One replicate. The raw output lives in `response.text` and nothing else is derived here. */
export interface RunRecord {
  readonly caseId: string;
  readonly replicate: number;
  readonly promptId: string;
  readonly promptSha256: string;
  readonly requestSha256: string;
  readonly response: ProviderResponse;
}

export interface RunSnapshot {
  readonly schemaVersion: 1;
  /** A human label for this arm: "baseline", "candidate", "aa-control". Never load-bearing. */
  readonly label: string;
  readonly capturedAt: string;
  readonly provider: string;
  /** What was ASKED for. An alias stays an alias. */
  readonly requestedModel: string;
  /**
   * Which splits were collected. AUTHORITATIVE, and an array because a run over more than one split
   * has no single honest answer.
   *
   * `run-study.mjs` used to stamp the literal string "extended" on any multi-split run, so a fresh
   * 34-case baseline claimed on disk to be the 16-case extended split. Nothing computed from it -
   * `caseIds` and `corpusDigest` carry the real provenance - which is exactly why it went unnoticed:
   * a provenance field that no code reads is a field only a human is misled by.
   */
  readonly splits: readonly Split[];
  /**
   * OPTIONAL AND DEPRECATED. Present on runs collected before `splits` existed, including the four
   * in `results/runs/`. `readSnapshot` normalises it into `splits`; nothing should read it directly.
   */
  readonly split?: Split;
  readonly replicates: number;
  readonly concurrency: number;
  readonly caseIds: readonly string[];
  /** Hash over the rendered requests. Two runs with different digests are not comparable. */
  readonly corpusDigest: string;
  /** Null when every call failed, so no identity was ever observed. */
  readonly fingerprint: ProviderFingerprint | null;
  /**
   * The fuller provider metadata: endpoint, adapter, harness version, token source.
   *
   * OPTIONAL, and that is load-bearing rather than lazy. Four real runs were recorded in v0.1 before
   * this existed, they cost real money, and they are the project's only measured evidence. A
   * required field would make them unreadable and unrecollectable. Absent metadata is read as
   * `unknown` throughout, which is the true statement about those files and is exactly why
   * `MetaValue` distinguishes unknown from not-exposed.
   */
  readonly metadata?: ProviderMetadata;
  readonly records: readonly RunRecord[];
  readonly errorCount: number;
  readonly cost: CostBounds;
}

export interface RunOptions {
  readonly replicates: number;
  /** Where the token counts come from. Recorded so a comparison cannot cross that boundary blind. */
  readonly tokenSource?: TokenSource;
  readonly endpoint?: string;
  readonly harnessVersion?: string;
  readonly concurrency?: number;
  readonly label?: string;
  /** Injected so a snapshot's timestamp is data rather than a hidden clock read. */
  readonly now?: () => Date;
  readonly onProgress?: (done: number, total: number) => void;
}

/** The digest that decides whether two runs are comparable at all. */
export function corpusDigestOf(cases: readonly EvalCase[]): string {
  return canonicalHash(
    [...cases]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => ({ id: String(c.id), request: requestKey(renderRequest(c)) })),
  );
}

export async function runCorpus(
  provider: Provider,
  cases: readonly EvalCase[],
  splits: Split | readonly Split[],
  options: RunOptions,
): Promise<RunSnapshot> {
  const splitList = typeof splits === "string" ? [splits] : [...splits];
  const replicates = Math.max(1, Math.floor(options.replicates));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const now = options.now ?? (() => new Date());

  const ordered = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Every unit of work, enumerated up front. Building the list first rather than nesting loops keeps
  // the concurrency limit honest: a worker pool over a flat queue cannot accidentally run a whole
  // case's replicates in parallel while claiming a limit of four.
  const units: { readonly evalCase: EvalCase; readonly replicate: number }[] = [];
  for (const evalCase of ordered) {
    for (let r = 0; r < replicates; r += 1) units.push({ evalCase, replicate: r });
  }

  const records: RunRecord[] = new Array(units.length);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= units.length) return;
      const unit = units[index] as { evalCase: EvalCase; replicate: number };
      const prompt = getPrompt(unit.evalCase.promptId);
      const request = renderRequest(unit.evalCase);
      // A THROWN PROVIDER IS ONE FAILED CALL, NOT A LOST RUN.
      //
      // `Promise.all` over the workers means one rejection discards every record collected so far,
      // including hundreds of successful calls already paid for. That is a catastrophic response to
      // a condition every provider produces routinely - a socket reset, a DNS blip, a JSON body that
      // did not parse - and `ReplayProvider` rejects deliberately, so the hazard was live in-repo.
      //
      // An error is already a first-class outcome here: `ProviderResponse.error` is how a failed
      // call is recorded, `extractMetrics` drops those from every sample and counts them
      // separately, and a round where ALL of them failed is caught by `observedNothing`. A throw is
      // the same event arriving through a different door, so it is converted rather than propagated.
      let response: ProviderResponse;
      try {
        response = await provider.complete(request);
      } catch (cause) {
        response = threw(
          cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
        );
      }
      records[index] = {
        caseId: String(unit.evalCase.id),
        replicate: unit.replicate,
        promptId: String(unit.evalCase.promptId),
        promptSha256: promptHash(prompt),
        requestSha256: requestKey(request),
        response,
      };
      done += 1;
      options.onProgress?.(done, units.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, () => worker()));

  const ok = records.filter((r) => r.response.error === "");
  const first = ok[0];

  return {
    schemaVersion: 1,
    label: options.label ?? "run",
    capturedAt: now().toISOString(),
    provider: provider.name,
    requestedModel: provider.model,
    splits: splitList,
    replicates,
    concurrency,
    caseIds: ordered.map((c) => String(c.id)),
    corpusDigest: corpusDigestOf(ordered),
    fingerprint:
      first === undefined ? null : fingerprintOf(provider.name, provider.model, first.response),
    ...(first === undefined
      ? {}
      : {
          metadata: metadataOf({
            provider: provider.name,
            requestedModel: provider.model,
            response: first.response,
            tokenSource: provider.tokenSource ?? options.tokenSource ?? "none",
            observedAt: now().toISOString(),
            ...((provider.endpoint ?? options.endpoint) === undefined
              ? {}
              : { endpoint: (provider.endpoint ?? options.endpoint) as string }),
            ...((provider.harnessVersion ?? options.harnessVersion) === undefined
              ? {}
              : { harnessVersion: (provider.harnessVersion ?? options.harnessVersion) as string }),
            adapterVersion: ADAPTER_VERSION,
          }),
        }),
    records,
    errorCount: records.length - ok.length,
    cost: summariseCost(
      first?.response.modelServed ?? provider.model,
      ok.map((r) => ({
        inputTokens: r.response.inputTokens,
        outputTokens: r.response.outputTokens,
        cacheReadTokens: r.response.cacheReadTokens,
        cacheCreateTokens: r.response.cacheCreateTokens,
        harnessCostUsd: r.response.harnessCostUsd,
      })),
    ),
  };
}

/**
 * Fingerprints observed across a whole run, not just the first.
 *
 * A provider can serve two identities inside one run: a fallback fires, or a request lands in a
 * region mid-rollout. That is a real and important observation and reporting only the first
 * response's identity would erase it.
 */
export function observedFingerprints(
  snapshot: RunSnapshot,
  provider: string,
  requestedModel: string,
): readonly ProviderFingerprint[] {
  const seen = new Map<string, ProviderFingerprint>();
  for (const r of snapshot.records) {
    if (r.response.error !== "") continue;
    const f = fingerprintOf(provider, requestedModel, r.response);
    if (!seen.has(f.sha256)) seen.set(f.sha256, f);
  }
  return [...seen.values()];
}
