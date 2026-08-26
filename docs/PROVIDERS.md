# Providers: what was run, what was not, and what each one costs you

Five adapters behind one seam. The column that matters is the third one.

| adapter | credential | ever run here | notes |
|---|---|---|---|
| `claude_cli` | an authenticated local `claude` CLI | **yes** | Every measured number in this repository came from it. |
| `anthropic_api` | `ANTHROPIC_API_KEY` | **no** | Shipped and unrun. Its cost would be the deployed cost, with no harness overhead to subtract. |
| `openai_compatible` | `OPENAI_API_KEY` plus `OPENAI_BASE_URL` | **no** | Shipped and unrun. Speaks `/v1/chat/completions`, so it also reaches vLLM, Together, OpenRouter and Ollama. |
| `replay` | none | yes | Replays recorded outputs keyed by request hash. What the tests and both calibration studies use. |
| `noop` | none | yes | Returns `SKIPPED: <reason>` for every call, so an absent measurement is visible rather than missing. |

**There is no API key in the environment that produced this repository.** The two HTTP adapters are
written, typechecked and exercised against a fake transport, and nothing else. That is the same state
the sibling `toolcall-risk-classifier` reports for its equivalents, and for the same reason.

## The credential rules, and why each one exists

- **Read at call time, never stored.** The key never lands on the instance, in a `ProviderResponse`,
  in a snapshot or in a report. A test asserts that a response object rendered to JSON does not
  contain the key that was on the wire.
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

## Adding a provider

Implement `Provider` from `@model-regression-sentinel/run`: a `name`, the `model` that was ASKED for
(an alias stays an alias), `available()`, and `complete()`. Fill in whatever your provider discloses
and leave the rest null. Null is a real answer here and is reported as one.
