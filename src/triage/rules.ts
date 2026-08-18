/**
 * The deterministic verdict.
 *
 * This runs on every message, always, at the same time as the model. It is one half of reconciliation
 * (DESIGN §4.3) — not a fallback, not a degraded mode, and not what happens when something breaks.
 *
 * It reads the signals from observations.ts rather than the raw text, so there is exactly one definition
 * of "the message says X" behind both the prompt and this verdict. The two halves of reconciliation can
 * then disagree about what a message MEANS without ever disagreeing about what it CONTAINS.
 *
 * Pure: no clock, no I/O, no randomness. Same message, same verdict, forever.
 */

import {
  CATEGORIES,
  PRIORITY_RANK,
  type Category,
  type InboundMessage,
  type Priority,
  type RulesVerdict,
  type UnreadableReason,
} from './types.js';
import {
  MIN_WORD_CHARS,
  strippedProse,
  wordCharCount,
  type Signal,
  type SignalId,
} from './observations.js';

/**
 * Which signals count as independent evidence for a category. A Record rather than a list, so adding a
 * category to types.ts fails to compile here until its evidence is declared — the taxonomy cannot grow a
 * label that the floor silently never selects.
 *
 * Two rows are empty on purpose. `unknown` is what is left when nothing matched. `unreadable` is decided
 * by `unreadableReason` below and must not also be reachable by scoring: a stray replacement character
 * in an otherwise readable message is damage in the transport, not an unreadable message, and if both
 * paths could select the label they could disagree.
 */
const CATEGORY_EVIDENCE: Record<Category, readonly SignalId[]> = {
  prospect: ['prospect_language'],
  existing_client: ['self_identified_client'],
  vendor: ['selling_language', 'recruiting_language'],
  partner_referral: ['referral_language'],
  noise: ['bulk_markers'],
  unknown: [],
  unreadable: [],
};

/** Counted only for the confidence attached to an unreadable ruling. See CATEGORY_EVIDENCE for why. */
const UNREADABLE_SUPPORT: readonly SignalId[] = ['body_is_negligible', 'transport_garbage'];

/**
 * The floor a category sets before any signal raises it. A category can say "this needs a human"; it
 * cannot say "this is urgent" — priority is deadline and money at risk, never tone (DESIGN §4.2).
 */
const CATEGORY_PRIORITY_FLOOR: Record<Category, Priority> = {
  prospect: 'medium',
  existing_client: 'medium',
  vendor: 'low',
  partner_referral: 'medium',
  noise: 'low',
  unknown: 'low',
  unreadable: 'low',
};

interface PriorityRule {
  signal: SignalId;
  floor: Priority;
  /** Categories the floor does not apply to. */
  exceptFor?: readonly Category[];
  /** When set, the floor applies to these categories and no others. */
  onlyFor?: readonly Category[];
}

/**
 * Priority rules are rows, exactly like categories: one signal, and the floor it sets. A rule can only
 * ever raise priority — that is a non-negotiable, because a model that under-reads an angry client is
 * the expensive failure and a false high costs one human glance.
 */
const PRIORITY_RULES: readonly PriorityRule[] = [
  // A deadline in a pitch is the sender's calendar, not our exposure: a vendor asking "are you free next
  // week?" has stated no obligation of ours, and a date inside MIME garbage is not a date at all. The
  // floor deliberately still applies to `unknown` — a stated deadline is a fact about the message, not
  // about who sent it, and reconciliation takes the maximum priority regardless of category confidence.
  { signal: 'explicit_deadline', floor: 'high', exceptFor: ['vendor', 'noise', 'unreadable'] },
  // "an account or fee dispute from an existing client" — money at risk. Anger on its own is not a rule
  // here and must not become one.
  { signal: 'complaint_language', floor: 'high', onlyFor: ['existing_client'] },
];

