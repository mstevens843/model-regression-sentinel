# Providers: what was run, what was not, and what each one costs you

<!-- GENERATED:provider-table -->
**6 adapters behind one seam, 4 of them ever run here.** The column that matters is the third one.

| adapter | credential | ever run here | notes |
|---|---|---|---|
| `claude_cli` | an authenticated local `claude` CLI | **yes** | Every number in results/runs/ and results/runs-v2/ came from it, and it is the only provider any published claim rests on. It injects harness context, so its cost is reported as an upper bound beside a computed bare-API lower bound. |
| `codex_cli` | a local Codex plan session in CODEX_HOME, NOT an OpenAI API key | **yes** | A SECOND VENDOR, reachable without a credential, the same way claude_cli is. It discloses real token usage and NOTHING ELSE: no served model identity for any alias, no server-reported latency, no cost, no stop reason. Those are recorded as not_exposed rather than guessed, so `latencyMs` from a codex_cli run is a constant zero - a metric this adapter cannot produce, not a provider that answers instantly. It does NOT close the BYOK gap: the two HTTP adapters below remain unrun. |
| `anthropic_api` | ANTHROPIC_API_KEY | **no** | Shipped and UNRUN. There is no key in the environment that produced this repository. Its cost would be the deployed cost, with no harness overhead to subtract. |
| `openai_compatible` | OPENAI_API_KEY plus OPENAI_BASE_URL | **no** | Shipped and UNRUN. Speaks /v1/chat/completions, so it also reaches vLLM, Together, OpenRouter and Ollama. Proves the seam is not Anthropic-shaped; proves nothing about behavior against those endpoints. |
| `replay` | none | **yes** | Replays recorded outputs, keyed by request hash. What the tests and both calibration studies use, so neither ever spends money. |
| `noop` | none | **yes** | Returns SKIPPED with a reason for every call. What CI uses when no credential exists, so an absent measurement is visible rather than missing. |
<!-- /GENERATED -->

**There is no API key in the environment that produced this repository.** The two HTTP adapters are
written, typechecked and exercised against a fake transport in
`packages/run/test/byok.test.ts`, and nothing else. That is the same state
the sibling `toolcall-risk-classifier` reports for its equivalents, and for the same reason.

## The credential rules, and why each one exists

- **Read at call time, never stored.** The key never lands on the instance, in a `ProviderResponse`,
  in a snapshot or in a report. Tests drive both adapters with a fake key and assert it appears
  nowhere in the response, nowhere in a `RunSnapshot` built from one, and nowhere in any of the
  thirty-odd failure responses either, which is where a naive implementation would echo the
  rejected header back.
- **The environment variable NAME is a constructor parameter.** That makes the absent-key path
  testable without a key, which is the only way that path ever gets tested.
- **Absence is a return value.** `available()` returns `{ok, reason}` and an unavailable provider
  answers every call with `SKIPPED: <reason>`. A comparison that quietly vanishes when credentials
  are missing is worse than one that never existed, because a reader sees a gap in a table and
  assumes it did not apply.
- **A non-https endpoint is refused, not warned about.** A drift sentinel authenticates on a
  schedule forever. Sending a bearer token to a plaintext endpoint once is enough.
- **`packages/spec/test/houseStyle.test.ts` scans the whole repository** for anything key-shaped.

## What the `claude` CLI adapter costs, measured

The CLI is a coding agent, not a bare API, and it injects its own context. Measured on this machine:

| invocation | cache-creation tokens | cost |
|---|---|---|
| `claude -p` with no flags | 112,748 | **$0.4510** |
| plus `--tools "" --strict-mcp-config --system-prompt`, cold cache | 3,301 | $0.0132 |
| the same, warm cache | 0 | **$0.00084** |

A factor of roughly 500 on an identical question. A canary set is paid for on every tick forever, so
those flags are the difference between a watcher that runs and one that gets switched off. Every one
of them is asserted by a test, because losing one silently would not break anything visible.

**Cost is therefore reported twice and never merged**: a harness-measured upper bound that includes
the injected tokens, and a bare-API lower bound computed from a dated rate card and labelled
computed-rather-than-measured. And cost is not a gating metric, because a vendor repricing moves it
for every case at once and that is not drift.

