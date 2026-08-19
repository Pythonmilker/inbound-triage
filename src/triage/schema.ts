/**
 * The structured-output schema, and the two decisions inside it that are easy to get wrong.
 *
 * 1. FIELD ORDER IS LOAD-BEARING. Generation is autoregressive, so `summary` and `evidence` are emitted
 *    BEFORE the `category` and `priority` enums. What comes first conditions what follows: put the enums
 *    first and the label is decided before the reasoning that justifies it. This is the CARP-style
 *    clue-then-decide ordering, and it is the single cheapest quality lever in the prompt.
 *
 * 2. NO `minLength` / `maxLength` / `minimum` / `maximum`. Structured-output implementations reject or
 *    silently drop numeric and length constraints — on some providers a range keyword is a hard 400 that
 *    kills the whole model path. Length and range checks therefore live in validate.ts, never here. Both
 *    sibling repos in this workspace record this as a real defect that cost a debugging session.
 *
 * `additionalProperties: false` and a complete `required` list are mandatory: without them a model may add
 * fields, and an unexpected field is indistinguishable from a hallucinated one.
 */

import { MODEL_CATEGORY_IDS, PRIORITY_IDS } from './types.js';

export const TRIAGE_SCHEMA_NAME = 'triage_verdict';

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // Order is deliberate; see the header. Do not alphabetise.
  properties: {
    summary: {
      type: 'string',
      description:
        'One sentence, in your own words, describing what this person wants. No preamble, no quotes.',
    },
    evidence: {
      type: 'string',
      description:
        'The specific words in the message that decide the category and priority. Quote them. If the message contains no such words, write "none".',
    },
    category: {
      type: 'string',
      enum: [...MODEL_CATEGORY_IDS],
      description: 'Exactly one category id from the taxonomy given in the system prompt.',
    },
    priority: {
      type: 'string',
      enum: [...PRIORITY_IDS],
      description:
        'Priority by deadline and money at risk, not by tone. An angry message with no deadline is not automatically high.',
    },
    next_action: {
      type: 'string',
      description: 'One concrete next step a person could take today. Imperative mood, one sentence.',
    },
    confidence: {
      type: 'number',
      description:
        'Your confidence in the category, from 0 to 1. Use a value below 0.6 when the message genuinely does not say what the sender wants.',
    },
  },
  required: ['summary', 'evidence', 'category', 'priority', 'next_action', 'confidence'],
} as const;

/**
 * Below this, the model's verdict is not trusted on its own and reconciliation falls back to the rule
 * floor's category. The model is told this number in the prompt so a low score is a deliberate signal
 * rather than an accident.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

/** Ceilings enforced in validate.ts, because the schema cannot express them. */
export const FIELD_LIMITS = {
  summary: 300,
  evidence: 400,
  next_action: 200,
} as const;
