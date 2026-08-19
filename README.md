# Inbound Triage Assistant

Inbound Triage Assistant is a local single-user tool that reads a shared-inbox queue and returns a summary,
a category, a priority and a next action for each message. One LLM call per message, plus a deterministic
rule layer that runs alongside it and can override the result.

Requires **Node 22.13.0 or newer** (it uses the built-in `node:sqlite`) and pnpm. Developed on Node 24.19.0.
It is not deployable, has no auth and is not multi-user.

A three-minute walkthrough of it running, and why it is built this way: https://youtu.be/6F6Z33EAOms

## Quick start

```bash
pnpm install
cp .env.example .env      # then add an OpenRouter key
pnpm dev
```

Open http://localhost:5274. Thirteen messages load untriaged. Press the Run triage button.

```
13 triaged · nothing failed
12 model calls · $0.0022 · 5.1s
Attempts that failed this run: the reply did not match the schema ×1
```

Twelve calls for thirteen messages. Two have nothing readable in them and do not reach the provider, and one
reply came back malformed, so the chain retried it against the next model.

Running again does nothing, by design. Results are keyed by message id and content hash, so a re-run does
not re-roll answers already computed. To get back to an untriaged queue:

```bash
pnpm reset
```

Without a key the app refuses to start and names the variable. There is no offline mode: the brief requires
an LLM call per item, so a key is a prerequisite rather than an option. Changing it is an edit to `.env` and
a restart. The key is read by the Vite dev server and stays in the Node process, held by no `VITE_`-prefixed
variable, because that prefix compiles a value into client code.

`OPENROUTER_API_KEY` is the only required variable. `TRIAGE_MODEL`, `TRIAGE_CONCURRENCY` and `TRIAGE_DB` are
optional and documented in `.env.example`.

## Commands

```
pnpm dev            preflight checks, then the app on port 5274
pnpm verify         typecheck, then 232 tests across 13 files. No API key needed
pnpm eval           measures models and prompt variants against hand labels
pnpm reset          clears verdicts, keeps messages
pnpm prompts:dump   regenerates prompts/system.md from the code that builds it
```

Every test injects its own network function, so `pnpm verify` runs with no key set and reaches no provider.

## Design choices

Six categories, cut where the product is cut: `prospect`, `existing_client`, `fraud_risk`, `compliance`,
`unknown`, `junk`. Anything off the path of a new or existing client is one bucket. `unknown` is separate
from `junk` because junk means we know it is off that path, and unknown means we cannot tell, so it floors at
medium rather than low.

Categories and priority rules are rows in `src/triage/types.ts` and `src/triage/rules.ts`, not `if` branches.
`Record<Category, …>` refuses to compile until a new label declares both its evidence and its priority floor.

A deterministic rule layer scores every message from 23 signals, and `src/triage/reconcile.ts` merges its
verdict with the model's. The rule layer's verdict does not reach the prompt: the model gets the signal
readings and no conclusion, because an injected conclusion measurably drags a small model onto it.
[RATIONALE.md](RATIONALE.md) covers the taxonomy, the merge rules and the failure handling.

### Tradeoffs

SQLite over Airtable and over a JSON file. `node:sqlite` is built in, so the dependency count stays at what
Vite and React need, and a JSON file would have to be rewritten whole on every result.

OpenRouter over a direct Anthropic call, to make the model a one-line config change and to measure four
models against each other on the same queue.

`llama-3.3-70b` over the cheaper 8B. Both scored well on the supplied thirteen. Against sixteen held-out
messages the patterns had not seen, the 8B got half the categories right and the 70B three quarters, for
$1.79 against $1.18 per ten thousand messages a day. Claude Haiku 4.5 scored highest of the four tested at
roughly fifteen times the 70B's cost, for one extra correct row out of twelve, so it stays available as
`TRIAGE_MODEL` rather than shipping.

## Airtable model

Two tables. Messages holds the inbound record as it arrived. Verdicts holds one row per triage result, with
category and priority as single selects, summary and next_action as long text, and `source` recording which
layer supplied the category.

The linked relationship is Verdicts to Messages, one to one on message id, which is the key the SQLite store
already uses. Keeping the verdict in its own table rather than as columns on Messages lets a re-run write a
new verdict without touching the record of what arrived. `src/store/types.ts` is the interface an Airtable
adapter would implement.

## One automation

In n8n: trigger on a new Verdicts row where category is `fraud_risk`. Action, post to the operations Slack
channel with the sender, the subject and the routing line, and create a task assigned to the compliance
owner.

Fraud risk is the category where delay costs the most and where the right handling is not "reply faster", so
it is the one worth waking a human for. `src/integrations/notify.ts` is where that call goes. A
`ConsoleNotifier` is wired now and a `SlackNotifier` is a documented stub.

## How I used AI

Claude Code wrote most of the code here, and the reasoning about what to build is in
[RATIONALE.md](RATIONALE.md) and in the commit messages. Both are worth reading over the diffs, because
several of them record a decision being reversed by a measurement.

One example of overriding it. Claude proposed making a rejected or unfunded API key a terminal failure, on
the argument that retrying cannot fix a bad credential. I disagreed: the operator can fix it, and discarding
the run's pending work while the fix is one environment variable away loses data for no reason. A rejected
key now queues, the interface names what to fix, and pressing Retry drains the queue. `src/triage/retry.ts`
holds the policy table.

A second correction was measured rather than argued: Claude called the observation block sent to the model
load-bearing, and running the prompt three ways showed it changes no answers on the supplied thirteen.
[`prompts/README.md`](prompts/README.md) now claims only what the measurement supports.

## Known issues

The rule layer is fitted to the supplied data. It scores 6 of 6 against hand labels on the thirteen supplied
messages, and 1 of 16 on a held-out set written in phrasings its patterns had not seen, where it returns
`unknown` for fifteen of sixteen. It fails quietly, at medium priority, looking like a healthy verdict.
`eval/README.md` has the numbers and the method.

The worst instance: the fraud guard does not fire on "We have switched banks. Can you point it at the new
account instead?" For a tool that touches client money that is the miss that matters most. Fixing it needs
patterns derived from the domain and a fresh held-out set to measure against, because editing them against
the existing one turns the test set into a training set.

Priority is weak for every layer. The rule floor gets 5 of 12 confident held-out labels right, the best model
7 of 12.

Four of the sixteen held-out labels are marked low confidence, because they sit on a `compliance` versus
`existing_client` boundary the message text cannot settle without a client list or a prior thread. The report
scores accuracy with and without them.

The retry queue has no backoff schedule. Nothing reads `Retry-After` or the provider's rate-limit headers, so
a 429 is retried while the limit is still in force. It drains when someone presses Retry.

## Layout

```
src/triage/     taxonomy, schema, validation, rule layer, reconciliation, run loop
src/llm/        OpenRouter transport, model registry, typed failures
src/ingest/     loader, including the repair that makes the message file parseable
src/store/      Store interface and the SQLite implementation
src/ui/         React grid, filter bar, run summary
prompts/        the system prompt as the code emits it, plus the approach
eval/           held-out set, hand labels, generated reports
docs/           design written before the build, and an architecture map
```