## The three latency figures

`apiMs` is what the server reports and is a **lower** bound on a deployed call. `wallMs` includes
subprocess startup and is an **upper** bound. `clientMs` sits between them. All three are recorded
and all three are printed. **The true deployed latency is between them and this project did not
measure it**, because there is no API key. The report says that sentence rather than picking
whichever number flatters the argument. Only `apiMs` is compared, because it is the only one that is
a property of the provider rather than of this laptop.

## Alias resolution, and why it is not uniform

| requested | served identity | canonical | context window | max output |
|---|---|---|---|---|
| `sonnet` | `claude-sonnet-5` | `claude-sonnet-5` | 1,000,000 | 64,000 |
| `haiku` | **`claude-haiku-4-5-20251001`** | `claude-haiku-4-5` | 200,000 | 32,000 |

The dated snapshot appears in the `modelUsage` KEY, not in `canonicalModel`. An adapter that read
`canonicalModel` would be blind to exactly the change this project watches for, and a test pins it.

**Alias granularity is provider- and model-dependent.** A tool that assumes a dated id exists would
report "no identity change" for a provider that never had one to show, so undisclosed fields are
named in the report rather than treated as unchanged.

## The `codex` CLI adapter, and a provider that discloses nothing

Added because "one provider, one model family, one machine" was limitation #3 and the two BYOK HTTP
adapters that would close it need a key this environment does not have. `codex exec` does not: it
runs on the local Codex plan session in `CODEX_HOME`, the same way `claude -p` runs on a Claude plan
session. The invocation is the one the sibling `agent-context-containment` already proved, plus
`--json`.

**THIS DOES NOT CLOSE THE BYOK GAP.** `anthropic_api` and `openai_compatible` speak to deployed HTTP
endpoints and are still shipped and unrun. A plan-backed CLI is a third thing.

### What it discloses, measured on a live 16-call run

| field | `claude_cli` | `codex_cli` |
|---|---|---|
| served model identity | `claude-haiku-4-5-20251001` for the `haiku` alias | **nothing, for any alias** |
| canonical model | yes | no |
| context window / max output | yes | no |
| service tier / cost basis | yes | no |
| server latency (`apiMs`) | `duration_api_ms` | **not reported** |
| client latency (`clientMs`) | `duration_ms` | **not reported** |
| wall time | measured here | measured here |
| cost | `total_cost_usd` | **not priced by the plan** |
| input / output / cache tokens | yes | **yes** |

**The identity row is the interesting one and it runs the wedge backwards.** The README argues that
alias-resolution granularity is provider-dependent and that a tool assuming a dated id exists will
report "no identity change" for a provider that never had one to show. `codex_cli` is that provider
in its strongest form: it names no model at all. So `modelServed` and `canonicalModel` are recorded
EMPTY, `undisclosedFields` lists all six absent fields, and the drift gate reports
`identity/fingerprint NOT RUN` rather than PASS. Writing the requested alias into `modelServed`
would have manufactured a stable identity out of an absent one, and an identity check that can never
fire is worse than one that says it cannot see.

**`latencyMs` from a codex_cli run is a constant zero.** `metrics.ts` reads `apiMs`, which this
provider does not have, and copying the wall clock into a field documented as server-reported is the
defect this project already found in its own HTTP adapters. Zero is the honest value and this
sentence is the caveat; `latencyMs` is non-gating so it cannot fail a build.

### What a call costs

Measured over 8 canary cases at 1 replicate, then 16 at 2:

| quantity | value |
|---|---|
| input tokens per call | about 14,500, almost all harness context |
| output tokens per call | 5 to 6 |
| wall time per call | 3.0 to 6.4 seconds |
| errors | 0 of 16 at concurrency 2 |
| quality on the canary split | 7 of 8 |

The input-token figure is the same shape as the `claude` adapter's injected context, and it is why a
canary paid for on every tick forever is a budget decision rather than a taste one.

### The two defaults that are not interchangeable

`--model` defaulted to `sonnet` for every provider. Pointed at Codex that produced 16 failed calls
reading *The 'sonnet' model is not supported when using Codex with a ChatGPT account* - a whole
collection lost to a default belonging to a different vendor. The default is now per provider, and
for `codex_cli` it is the empty string: **on a ChatGPT plan, naming a model is rejected outright**,
so the only invocation that works is the one that names none. It is recorded as `default`.

