/**
 * The taxonomy is data, and the claim that makes that worth anything is that everything downstream is
 * generated from it: the schema's enum, the system prompt's definitions, the routing lines. This file
 * exists to make a desync impossible rather than unlikely — a category that exists in the data but is
 * un-selectable by the model would silently never be chosen, and nothing else in the suite would notice.
 *
 * No assertion here counts the categories. Doubling the taxonomy is supposed to cost rows and one enum
 * entry, so a test that fails when a seventh becomes an eighth would be taxing the exact change the design
 * is built to make cheap.
 */

import { describe, expect, it } from 'vitest';

import { observe } from '../src/triage/observations.js';
import { buildSystemPrompt } from '../src/triage/prompt.js';
import { applyRules } from '../src/triage/rules.js';
import { CONFIDENCE_THRESHOLD, FIELD_LIMITS, TRIAGE_SCHEMA } from '../src/triage/schema.js';
import {
  CATEGORIES,
  CATEGORY_IDS,
  MODEL_CATEGORY_IDS,
  type InboundMessage,
  PRIORITIES,
  PRIORITY_IDS,
  PRIORITY_RANK,
  categoryDefinition,
} from '../src/triage/types.js';

/** Keys that some providers reject outright inside a structured-output schema. */
const BANNED_SCHEMA_KEYS = ['minLength', 'maxLength', 'minimum', 'maximum'] as const;

function findKeys(node: unknown, path: string, hits: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => findKeys(item, `${path}[${index}]`, hits));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    const here = `${path}.${key}`;
    if ((BANNED_SCHEMA_KEYS as readonly string[]).includes(key)) hits.push(here);
    findKeys(value, here, hits);
  }
}

describe('the enum is generated from the rows', () => {
  it('cannot desync from CATEGORIES', () => {
    expect([...CATEGORY_IDS]).toEqual(CATEGORIES.map((row) => row.id));
    // The enum offers what a JUDGMENT may reach, which is narrower than what exists.
    expect([...TRIAGE_SCHEMA.properties.category.enum]).toEqual([...MODEL_CATEGORY_IDS]);
  });

  it('offers the model every judgment label and no machine-decided one', () => {
    // Both directions, because either alone rots. A machine-decided label leaking into the enum invites a
    // reply that can only be wrong; a judgment label falling out of it makes a category unreachable.
    const decided = CATEGORIES.filter((row) => 'decidedBy' in row).map((row) => row.id);
    const judged = CATEGORIES.filter((row) => !('decidedBy' in row)).map((row) => row.id);

    expect(decided).toEqual(['unreadable']);
    expect([...MODEL_CATEGORY_IDS]).toEqual(judged);
    for (const id of decided) expect(MODEL_CATEGORY_IDS).not.toContain(id);
  });

  it('never describes a category to the model that the schema then refuses', () => {
    // The prompt and the enum are built from the same filter, and this is what pins them together: a
    // category described but not offered would push the model toward a label the request rejects.
    const prompt = buildSystemPrompt();
    const offered = new Set<string>(TRIAGE_SCHEMA.properties.category.enum);

    for (const row of CATEGORIES) {
      const described = prompt.includes(`  ${row.id} - ${row.label}`);
      expect({ id: row.id, described }).toEqual({ id: row.id, described: offered.has(row.id) });
    }
  });

  it('keeps the machine-decided label reachable by the rule layer', () => {
    // Excluding it from the model's menu must not make it unreachable. The rule layer still assigns it, and
    // `unreadableReason` is the only thing that can.
    const empty: InboundMessage = {
      id: 'x',
      received_at: '2026-07-20T09:00:00-04:00',
      channel: 'email',
      from_name: 'A',
      from_org: '(individual)',
      subject: '',
      body: '   ',
    };
    const verdict = applyRules(empty, observe(empty));

    expect(verdict.category).toBe('unreadable');
    expect(MODEL_CATEGORY_IDS).not.toContain(verdict.category);
  });

  it('cannot desync from PRIORITIES', () => {
    expect([...TRIAGE_SCHEMA.properties.priority.enum]).toEqual(PRIORITIES.map((row) => row.id));
    expect([...PRIORITY_IDS]).toEqual(PRIORITIES.map((row) => row.id));
  });

  it('has no duplicate or empty ids', () => {
    // A duplicate would make the enum's own tie-break order meaningless and the rule floor's declaration
    // order ambiguous.
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length);
    expect(CATEGORY_IDS.every((id) => /^[a-z][a-z_]*$/.test(id))).toBe(true);
  });
});

