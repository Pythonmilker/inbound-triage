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