```sh
sentinel run --provider codex_cli --split canary --replicates 2 --concurrency 2 \
  --label codex-a --out results/live-codex --yes
```

## The BYOK adapters: env vars, failure modes, and what a live run would cost

Everything in this section describes code that **has never been run against a live endpoint**. It is
written, typechecked, and exercised against a fake transport in `packages/run/test/byok.test.ts`.
"Exercised against a fake transport" is the whole claim.

### The environment variables

| variable | read by | default | when it is absent |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `AnthropicApiProvider` | none | `available()` returns `{ok: false, reason: "ANTHROPIC_API_KEY is not set"}` and every call returns `SKIPPED: ANTHROPIC_API_KEY is not set` |
| `OPENAI_API_KEY` | `OpenAiCompatibleProvider` | none | the same sentence, naming `OPENAI_API_KEY` |
| `OPENAI_BASE_URL` | `OpenAiCompatibleProvider` | `https://api.openai.com/v1` | the default is used. A value not starting with `https://` is **refused** by `available()`, not warned about |

The key is read from `process.env` at CALL TIME, inside `complete()`, and is never assigned to a
field on the instance. **The environment variable NAME is a constructor parameter**, `apiKeyEnv`:

```ts
new AnthropicApiProvider("claude-sonnet-5", { apiKeyEnv: "A_NAME_NOTHING_SETS" });
```

That one parameter is what makes the absent-key path testable in an environment that has no key,
which is the only environment this code has ever run in. The tests point both adapters at
`SENTINEL_BYOK_TEST_KEY`, a name no deployment uses, so nothing in the suite can read or clobber a
real credential, and every provider constructed in a test is handed an explicit `fetcher`.

`OPENAI_BASE_URL` is what makes the second adapter reach vLLM, Together, OpenRouter and Ollama as
well as OpenAI. Note the consequence of the https rule: a local model server on
`http://localhost:11434/v1` is refused rather than allowed as a special case. Terminate it behind
TLS or write a provider of your own; the refusal is not negotiable inside this adapter, because the
same code path carries a bearer token to a remote endpoint on a schedule forever.

### SKIPPED, NO KEY, and exit code 3

`skipped(reason)` returns a `ProviderResponse` with every number zero and
`error: "SKIPPED: <reason>"`. That string is the whole mechanism, and it travels:

- **In the snapshot.** `errorCount` counts it and `records[].response.error` carries the sentence,
  so a round that could not run is a row that says so rather than a row that is missing.
- **In grading.** `packages/detect/src/metrics.ts` drops every record whose `error` is non-empty
  from the sample and counts it separately. A no-key round therefore contributes **zero
  observations**, not zero-scored ones. This is the reason every failure mode below is required to
  carry a non-empty error.
- **In the ledger.** A metric with no samples renders `NOT RUN`, never `PASS`.
- **In the watcher.** `whyItCouldNotLook()` reports `all N call(s) in this round failed, the first
  with: <error>`, and `tickExitCode()` returns `EXIT_COULD_NOT_LOOK`. Your adapter's error string is
  what a person reads at 3am, which is why `HTTP 429` alone was not considered good enough.

**`EXIT_COULD_NOT_LOOK = 3` is not `EXIT_MISUSE = 2`** (`packages/spec/src/exitCodes.ts`). A watcher
that cannot reach its provider and a watcher pointed at the wrong file are different events with
different owners: one is an incident, the other is a typo. Neither is `1`, because neither is
evidence that the provider got worse.

**One inconsistency, stated rather than hidden.** `sentinel watch --tick` already returns `3` for a
round where every call failed. `sentinel run` still returns `2` on both of its could-not-look paths,
the unavailable provider and the all-calls-failed round (`packages/cli/src/commands.ts`). The
contract in `exitCodes.ts` is the target; `run` has not been moved onto it yet.

### The failure modes now covered

Every one is a **returned `ProviderResponse`**, never a throw, and every one is asserted in a loop
over a table so that adding a failure mode without a reason on it fails the suite.