describe('every row carries what the prompt is built from', () => {
  it('gives each category a definition and a routing line', () => {
    for (const row of CATEGORIES) {
      expect(row.label.trim().length).toBeGreaterThan(0);
      expect(row.definition.trim().length).toBeGreaterThan(0);
      expect(row.routing.trim().length).toBeGreaterThan(0);
      expect(categoryDefinition(row.id)).toBe(row.definition);
    }
  });

  it('gives each priority a definition', () => {
    for (const row of PRIORITIES) {
      expect(row.definition.trim().length).toBeGreaterThan(0);
    }
  });

  it('reaches the model — every definition and routing line appears in the system prompt', () => {
    const prompt = buildSystemPrompt();

    // This is the assertion that makes "a new category is one row" true. Without it, a row could be added
    // to the enum while the prompt still describes the old set, and the model would be choosing between
    // labels it was never told the meaning of.
    //
    // Scoped to the categories the model may actually return. A machine-decided label is settled before the
    // call and excluded from the enum, so describing it would push the model toward a label the request then
    // refuses - which is why the sibling test asserts the prompt and the enum agree row by row.
    for (const row of CATEGORIES) {
      if (!(MODEL_CATEGORY_IDS as readonly string[]).includes(row.id)) continue;
      expect(prompt).toContain(row.id);
      expect(prompt).toContain(row.definition);
      expect(prompt).toContain(row.routing);
    }
    for (const row of PRIORITIES) {
      expect(prompt).toContain(row.definition);
    }
    expect(prompt).toContain(String(CONFIDENCE_THRESHOLD));
    expect(prompt).toContain(String(FIELD_LIMITS.summary));
  });

  it('rejects an id that is not in the taxonomy', () => {
    expect(() => categoryDefinition('urgent' as (typeof CATEGORY_IDS)[number])).toThrow(/unknown category/);
  });
});

describe('unknown and unreadable are different things', () => {
  it('both exist and are distinct', () => {
    /*
     * `unknown` is a VALID message whose intent cannot be determined — real correspondence referring to a
     * conversation the inbox has no record of. The next action is to reply and ask.
     *
     * `unreadable` is nothing checkable at all — an empty body, a single punctuation mark, corrupted
     * transport data. The next action is to discard, or to check whether the intake form is broken.
     *
     * Merging them, or renaming `unreadable` to `error`, loses that difference. `error` was rejected
     * specifically because it collides with the status axis: someone scanning the grid would read it as
     * "the app broke" rather than "this message is garbage".
     */
    expect(CATEGORY_IDS).toContain('unknown');
    expect(CATEGORY_IDS).toContain('unreadable');
    expect(categoryDefinition('unknown')).not.toBe(categoryDefinition('unreadable'));
  });

  it('routes to different actions', () => {
    const unknown = CATEGORIES.find((row) => row.id === 'unknown');
    const unreadable = CATEGORIES.find((row) => row.id === 'unreadable');

    expect(unknown?.routing).not.toBe(unreadable?.routing);
  });

  it('does not carry a category named error, which belongs to the status axis', () => {
    expect(CATEGORY_IDS).not.toContain('error');
  });
});

describe('priority ranking', () => {
  it('ranks every priority, distinctly, worst to best', () => {
    // Reconciliation takes a maximum over these numbers, so a missing or duplicated rank would silently
    // stop a rule from being able to raise urgency.
    expect(Object.keys(PRIORITY_RANK).sort()).toEqual([...PRIORITY_IDS].sort());
    expect(new Set(Object.values(PRIORITY_RANK)).size).toBe(PRIORITY_IDS.length);
    expect(PRIORITY_RANK.high).toBeGreaterThan(PRIORITY_RANK.medium);
    expect(PRIORITY_RANK.medium).toBeGreaterThan(PRIORITY_RANK.low);
  });
});

describe('the structured-output schema', () => {
  it('closes the object', () => {
    expect(TRIAGE_SCHEMA.type).toBe('object');
    expect(TRIAGE_SCHEMA.additionalProperties).toBe(false);
  });

  it('requires every declared property, in declaration order', () => {
    // Order is load-bearing: generation is autoregressive, so summary and evidence are written before the
    // two enums. `required` is also what the prompt quotes as the fill order, so the two lists agreeing is
    // what keeps the instruction and the schema from drifting apart.
    expect([...TRIAGE_SCHEMA.required]).toEqual(Object.keys(TRIAGE_SCHEMA.properties));
    expect([...TRIAGE_SCHEMA.required].slice(0, 2)).toEqual(['summary', 'evidence']);
    expect(TRIAGE_SCHEMA.required.indexOf('summary')).toBeLessThan(
      TRIAGE_SCHEMA.required.indexOf('category'),
    );
  });

  it('carries no length or range keyword anywhere', () => {
    // On some providers a range keyword is a hard 400 that kills the whole model path, and a 400 does not
    // fall through to the next model. Length and range checks live in validate.ts for exactly this reason,
    // which is why FIELD_LIMITS exists as a separate constant.
    const hits: string[] = [];
    findKeys(TRIAGE_SCHEMA, 'TRIAGE_SCHEMA', hits);

    expect(hits).toEqual([]);
    expect(Object.keys(FIELD_LIMITS).every((field) => field in TRIAGE_SCHEMA.properties)).toBe(true);
  });

  it('describes every property, since the descriptions are the field-level instructions', () => {
    for (const [name, property] of Object.entries(TRIAGE_SCHEMA.properties)) {
      expect(property.description.trim().length, `${name} has no description`).toBeGreaterThan(0);
    }
  });
});
