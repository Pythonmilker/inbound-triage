/**
 * Reconciliation is where "deterministic triage" is either true or decorative, and the property it rests on
 * is an asymmetry: the rules may raise priority and may never lower it. A model that under-reads an angry
 * client with a Friday deadline costs real money; a false high costs one human glance.
 *
 * So the asymmetry is pinned in both directions, and over the whole 3x3x3x2 grid of inputs rather than on
 * one hand-picked pair — the failure mode being guarded against is a `min` or a plain assignment slipping
 * in somewhere that only fires on one combination.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SELF_IDENTIFIED_CLIENT, reconcile, type ReconcileInput } from '../src/triage/reconcile.js';
import { CONFIDENCE_THRESHOLD } from '../src/triage/schema.js';
import { PRIORITY_IDS, PRIORITY_RANK, type ModelVerdict, type Priority } from '../src/triage/types.js';

const RULES_CONFIDENCE = 0.65;

/**
 * The two layers always disagree about the category in these fixtures. Agreement would make every
 * assertion about *which* layer supplied a field unfalsifiable.
 */
function input(
  rulesPriority: Priority,
  modelPriority: Priority,
  modelConfidence: number,
  signals: ReconcileInput['rules']['signals'] = [],
): ReconcileInput {
  return {
    rules: {
      category: 'existing_client',
      priority: rulesPriority,
      confidence: RULES_CONFIDENCE,
      signals,
    },
    model: {
      summary: 'Asks for an updated portfolio statement.',
      evidence: '"updated portfolio statement"',
      category: 'prospect',
      priority: modelPriority,
      next_action: 'Send the statement.',
      confidence: modelConfidence,
    } satisfies ModelVerdict,
  };
}

const CONFIDENCES = [0.2, CONFIDENCE_THRESHOLD, 0.95] as const;

function grid(): readonly ReconcileInput[] {
  const cases: ReconcileInput[] = [];
  for (const rulesPriority of PRIORITY_IDS) {
    for (const modelPriority of PRIORITY_IDS) {
      for (const confidence of CONFIDENCES) {
        for (const signals of [[], [SELF_IDENTIFIED_CLIENT]] as const) {
          cases.push(input(rulesPriority, modelPriority, confidence, signals));
        }
      }
    }
  }
  return cases;
}