| the endpoint does | `error` | `text` | latency kept | scored as an answer |
|---|---|---|---|---|
| answers normally | `""` | the answer | `apiMs`, `clientMs`, `wallMs` | yes |
| 429 | `HTTP 429: rate limited` | `""` | `wallMs` | no |
| 500 or 503 | `HTTP 503: provider error` | `""` | `wallMs` | no |
| 401 or 403 | `HTTP 401: rejected credential` | `""` | `wallMs` | no |
| 404 | `HTTP 404: no such endpoint or model` | `""` | `wallMs` | no |
| 200, no `content` / `choices` envelope | `malformed response: no content array` | `""` | all three | no |
| 200, a JSON scalar or a literal `null` | the same | `""` | all three | no |
| 200, envelope present, no text and no stop reason | `empty response with no stop reason` | `""` | all three | no |
| 200, body is not JSON, `res.json()` rejects | `transport failure: SyntaxError` | `""` | `wallMs` | no |
| unreachable, the fetch rejects | `transport failure: TypeError` | `""` | `wallMs` | no |
| never answers, the abort fires | `timed out after 120000ms` | `""` | `wallMs` | no |
| a transport that throws a non-Error | `transport failure: non-Error throw` | `""` | `wallMs` | no |
| no key, or a non-https base URL | `SKIPPED: <reason>` | `""` | none | no |

Three properties hold across that whole table, and they are the point of it:

- **None of them is a quality failure.** `text` is always `""` and `error` is never `""`, which is
  exactly the pair that keeps the record out of the graded sample. The dangerous row is the
  malformed 200: before this pass it returned `text: ""` with `error: ""`, so a provider serving
  broken bodies would have been reported as a model that had got worse.
- **None of them is a refusal.** A rate limit is not a model declining, and `detectRefusal("")`
  agrees. Conflating the two would move the refusal metric during an outage.
- **The key is in none of them.** Only the error's `name` is ever carried out of the catch, never
  its message, because a message is text this process did not author. The timeout sentence is the
  one exception and it is built from the adapter's own configured value.

**One thing the type cannot say.** `usage` absent entirely and `usage` reporting four honest zeroes
produce **identical** responses: `inputTokens` and friends are `number`, not `number | null`, so
**0 and "not exposed" are the same value here**. The capability fields (`contextWindow`,
`maxOutputTokens`) are nullable precisely because that distinction mattered there; it was not made
for tokens, and widening it now would change the on-disk shape of every archived snapshot. The
OpenAI-compatible path is the sharper case: it reports `cacheReadTokens: 0` because
`/v1/chat/completions` has no cache accounting for it to read, not because no cache was used.

### What would change if a key were supplied

- **Cost becomes the deployed cost.** The CLI provider injects harness context, which is why its
  cost is reported as an upper bound beside a computed bare-API lower bound. These adapters inject
  nothing, so `harnessCostUsd` is `0` **by construction** and the two bounds no longer bracket
  anything. Beware the reading: `summariseCost` will print a "measured upper bound" of `$0.0000`
  beside a computed lower bound of `$0.0013`, upper below lower. On this path the rate-card figure
  is the only real number.
- **`modelServed` granularity may differ.** Measured on the CLI, `haiku` resolved to the dated
  `claude-haiku-4-5-20251001` and `sonnet` to the undated `claude-sonnet-5`, with the dated id in
  the `modelUsage` KEY. The Messages API reports one top-level `model` string instead, so its
  granularity is whatever that field carries and need not match. An OpenAI-compatible endpoint may
  return the alias you sent, a dated id, or no `model` at all; the last case yields
  `modelServed: ""`, and `undisclosedFields()` names `resolvedModel` so a report says "not
  disclosed" rather than "unchanged".
- **Rate limits become real.** An arm is 240 calls at concurrency 6 and there is **no retry layer,
  deliberately**. A 429 returns `HTTP 429: rate limited` and raises `errorCount`. A round where
  every call is rate limited is a could-not-look, and must not be recorded as a quiet round.
- **The three latency figures collapse into one.** On the CLI path `apiMs` is server-reported and
  `wallMs` includes subprocess startup, so the true figure sits inside a real interval. These
  adapters time one `fetch` with one `hrtime` pair and assign that number to all three fields, so
  `apiMs === clientMs === wallMs`. The interval is not an interval on this path, and latency
  compared across the two providers is not the same measurement.
