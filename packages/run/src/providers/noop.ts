// The provider that runs nothing and says so.
//
// WHY A NULL PROVIDER IS A REAL DELIVERABLE, in the sibling's words and for the sibling's reason:
// CI has no credentials, and a comparison that silently vanishes when credentials are absent is
// worse than one that never existed, because a reader sees a table with a missing row and assumes
// it was not applicable. Every call here returns an error carrying the REASON, the runner counts
// those as errors rather than dropping them, and the report prints SKIPPED with the reason where
// the numbers would be.
//
// For a drift sentinel there is a second reason the sibling did not need. A watcher that cannot
// reach the provider must report "I could not look", never "nothing changed". Those are opposite
// claims and only one of them is true, and a monitoring tool that confuses them is the reason
// people stop trusting monitoring tools.

import {
  type Availability,
  type CompletionRequest,
  type Provider,
  type ProviderResponse,
  skipped,
} from "../types.js";

export class NoopProvider implements Provider {
  readonly name = "noop";
  readonly model = "none";
  readonly endpoint = "none";
  readonly tokenSource = "none" as const;
  private readonly reason: string;

  constructor(reason = "no credentials available in this environment") {
    this.reason = reason;
  }

  available(): Availability {
    return { ok: false, reason: this.reason };
  }

  complete(_request: CompletionRequest): Promise<ProviderResponse> {
    return Promise.resolve(skipped(this.reason));
  }
}
