# The three arms

`pnpm eval` sends the same queue through three prompts and reports what changed. It exists because two
decisions — which model ships (D-006) and which prompt architecture ships (D-009) — are worth more measured
than argued, and because rationale answer (c) asks for a real mis-triage rather than a hypothetical one.

Only the user prompt differs between arms. The system prompt, the schema, the field order, `temperature: 0`
and `max_tokens` are identical, so a difference in the numbers is a difference in what the model was told.

| arm | the prompt contains | why it exists |
|---|---|---|
| 1 · blind | the fenced message only | the baseline: what the model does with no help |
| 2 · +observations | the message plus the symmetric scan — every signal reported present *or* absent, dates ISO-normalised, no verdict | the shipping candidate (DESIGN §5b) |
| 3 · +verdict | arm 2, plus the rule floor's conclusion: its category, its priority, its confidence | the control, built to be rejected |

Arm 2 is built by `buildUserPrompt` in `src/triage/prompt.ts` — the function the app itself calls, not a
copy of it, so the measurement is of the prompt that would actually ship.

Arm 3 exists only inside `scripts/eval.ts`. Nothing in `src/` knows how to put a verdict into a prompt, and
that is deliberate: a helper in the production tree is a thing a later change can call by accident.

## Why arm 3 is built to be rejected

Injecting a *conclusion* is measurably dangerous, and injecting *observations* is not the same act. A
suggested answer costs up to 36 accuracy points on reasoning benchmarks; sycophantic flips of
originally-correct answers reach ~98% under mild challenge; small models are more susceptible than large
ones. The part that makes it dangerous rather than merely lossy is that the hint is absorbed silently — the
model's prose still reads as independent reasoning, so nothing in the output shows it capitulated.

If that happens here, reconciliation (DESIGN §4.3) becomes theatre: agreement between the two layers rises,
which reads as validation, while both verdicts trace back to one source.

So arm 3 is a control on our own claim, not a candidate. It is also built to anchor *hard* — its block says
outright that the deterministic layer has already decided, overriding the system prompt's statement that
nothing has. A weak anchor would rig the experiment toward the answer we expect, which is the same defect
pointing the other way.

It is arm 2 **plus** the verdict, never arm 2's scan replaced by it. The decisive comparison is arm 2 → arm
3, and that delta only isolates the conclusion if the conclusion is the only thing that changed.

## What each result would mean

| if the numbers say | the reading |
|---|---|
| arm 3 agreement with the rules **rises** while accuracy does not | **capitulation, measured** — on this data, with this model. Arm 3 is rejected on evidence rather than on a citation, and the flip columns show whether it moved onto a *wrong* rule verdict, which is the cost. |
| arm 3 raises agreement **and** accuracy | the anchoring effect did not reproduce here. That is a finding for Joel, not a licence for the script to reverse a locked decision; a queue this small moves several points on one row. |
| arm 3 does not raise agreement | the control did not fire. Nothing was gained, and nothing here argues for arm 3 either — arm 2 still has to earn its place on its own accuracy. |
| arm 2 beats arm 1 on accuracy | the observation block earns its place. Until this cell has numbers in it, D-009 is a defensible extrapolation and RATIONALE.md has to say so in those words. |
| arm 2 and arm 1 are within one row of each other | the queue cannot discriminate. Say that, rather than picking the winner of a coin toss. |
| one model is more accurate than another on arm 2 | that settles D-006. Cost cannot settle it at this volume — the whole queue is a fraction of a cent — so cost is a tie-breaker and the `at 10k/day` column is scale evidence for rationale (e). |

## What this does not measure

- **The prose fields.** `summary` and `next_action` are model-authored and unscoreable by agreement. They
  are length-capped in `validate.ts` and read by eye.
- **More than the supplied queue.** Eleven messages reach the model; one row is worth about nine points.
  This is evidence for a decision on this data, not a benchmark.
- **Reproducibility per call.** `temperature: 0` removes one source of variation and is not a determinism
  guarantee. Two runs can differ.
- **The rows nobody labelled.** Joel labels only the rows where the arms disagreed, or where the rule floor
  disagreed with them. Everything else reports as unlabelled, which is never counted as agreement.
- **The unreadable messages.** `inb-010` and `inb-011` are ruled unreadable by the rule floor and never
  reach the model, in the eval exactly as in the app. Spending a call on `"."` is waste.

## Running it

```
pnpm eval                                    # the shipping chain, all three arms
pnpm eval --model anthropic/claude-haiku-4.5 # one slug; repeatable
pnpm eval --arms 1,2 --out eval/blind-vs-observations.md
```

Needs `OPENROUTER_API_KEY`, like the app. The report lands in `eval/report.md`; the label stub lands in
`eval/labels.json` with every category and priority set to `null`, and it stays null until a person fills it
in. The script never writes a label and never overwrites that file: a label written by the thing being
graded proves nothing.
