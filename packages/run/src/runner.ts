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

import {
  type EvalCase,
  type Split,
  canonicalHash,
  getPrompt,
  promptHash,
} from "@model-regression-sentinel/spec";
import { type CostBounds, summariseCost } from "./cost.js";
import { type ProviderFingerprint, fingerprintOf } from "./fingerprint.js";
import { requestKey } from "./providers/replay.js";
import type { CompletionRequest, Provider, ProviderResponse } from "./types.js";

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
  readonly split: Split;
  readonly replicates: number;
  readonly concurrency: number;
  readonly caseIds: readonly string[];
  /** Hash over the rendered requests. Two runs with different digests are not comparable. */
  readonly corpusDigest: string;
  /** Null when every call failed, so no identity was ever observed. */
  readonly fingerprint: ProviderFingerprint | null;
  readonly records: readonly RunRecord[];
  readonly errorCount: number;
  readonly cost: CostBounds;
}

export interface RunOptions {
  readonly replicates: number;
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
  split: Split,
  options: RunOptions,
): Promise<RunSnapshot> {
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
      const response = await provider.complete(request);
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
    split,
    replicates,
    concurrency,
    caseIds: ordered.map((c) => String(c.id)),
    corpusDigest: corpusDigestOf(ordered),
    fingerprint:
      first === undefined ? null : fingerprintOf(provider.name, provider.model, first.response),
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