- **Structured output is asymmetric.** The OpenAI-compatible adapter sends
  `response_format: {type: "json_schema", strict: true}` when a case declares a schema. The
  Anthropic adapter sends **no schema at all**, so a `structured_json` case is asked in prose there
  and `schemaValid` is graded from whatever text comes back. Compare `schemaValid` across those two
  adapters and you are comparing two different requests.

### Costing a live run before you spend anything

**COMPUTED, NOT MEASURED.** No API call produced any number below. This is the dated rate card in
`packages/run/src/cost.ts` multiplied by token counts that *were* measured, on the `claude` CLI
provider, and the two halves are labelled separately for exactly that reason.

Rate card, `RATE_CARD_DATE = 2026-06-24`, USD per million tokens:

| model key | input | output |
|---|---|---|
| `claude-opus-5` | 5.00 | 25.00 |
| `claude-sonnet-5` | 2.00 | 10.00 |
| `claude-haiku-4-5` | 1.00 | 5.00 |

Measured per-call token means, from the recorded runs in `results/runs/`, 24 cases at 10 replicates:

| arm | served model | mean input | mean output | successful calls |
|---|---|---|---|---|
| `baseline.json` | `claude-sonnet-5` | 467.96 | 41.21 | 230 of 240 |
| `positive-control.json` | `claude-haiku-4-5` | 419.10 | 623.35 | 240 of 240 |

The arithmetic is `summariseCost()` written out:

```
usd_per_call = mean_input / 1e6 * rate_in + mean_output / 1e6 * rate_out
usd_per_arm  = usd_per_call * cases * replicates
```

Worked for the 24-case corpus at 10 replicates, so **240 calls per arm**:

```
sonnet, on the baseline arm's measured token counts
  input    467.96 / 1e6 * 2.00   = 0.000935913
  output    41.21 / 1e6 * 10.00  = 0.000412130
  per call                       = 0.001348043
  one arm, 240 calls             = 0.3235 USD
  a full comparison, 720 calls   = 0.9706 USD

haiku, on the positive-control arm's measured token counts
  input    419.10 / 1e6 * 1.00   = 0.000419096
  output   623.35 / 1e6 * 5.00   = 0.003116771
  per call                       = 0.003535867
  one arm, 240 calls             = 0.8486 USD

opus, priced on the SONNET arm's token counts, a counterfactual twice over
  per call                       = 0.003370109
  one arm, 240 calls             = 0.8088 USD
```

A full comparison is three arms: baseline, candidate, and the independently collected confirmation
arm that a confirmed regression requires. So **about one dollar of sonnet, or about two and a half
of haiku**, per comparison at these token counts.

A haiku arm costs **2.6x a sonnet arm** despite haiku being half the price on both input and output.
The reason is in the measured column and not in the rate card: on this corpus haiku emitted 623
output tokens per call against sonnet's 41, because the structured cases pull it into long
reasoning. **Price a run from measured token counts, never from the headline rate.**

Three caveats on the figures above:

- **Cache tokens are not in the arithmetic.** `summariseCost` computes the bare-API bound from input
  and output only. `CACHE_READ_MULTIPLIER` (0.1) and `CACHE_WRITE_MULTIPLIER` (1.25) are exported
  and are not applied to it. Every arm in `results/runs/` recorded zero cache tokens, so it makes no
  difference to these numbers; turn prompt caching on and it would.
- **The token counts come from a different provider than the one being priced.** They were measured
  through the `claude` CLI with the overhead flags on. A bare API call sends the same prompt, so the
  input side should hold; the output side is a property of the model and moves when the model does.
- **The rate card goes stale, and that is normal.** A vendor reprice moves `costUsd` for every case
  at once, which is precisely why cost is not a gating metric here.

## Adding a provider

Implement `Provider` from `@model-regression-sentinel/run`: a `name`, the `model` that was ASKED for
(an alias stays an alias), `available()`, and `complete()`. Fill in whatever your provider discloses
and leave the rest null. Null is a real answer here and is reported as one.
