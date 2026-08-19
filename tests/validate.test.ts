/**
 * Every input here is a reply a real endpoint has been observed to send while returning HTTP 200: prose
 * instead of JSON, a fenced block, a near-miss enum, a value cut off mid-write, a field the schema never
 * declared. Structured-output support is a property of the endpoint rather than the model, so this layer is
 * the only thing standing between "the schema said so" and a verdict nobody checked.
 *
 * Two properties are worth more than the rest:
 *   - a near-miss enum is a FAILURE. Coercing "High" to `high` hides a prompt defect behind a clean verdict.
 *   - 'truncated' and 'unparseable' must land correctly, because they trigger different recovery: raise
 *     max_tokens and retry the same model, versus spend a slot on the next model in the chain.
 */

import { describe, expect, it } from 'vitest';

import { FIELD_LIMITS } from '../src/triage/schema.js';
import { gradesTheSender, validateVerdict, type ValidationFailure } from '../src/triage/validate.js';
import type { ModelVerdict } from '../src/triage/types.js';

const VALID: Record<string, unknown> = {
  summary: 'Wants an updated portfolio statement sent to their mortgage lender by Friday.',
  evidence: '"I\'m an existing client"; "needs an updated portfolio statement by this Friday"',
  category: 'existing_client',
  priority: 'high',
  next_action: 'Send the current portfolio statement to the lender today.',
  confidence: 0.92,
};

function withPatch(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...VALID, ...patch };
}

function without(...keys: readonly string[]): Record<string, unknown> {
  const copy = { ...VALID };
  for (const key of keys) delete copy[key];
  return copy;
}

interface Rejection {
  failure: ValidationFailure;
  problems: string;
}

function rejected(raw: unknown): Rejection {
  const result = validateVerdict(raw);
  if (result.ok) {
    throw new Error(`expected a rejection, got a verdict: ${JSON.stringify(result.value)}`);
  }
  expect(result.problems.length).toBeGreaterThan(0);
  return { failure: result.failure, problems: result.problems.join(' | ') };
}

function accepted(raw: unknown): ModelVerdict {
  const result = validateVerdict(raw);
  if (!result.ok) {
    throw new Error(`expected a verdict, got ${result.failure}: ${result.problems.join(' | ')}`);
  }
  return result.value;
}

