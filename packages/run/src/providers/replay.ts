// Replay a recorded run. The provider that makes this project's own calibration possible.
//
// THE JOIN IS BY CONTENT, NOT BY POSITION. A recorded response is keyed on the sha256 of the
// rendered request, so a fixture cannot be replayed against the wrong case by reordering, and a
// PROMPT CHANGE INVALIDATES THE CACHE LOUDLY instead of silently returning a stale answer to a
// different question. That property is not a convenience here, it is the difference between a
// drift verdict and a lie: if a prompt edit could quietly reuse old outputs, every number this tool
// produced afterwards would be comparing two different experiments.
//
// A MISS IS AN ERROR, NOT A CALL. This provider never falls back to the network. A test that
// accidentally reaches a real model is a test that costs money and stops being deterministic, so a
// miss returns `error: "cache miss"` and the grader counts it as wrong.
//
// WHY IT IS MORE THAN A TEST DOUBLE. The A/A false-positive study and the injected-drift power
// curve both re-grade recorded outputs thousands of times. Without a replay provider the detector
// could only ever be calibrated with a credit card, which in practice means never, which in
// practice means shipping a detector whose false-positive rate nobody has measured.
//
// PERTURBATION IS FIRST-CLASS AND IS LABELLED. `perturb` lets a caller inject a KNOWN effect into
// recorded outputs, which is how the power curve is produced. It is on the provider rather than
// hidden in a test helper so that the one thing that must never happen - a perturbed run being
// mistaken for a real one - is visible: `name` carries the perturbation, and it reaches the
// snapshot and the report.

import { bytesHash } from "@model-regression-sentinel/spec";
import {
  type Availability,
  type CompletionRequest,
  type Provider,
  type ProviderResponse,
  skipped,
} from "../types.js";

/** The stable key for a request. Changing any byte of the prompt changes it. */
export const requestKey = (request: CompletionRequest): string =>
  bytesHash(
    JSON.stringify({
      system: request.system,
      user: request.user,
      jsonSchema: request.jsonSchema ?? null,
      maxOutputTokens: request.maxOutputTokens ?? null,
    }),
  );

/**
 * A deterministic transform applied to a replayed response.
 *
 * `draw` is a uniform in [0, 1) supplied by the caller's seeded generator, so a power curve is
 * reproducible from a seed and a perturbation never silently uses Math.random.
 */
export type Perturbation = (
  response: ProviderResponse,
  draw: number,
  request: CompletionRequest,
) => ProviderResponse;

export interface ReplayOptions {
  /** Applied to every hit. Named in `name`, so a perturbed run cannot pass as a real one. */
  readonly perturb?: Perturbation;
  readonly perturbLabel?: string;
  /** Seeded uniforms. Required when `perturb` is set. */
  readonly draw?: () => number;
}

export class ReplayProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly endpoint = "replay";
  /** `replayed`, never the original source. A replayed count is a recording, not a fresh reading. */
  readonly tokenSource = "replayed" as const;
  private readonly table: ReadonlyMap<string, readonly ProviderResponse[]>;
  private readonly cursor = new Map<string, number>();
  private readonly options: ReplayOptions;
  private misses = 0;

  constructor(
    table: ReadonlyMap<string, readonly ProviderResponse[]>,
    label: string,
    model: string,
    options: ReplayOptions = {},
  ) {
    const suffix = options.perturbLabel === undefined ? "" : `+${options.perturbLabel}`;
    this.name = `replay:${label}${suffix}`;
    this.model = model;
    this.table = table;
    this.options = options;
  }

  available(): Availability {
    return { ok: true, reason: "" };
  }

  missCount(): number {
    return this.misses;
  }

  /**
   * Replicates are served in recorded order and then wrap.
   *
   * Wrapping rather than erroring because a calibration study asks for more draws than were
   * recorded on purpose. Wrapping reuses real outputs rather than inventing them, and the study
   * reports how many distinct outputs backed it so nobody reads a resampled curve as new evidence.
   */
  complete(request: CompletionRequest): Promise<ProviderResponse> {
    const key = requestKey(request);
    const bucket = this.table.get(key);
    if (bucket === undefined || bucket.length === 0) {
      this.misses += 1;
      return Promise.resolve({ ...skipped("cache miss"), error: "cache miss" });
    }
    const at = this.cursor.get(key) ?? 0;
    this.cursor.set(key, at + 1);
    const found = bucket[at % bucket.length] as ProviderResponse;

    const { perturb, draw } = this.options;
    if (perturb === undefined) return Promise.resolve(found);
    if (draw === undefined) {
      // Rejected rather than thrown. `complete` is declared to return a Promise, and a synchronous
      // throw from a function with that signature escapes a caller's `.catch`, which is a worse
      // failure than the misconfiguration it is reporting.
      return Promise.reject(
        new Error(
          "a perturbed ReplayProvider needs a seeded draw(); Math.random is not allowed here",
        ),
      );
    }
    return Promise.resolve(perturb(found, draw(), request));
  }
}

/** Build a replay table from records, grouping every replicate of a request under its key. */
export function replayTable(
  records: readonly { readonly requestSha256: string; readonly response: ProviderResponse }[],
): ReadonlyMap<string, readonly ProviderResponse[]> {
  const table = new Map<string, ProviderResponse[]>();
  for (const r of records) {
    const bucket = table.get(r.requestSha256);
    if (bucket === undefined) table.set(r.requestSha256, [r.response]);
    else bucket.push(r.response);
  }
  return table;
}
