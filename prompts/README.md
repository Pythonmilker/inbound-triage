# prompts/

`system.md` is the system prompt as it is actually sent. It is generated output: `src/triage/prompt.ts`
renders the category and priority sections from the taxonomy rows in `src/triage/types.ts`, so the prose
cannot end up describing a different set of labels from the one the schema's enum offers. Regenerate it
after any taxonomy change:

```
npx tsx -e "import('./src/triage/prompt.ts').then(m => require('node:fs').writeFileSync('prompts/system.md', m.buildSystemPrompt() + '\n'))"
```

The per-message user prompt is not committed here. `buildUserPrompt` assembles it from the raw message
inside a fence plus the symmetric observation block from `src/triage/observations.ts` — every signal
reported present or absent — and never the rule floor's verdict (DESIGN §5b, D-009).

## Parameters

All of them live in `src/llm/protocol.ts`: `temperature: 0`, `response_format` as a `json_schema` with
`strict: true`, and `provider: { require_parameters: true }`. The last one is mandatory rather than
belt-and-braces, because structured-output support is a property of the endpoint and not of the model:
without it OpenRouter can route a capable slug to a provider that ignores `response_format` and answers in
prose with an HTTP 200. `temperature: 0` removes one source of variation and is not a determinism
guarantee. Because the schema is a strong hint rather than a guarantee, `src/triage/validate.ts` re-checks
every field afterwards — enum membership, one-line length, confidence range — and those length and range
checks are deliberately absent from the schema itself, since some providers reject the keywords with a 400.

## Why the field order is what it is

`summary, evidence, category, priority, next_action, confidence`. Generation is autoregressive, so the
summary and the quoted evidence are written before the model commits to a label; with the enums first, the
label would be decided before the reasoning that justifies it.

## What the model is told about the deterministic scan — and what it is not

Every message arrives with a scan of its own text: 23 checks, each reported `present` or `absent`, in a
fixed order that carries no ranking, with the matched phrase quoted where there is one.

The scan carries **no category, no priority, no confidence and no recommendation.** That is the single
most load-bearing decision in this file. A suggested answer is absorbed silently — the reply still reads
as independent reasoning while no longer being any — so the model gets the *evidence* and never the
*conclusion*. The block says so in its own header: "These are readings, not a verdict."

This was audited rather than assumed. Rendering the exact system and user prompt for one message and
probing them:

| Probed for | System prompt | User prompt |
|---|---|---|
| the rule layer's category for this message | as one of six category *definitions*, identical for every message | **absent** |
| the rule layer's confidence | absent | **absent** |
| "the rules" / "rule floor" | absent | **absent** |
| the matched phrase, quoted | — | **present** |

### The case that justifies it

One message read *"we sell portfolio analytics software used by 200+ RIAs. Would love 20 minutes to show
you what we do."* The scan reported `selling_language present "we sell"`. The model returned **prospect**
at 0.80 — filing a supplier as a sales lead — and its own summary was *"Request for a 20-minute demo of
portfolio analytics software"*, so it had read the message correctly and still chose the wrong label.

**The model had the decisive evidence in its prompt.** That is why the deterministic layer is given
authority over the category when its evidence is characteristic of one category rather than merely
suggestive, instead of the prompt being rewritten to argue harder. No wording closes a gap that was never
an information gap. The row records the override in words a person can check.

## Voice

The three text fields are read by whoever received the message, so the prompt requires **second person**
for them — "you", "your firm" — and third person or a name for the sender.

This is a rule because its absence produced a real defect. Asked only to "say what the sender asked for",
the model wrote *"Recruiter thinks sender would be a great fit for a senior role"* — in which the sender
IS the recruiter and the person described is the reader. Neither party may be called "the sender" or "the
recipient": both are ambiguous to someone scanning a queue, and reversing them inverts the meaning while
still reading as fluent English. The line now comes back as *"A recruiter thinks you would be a great fit
for a senior role."*
