# Live Codex smoke, and the two mistakes it made first

Supplementary evidence, not a study. Five artifacts from `codex exec` running on a local Codex plan
session in `CODEX_HOME`, with **no OpenAI API key anywhere in the environment**. Collected over the
8-case `canary` split only.

**The failed runs are kept deliberately.** Each one records a real configuration mistake and the
provider's own explanation of it, and both explanations are only legible because the adapter reads
the error out of the JSONL event stream. Before that, the first of them recorded `exit 1: ` with
nothing after the colon.

| artifact | calls | errors | what it is |
|---|---:|---:|---|
| `codex-live-smoke-*` | 8 | **8** | `--model gpt-5.1-codex`. Every call rejected: *The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.* |
| `codex-live-smoke-default-*` | 8 | 0 | The same 8 cases with no `-m` at all. **7 of 8 graded correct.** |
| `codex-a-*` (earlier) | 16 | **16** | `--model` still defaulted to `sonnet`, a Claude alias, for every provider. *The 'sonnet' model is not supported when using Codex with a ChatGPT account.* The default is now per provider. |
| `codex-a-*` (later) | 16 | 0 | Arm A of an A/A pair, 8 cases x 2 replicates. |
| `codex-b-*` | 16 | 0 | Arm B, collected independently minutes later. |

## What the A/A pair says

`sentinel compare --split canary --baseline codex-a-*.json --candidate codex-b-*.json` returns
**`INCONCLUSIVE`, exit 0.** Two arms drawn from one provider in one window, and the tool stayed quiet
and said why: at 8 cases and 2 replicates neither `quality` nor `refusal` resolves a minimum
detectable effect, so neither was actually checked. That is the correct answer for a sample this
small and it is not a `NO_DRIFT`.

The identity gate reads **`NOT RUN`**, not PASS. `codex exec` names no model in any event, for any
alias, so there was never an identity to compare - and reporting "the fingerprint was unchanged"
about a measurement that never happened is the failure this repository is organised around.

## What this is NOT

- **Not evidence of real provider drift.** Nothing here observed a provider changing. That remains
  unobserved, and it remains the headline limitation in the README.
- **Not a BYOK proof.** `anthropic_api` and `openai_compatible` speak to deployed HTTP endpoints and
  are still shipped and unrun. A plan-backed CLI is a third thing.
- **Not a measured true-positive rate.**
- **Not comparable with `results/runs/` or `results/runs-v2/`.** Those are the `claude` CLI over 24
  and 34 cases; these are 8 canary cases through a different vendor. `compare` refuses across them
  on the corpus digest, which is the correct refusal.