/**
 * Confidence rises with the number of INDEPENDENT signals that agreed: one signal 0.65, two 0.8, three
 * or more 0.9. It never reaches 1.0, and it is never a constant — a fixed 0.9 would claim the same
 * certainty for one weak match as for three converging ones.
 *
 * Repeated phrasings inside a single signal do not count twice. Three ways of saying "not happy" is one
 * observation about the message, not three independent ones.
 */
const CONFIDENCE_BASE = 0.5;
const CONFIDENCE_PER_SIGNAL = 0.15;
const CONFIDENCE_CEILING = 0.9;

function confidenceFor(agreed: number): number {
  if (agreed <= 0) return 0;
  const raw = Math.min(CONFIDENCE_CEILING, CONFIDENCE_BASE + CONFIDENCE_PER_SIGNAL * agreed);
  return Math.round(raw * 100) / 100;
}

function isPresent(signals: Signal[], id: SignalId): boolean {
  return signals.some((s) => s.id === id && s.present);
}

function countAgreeing(signals: Signal[], ids: readonly SignalId[]): number {
  return ids.filter((id) => isPresent(signals, id)).length;
}

function raise(current: Priority, floor: Priority): Priority {
  return PRIORITY_RANK[floor] > PRIORITY_RANK[current] ? floor : current;
}

function priorityFor(category: Category, signals: Signal[]): Priority {
  let priority = CATEGORY_PRIORITY_FLOOR[category];
  for (const rule of PRIORITY_RULES) {
    if (!isPresent(signals, rule.signal)) continue;
    if (rule.exceptFor?.includes(category)) continue;
    if (rule.onlyFor && !rule.onlyFor.includes(category)) continue;
    priority = raise(priority, rule.floor);
  }
  return priority;
}

/**
 * Why a message has nothing checkable in it, or null when it is a real message — however vague.
 *
 * A merely vague message is NOT unreadable. "Just following up" is real correspondence whose intent
 * cannot be determined, which is `unknown` — a different label with a different next action (D-012).
 * `no-id` is not returned here either: a missing identifier is a defect in the record rather than in the
 * text, so the loader rules on it (DESIGN §4.1).
 */
export function unreadableReason(m: InboundMessage, signals: Signal[]): UnreadableReason | null {
  // Check order is load-bearing. An empty body is also below the word-character threshold, and a body
  // that is pure transport damage is also negligible, so the most specific reason has to be reached
  // first or every case reports as the vaguest one.
  if (m.body.trim() === '') return 'empty-body';
  if (isPresent(signals, 'transport_garbage') && wordCharCount(strippedProse(m.body)) < MIN_WORD_CHARS) {
    return 'garbled';
  }
  if (isPresent(signals, 'body_is_negligible')) return 'below-threshold';
  return null;
}

export function applyRules(m: InboundMessage, signals: Signal[]): RulesVerdict {
  if (unreadableReason(m, signals) !== null) {
    return {
      category: 'unreadable',
      priority: CATEGORY_PRIORITY_FLOOR.unreadable,
      confidence: confidenceFor(countAgreeing(signals, UNREADABLE_SUPPORT)),
    };
  }

  // The most agreeing signals wins. Ties go to whichever category is declared first in CATEGORIES: the
  // loop walks that order and replaces the leader only on a strictly higher count, so the same input
  // always produces the same verdict, with no dependence on sort stability or object key order.
  let best: Category = 'unknown';
  let bestCount = 0;
  for (const row of CATEGORIES) {
    const count = countAgreeing(signals, CATEGORY_EVIDENCE[row.id]);
    if (count > bestCount) {
      best = row.id;
      bestCount = count;
    }
  }

  // Nothing agreed with anything: `unknown` at zero, never the nearest neighbour. Past this point a
  // guess is indistinguishable from evidence, and reconciliation would weigh it as if it were.
  return {
    category: best,
    priority: priorityFor(best, signals),
    confidence: confidenceFor(bestCount),
  };
}