/** Any call to this fails the test that provoked it, which is the only honest way to assert "no I/O". */
const forbiddenFetch: typeof fetch = () => {
  throw new Error(
    'reconcile made a network call: there is exactly one model call per message and it has already happened',
  );
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = forbiddenFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('priority', () => {
  it('takes the rules’ higher priority over the model’s', () => {
    const result = reconcile(input('high', 'low', 0.95, ['explicit_deadline']));

    expect(result.priority).toBe('high');
    expect(result.category).toBe('prospect');
    expect(result.source).toBe('reconciled');
    expect(result.note).toContain("raised to high from the model's low");
    expect(result.note).toContain('explicit deadline');
  });

  it('never lowers the model’s priority to the rules’', () => {
    const result = reconcile(input('low', 'high', 0.95));

    expect(result.priority).toBe('high');
    expect(result.source).toBe('model');
    // The verdict is entirely the model's, and the note says only that the floor read the category
    // differently — never that anything moved, because nothing did.
    expect(result.note).not.toContain('raised');
  });

  it('is the maximum of the two on every combination', () => {
    for (const each of grid()) {
      const result = reconcile(each);
      const expected =
        PRIORITY_RANK[each.rules.priority] >= PRIORITY_RANK[each.model.priority]
          ? each.rules.priority
          : each.model.priority;

      expect(result.priority).toBe(expected);
      expect(PRIORITY_RANK[result.priority]).toBeGreaterThanOrEqual(PRIORITY_RANK[each.model.priority]);
      expect(PRIORITY_RANK[result.priority]).toBeGreaterThanOrEqual(PRIORITY_RANK[each.rules.priority]);
    }
  });

  it('keeps the model’s higher priority even when the rules own the category', () => {
    // Both halves contributed: the floor named the category, the model named the urgency.
    const result = reconcile(input('low', 'high', 0.2));

    expect(result.category).toBe('existing_client');
    expect(result.priority).toBe('high');
    expect(result.source).toBe('reconciled');
  });
});

describe('category', () => {
  it('hands the category to the rules when the sender identifies themselves outright', () => {
    const result = reconcile(input('medium', 'medium', 0.95, [SELF_IDENTIFIED_CLIENT]));

    // A stated fact in the text outranks a confident model read, because "I'm an existing client" is not a
    // judgment call.
    expect(result.category).toBe('existing_client');
    expect(result.confidence).toBe(RULES_CONFIDENCE);
    expect(result.source).toBe('rules');
    expect(result.note).toContain('the sender states they are an existing client');
  });

  it('does not treat an absent signal row as a match', () => {
    // The symmetric observation list carries every signal, present or absent. Reading an absent row as a
    // match would relabel confident prospects as clients — the expensive direction of this override.
    const result = reconcile(input('medium', 'medium', 0.95, [{ id: SELF_IDENTIFIED_CLIENT, matched: false }]));

    expect(result.category).toBe('prospect');
    expect(result.source).toBe('model');
    // No self-identification was read, which is the point of this test. The note that IS present records
    // the plain category disagreement and must not claim the sender said anything about being a client.
    expect(result.note).not.toContain('states they are an existing client');
  });

  it('accepts a bare signal id as a match', () => {
    const result = reconcile(input('medium', 'medium', 0.95, [{ id: SELF_IDENTIFIED_CLIENT }]));

    expect(result.category).toBe('existing_client');
  });

  it('hands the category to the rules when the model is under the confidence threshold', () => {
    const result = reconcile(input('medium', 'medium', 0.4));

    expect(result.category).toBe('existing_client');
    expect(result.confidence).toBe(RULES_CONFIDENCE);
    expect(result.source).toBe('rules');
    expect(result.note).toContain(`onfidence 0.40 is under ${CONFIDENCE_THRESHOLD}`);
    expect(result.note).toContain("existing_client stands instead of the model's prospect");
  });

  it('keeps the model’s category at exactly the threshold', () => {
    // The threshold is the line below which the model is not trusted alone, so the boundary value itself
    // has to stay on the model's side or the published number means something different from what it says.
    const result = reconcile(input('medium', 'medium', CONFIDENCE_THRESHOLD));

    expect(result.category).toBe('prospect');
    expect(result.confidence).toBe(CONFIDENCE_THRESHOLD);
    expect(result.source).toBe('model');
  });

  it('comes from exactly one layer, and confidence follows it', () => {
    for (const each of grid()) {
      const result = reconcile(each);
      const fromRules =
        (each.rules.signals ?? []).includes(SELF_IDENTIFIED_CLIENT) ||
        each.model.confidence < CONFIDENCE_THRESHOLD;

      expect(result.category).toBe(fromRules ? each.rules.category : each.model.category);
      expect(result.confidence).toBe(fromRules ? each.rules.confidence : each.model.confidence);
    }
  });
});

describe('source and note', () => {
  it('names the layer each field actually came from', () => {
    for (const each of grid()) {
      const result = reconcile(each);
      const categoryIsRules = result.category === each.rules.category;
      const priorityIsRules = result.priority === each.rules.priority;

      // 'model' and 'rules' mean one layer supplied both fields; 'reconciled' means one each.
      const expected =
        categoryIsRules && priorityIsRules
          ? 'rules'
          : !categoryIsRules && result.priority === each.model.priority
            ? 'model'
            : 'reconciled';

      expect(result.source).toBe(expected);
    }
  });

  it('carries a note whenever the two layers did not simply agree', () => {
    for (const each of grid()) {
      const result = reconcile(each);

      // A note on an untouched row is noise; a silent override is worse. This assertion used to read
      // `note !== null` iff `source !== 'model'`, which quietly permitted the one case that matters most:
      // the model's category winning over a floor that read the message differently produced no note at
      // all. On a real run the floor called a vendor pitch `junk` at 0.83, the model called it a prospect
      // at 0.80 and won, and the row came out looking unanimous. The model was wrong.
      //
      // So the rule is now about DISAGREEMENT rather than about who supplied the verdict.
      const disagreed = each.rules.category !== each.model.category && each.rules.confidence > 0;
      const somethingMoved = result.source !== 'model';

      expect(result.note !== null).toBe(somethingMoved || disagreed);
      if (result.note !== null) expect(result.note.endsWith('.')).toBe(true);
    }
  });

  it('records a category disagreement the model won, without changing who won', () => {
    // Transparency is not the same as deference. The model still supplies the verdict; the row just stops
    // pretending the deterministic layer agreed with it.
    const result = reconcile({
      rules: { category: 'junk', priority: 'low', confidence: 0.83, signals: [] },
      model: {
        category: 'prospect',
        priority: 'low',
        confidence: 0.8,
        summary: 'Request for a 20-minute demo of portfolio analytics software',
        evidence: 'we sell portfolio analytics software',
        next_action: 'Decline or forward to operations',
      },
    });

    expect(result.category).toBe('prospect');
    expect(result.source).toBe('model');
    expect(result.note).toContain('disagreed on the category');
    expect(result.note).toContain('junk');
    expect(result.note).toContain('0.83');
  });

  it('says so when the rule floor happened to agree with the model it replaced', () => {
    const agreeing: ReconcileInput = {
      rules: { category: 'prospect', priority: 'medium', confidence: RULES_CONFIDENCE },
      model: { ...input('medium', 'medium', 0.3).model, category: 'prospect' },
    };

    const result = reconcile(agreeing);

    expect(result.source).toBe('rules');
    expect(result.note).toContain('it happened to agree');
  });
});

describe('no model call', () => {
  it('runs the whole grid without touching the network', () => {
    // `fetch` throws for the duration of this suite, so any transport reaching for a second opinion fails
    // here. Asking a model to settle the disagreement would make the deterministic half advisory.
    expect(() => grid().map(reconcile)).not.toThrow();
  });

  it('is synchronous, so there is nothing to await', () => {
    const result = reconcile(input('high', 'low', 0.95));

    expect(result).not.toBeInstanceOf(Promise);
    expect(Object.keys(result).sort()).toEqual(['category', 'confidence', 'note', 'priority', 'source']);
  });

  it('returns the same row for the same two verdicts', () => {
    const first = grid().map(reconcile);
    const second = grid().map(reconcile);

    expect(second).toEqual(first);
  });
});