describe('a reply that is not JSON at all', () => {
  it('rejects prose, and quotes the parser and the tail', () => {
    const { failure, problems } = rejected(
      'Sure! This one looks like an existing client asking for a statement. I would call it high priority.',
    );

    expect(failure).toBe('unparseable');
    expect(problems).toContain('reply is not JSON');
    expect(problems).toContain('reply ends:');
  });

  it('rejects a markdown-fenced object', () => {
    // The prompt says no fence; a small model adds one anyway, and the fence is not JSON.
    expect(rejected(`\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``).failure).toBe('unparseable');
  });

  it('rejects a bare JSON array and a bare null', () => {
    expect(rejected([VALID]).problems).toContain('not a JSON object');
    expect(rejected('null').problems).toContain('not a JSON object');
  });

  it('accepts the model’s raw string content, not just a pre-parsed object', () => {
    // Callers hand this function the raw content on purpose: once JSON.parse has thrown, the evidence that
    // distinguishes a cut-off reply from a malformed one is gone.
    expect(accepted(JSON.stringify(VALID))).toEqual(accepted(VALID));
  });
});

describe('truncated versus unparseable', () => {
  it('calls an unterminated string truncated', () => {
    const { failure, problems } = rejected('{"summary": "They want an updated portfolio statem');

    expect(failure).toBe('truncated');
    expect(problems).toContain('reply is not JSON');
  });

  it('calls an object left open truncated', () => {
    expect(rejected('{"summary": "ok", "evidence": "none", "category": "unknown"').failure).toBe(
      'truncated',
    );
  });

  it('calls a raw control character unparseable, not truncated', () => {
    // A literal newline inside a JSON string is illegal but complete. Raising max_tokens changes nothing,
    // so this has to fall through to the next model rather than retrying the same one.
    const withRawNewline = `{"summary": "line one
line two", "evidence": "none", "category": "unknown", "priority": "low", "next_action": "Reply and ask.", "confidence": 0.4}`;

    expect(rejected(withRawNewline).failure).toBe('unparseable');
  });

  it('calls a reply that stopped mid-value truncated, and names the field', () => {
    const stopped = { summary: VALID['summary'], evidence: '' };

    const { failure, problems } = rejected(stopped);

    expect(failure).toBe('truncated');
    expect(problems).toContain('"evidence" is empty and nothing after it arrived');
    expect(problems).toContain('missing required key "category"');
  });

  it('calls it unparseable when something that did arrive was already wrong', () => {
    // Cut-off evidence only wins while everything present is well formed. A bigger token cap will not fix
    // a summary that ignored the length contract, so this must not be retried as a truncation.
    const stopped = { summary: 'x'.repeat(FIELD_LIMITS.summary + 1), evidence: '' };

    expect(rejected(stopped).failure).toBe('unparseable');
  });

  it('calls a missing middle field unparseable rather than a stopping point', () => {
    const { failure, problems } = rejected(without('priority'));

    expect(failure).toBe('unparseable');
    expect(problems).toContain('missing required key "priority"');
  });

  it('calls a missing first field unparseable', () => {
    expect(rejected(without('summary')).failure).toBe('unparseable');
  });
});

describe('a near-miss enum is a failure, never a coercion', () => {
  it('rejects "High" instead of high', () => {
    const { failure, problems } = rejected(withPatch({ priority: 'High' }));

    expect(failure).toBe('unparseable');
    expect(problems).toContain('priority "High" is not one of: high, medium, low');
  });

  it('rejects a category with the wrong separator, and a capitalised one', () => {
    expect(rejected(withPatch({ category: 'existing-client' })).problems).toContain(
      'category "existing-client" is not one of',
    );
    expect(rejected(withPatch({ category: 'Prospect' })).problems).toContain('is not one of');
  });

  it('rejects a label that is not in the taxonomy at all', () => {
    expect(rejected(withPatch({ priority: 'urgent' })).problems).toContain('is not one of');
    expect(rejected(withPatch({ category: 'spam' })).problems).toContain('is not one of');
  });

  it('accepts the exact ids', () => {
    const verdict = accepted(withPatch({ category: 'noise', priority: 'low' }));

    expect(verdict.category).toBe('noise');
    expect(verdict.priority).toBe('low');
  });
});

describe('the prose fields', () => {
  it('rejects a 900-character summary and says by how much', () => {
    const { failure, problems } = rejected(withPatch({ summary: 'a'.repeat(900) }));

    expect(failure).toBe('unparseable');
    expect(problems).toContain(`summary is 900 characters, over the ${FIELD_LIMITS.summary}-character limit`);
  });

  it('folds a wrapped value onto one line instead of rejecting it', () => {
    const wrapped = `Wants an updated statement.
      Also asks how fees work.`;

    const verdict = accepted(withPatch({ summary: wrapped }));

    // All three fields are specified as one line, so a wrapped value is a formatting slip that loses no
    // information — unlike an over-long one, which means the model ignored the instruction.
    expect(verdict.summary).toBe('Wants an updated statement. Also asks how fees work.');
    expect(verdict.summary).not.toContain('\n');
  });

  it('rejects a field that is only whitespace', () => {
    expect(rejected(withPatch({ next_action: '   ' })).problems).toContain('next_action is empty');
  });

  it('rejects a field that is not a string', () => {
    expect(rejected(withPatch({ summary: 42 })).problems).toContain('summary 42 is not a string');
    expect(rejected(withPatch({ evidence: null })).problems).toContain('evidence null is not a string');
  });
});

describe('confidence', () => {
  it('rejects a number written as a string', () => {
    expect(rejected(withPatch({ confidence: '0.9' })).problems).toContain(
      'confidence "0.9" is not a finite number',
    );
  });

  it('rejects a value that cannot be a probability at all', () => {
    expect(rejected(withPatch({ confidence: Infinity })).problems).toContain('is not a finite number');
    expect(rejected(withPatch({ confidence: Number.NaN })).problems).toContain('is not a finite number');
    expect(rejected(withPatch({ confidence: null })).problems).toContain('is not a finite number');
  });

  it('clamps a finite value that overshoots the range', () => {
    // Deliberate, and pinned rather than assumed: the schema cannot carry `maximum` without risking a 400,
    // so 1.04 arrives here as a formatting slip that loses no information. Reconciliation compares this
    // number against a threshold, so what matters downstream is that it can never leave [0, 1].
    expect(accepted(withPatch({ confidence: 1.04 })).confidence).toBe(1);
    expect(accepted(withPatch({ confidence: -0.5 })).confidence).toBe(0);
  });
});

describe('a field the schema never declared', () => {
  it('rejects an extra key rather than ignoring it', () => {
    // The schema sends `additionalProperties: false`, and the reason it is mandatory is that an unexpected
    // field is indistinguishable from a hallucinated one. An endpoint that returns one has demonstrably not
    // honoured the schema — which is the documented trap this whole module exists to catch — so the reply
    // cannot be treated as clean just because the six declared fields happen to be present.
    const { problems } = rejected(withPatch({ priority_reason: 'the client sounded angry' }));

    expect(problems).toContain('priority_reason');
  });
});

describe('a reply that validates', () => {
  it('returns exactly the six declared fields', () => {
    const verdict = accepted(VALID);

    expect(Object.keys(verdict).sort()).toEqual(
      ['category', 'confidence', 'evidence', 'next_action', 'priority', 'summary'].sort(),
    );
    expect(verdict.summary).toBe(VALID['summary']);
    expect(verdict.confidence).toBe(0.92);
  });
});

describe('gradesTheSender', () => {
  it('catches an appraisal of the person', () => {
    expect(gradesTheSender('A promising prospect.')).toBe('promising');
    expect(gradesTheSender('Client is being pushy about the timeline.')).toBe('pushy');
    expect(gradesTheSender('An important client with a fee question.')).toBe('important client');
  });

  it('does not fire inside an unrelated compound', () => {
    // The hyphen case that matters most for this firm: "high-net-worth" is a factual description of a
    // household, and it sits next to two appraisal patterns. Flagging it would train the operator to
    // ignore the warning, which costs more than the warning is worth.
    expect(gradesTheSender('Wants planning for a high-net-worth family office.')).toBeNull();
    expect(gradesTheSender('Attached an invaluable set of statements.')).toBeNull();
    expect(gradesTheSender('Asks whether the fee schedule is worth reviewing.')).toBeNull();
  });

  it('reports the earliest offender, so the result does not depend on pattern order', () => {
    const text = 'A promising high-value prospect worth pursuing.';

    expect(gradesTheSender(text)).toBe('promising');
    expect(gradesTheSender(text)).toBe(gradesTheSender(text));
  });

  it('is not called by validateVerdict — a graded summary is a prompt problem, not a schema violation', () => {
    const graded = withPatch({ summary: 'A valuable client worth pursuing.' });

    expect(accepted(graded).summary).toBe('A valuable client worth pursuing.');
    expect(gradesTheSender('A valuable client worth pursuing.')).toBe('valuable');
  });
});
