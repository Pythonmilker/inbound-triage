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
 * WEIGHTED EVIDENCE. Each signal carries the strength of the inference it supports, 1 to 5, and a category
 * scores the sum of the signals present for it. Highest sum wins.
 *
 * Weight is evidential strength, not importance: `prospect_language` is 2 because a competitor or a
 * tyre-kicker asks about minimums too, while `liquidity_event` is 5 because selling a business is a fact
 * the sender volunteered about their own circumstances and fits almost nothing else.
 *
 * This replaced counting matches, which could not discriminate at all on this traffic. Measured: the
 * messages average 125 characters and 22 words, so a message does not contain three redundant phrasings of
 * one intent - every category verdict scored exactly 0.65, being 0.5 + one signal, and the confidence
 * function was documented as rising with agreement while being unable to rise in practice.
 *
 * Weighting also removed an accident. Ties used to be broken by whichever category was declared first, and
 * on one real message that arbitrary order was the only reason the right answer came out.
 *
 * A Record rather than a list, so adding a category to types.ts fails to compile here until its evidence is
 * declared - the taxonomy cannot grow a label the floor silently never selects.
 *
 * One row is empty on purpose: `unknown` is what is left when nothing matched.
 *
 * `client_referral_named` and `partner_language` both feed `prospect` now, and they stay two signals rather
 * than one. The categories merged; the observations should not. "A client of yours suggested I reach out"
 * and "let us set up a referral arrangement" are different things for the text to contain, the model uses
 * that difference to write a useful next action, and collapsing them would throw the information away to buy
 * nothing. Their split was originally motivated by a misrouting that this merge makes impossible — that
 * motivation is gone, and the weaker one is enough.
 *
 * `junk` carries the evidence that used to be split across three labels — a vendor selling, a recruiter, a
 * machine sending, someone billing us. They were collapsed because none of those distinctions changes what
 * anyone does with the row, and a taxonomy that splits hairs the user does not care about spends its
 * discrimination in the wrong place. See types.ts.
 */
interface Evidence {
  signal: SignalId;
  /** 1 anyone could say it - 5 a volunteered fact that fits this category and little else. */
  weight: number;
}

const CATEGORY_EVIDENCE: Record<Category, readonly Evidence[]> = {
  prospect: [
    { signal: 'liquidity_event', weight: 5 },
    { signal: 'money_inbound', weight: 4 },
    { signal: 'client_referral_named', weight: 3 },
    { signal: 'partner_language', weight: 3 },
    { signal: 'prospect_language', weight: 2 },
  ],
  existing_client: [
    { signal: 'self_identified_client', weight: 5 },
    { signal: 'fee_dispute', weight: 3 },
    { signal: 'attrition', weight: 3 },
    { signal: 'escalation', weight: 2 },
    { signal: 'third_party_requester', weight: 1 },
    // `dissatisfaction` is deliberately NOT here. It was, at weight 1, and that was circular: tone alone
    // selected `existing_client`, and being `existing_client` is the one condition under which the
    // dissatisfaction modifier is allowed to raise priority. So "this is completely unacceptable" from a
    // stranger scored a category on tone and then used that category to license tone as urgency, landing
    // an unidentified sender at high. Anger says nothing about who someone is. It stays a priority
    // modifier for people we have independently established are clients, and no part of the category read.
  ],
  fraud_risk: [{ signal: 'wire_change', weight: 5 }],
  compliance: [{ signal: 'regulatory_notice', weight: 5 }],
  unknown: [],
  junk: [
    { signal: 'bulk_markers', weight: 4 },
    { signal: 'selling_language', weight: 4 },
    { signal: 'recruiting_language', weight: 4 },
    { signal: 'money_outbound', weight: 3 },
  ],
};


/**
 * Counted only for the confidence attached to a nothing-readable ruling.
 *
 * These no longer have to be kept out of CATEGORY_EVIDENCE. When `unreadable` was its own category, two
 * paths could select it and could therefore disagree. Now both paths land on `junk` and can only agree —
 * `unreadableReason` running first means an empty body that happens to contain an unsubscribe link is junk
 * *with* a reason rather than junk without one, which is strictly more information, not a conflict.
 */
const UNREADABLE_SUPPORT: readonly Evidence[] = [
  { signal: 'body_is_negligible', weight: 4 },
  { signal: 'transport_garbage', weight: 4 },
];

/**
 * The floor a category sets before any modifier moves it. A category can say "this needs a human"; on its
 * own it cannot say "this is urgent" - priority is deadline and money at risk, never tone.
 *
 * The two exceptions are `fraud_risk` and `compliance`, which are high on arrival. A payment redirect and a
 * regulator's letter both carry a clock whether or not the sender spells a date out, and in both cases the
 * cost of being slow is not a delayed reply.
 */
const CATEGORY_PRIORITY_FLOOR: Record<Category, Priority> = {
  fraud_risk: 'high',
  compliance: 'high',
  existing_client: 'medium',
  prospect: 'medium',
  unknown: 'low',
  junk: 'low',
};


/**
 * SIGNED MODIFIERS on the category floor. Priority is a second, independent sum: the category says what
 * kind of thing this is, the modifiers say how hard it is pressing.
 *
 * Two of these subtract, which reverses an earlier invariant that rules could only ever raise priority.
 * That invariant survives where it matters - reconciliation still takes the HIGHER of the rule and model
 * priorities, so a subtraction can lower this layer's own read and can never lower the final verdict below
 * what the model concluded. Inside this layer, a sender who writes "no rush at all" has told us something,
 * and treating that as equivalent to saying nothing throws the information away.
 *
 * `suppressedBy` is what stops money buying urgency inside a sales pitch. A vendor quoting a large number
 * is describing their own book, not ours.
 */
interface PriorityModifier {
  signal: SignalId;
  points: number;
  /** Categories the modifier does not apply to. */
  exceptFor?: readonly Category[];
  /** When set, the modifier applies to these categories and no others. */
  onlyFor?: readonly Category[];
  /** Any of these being present cancels the modifier, whatever the category. */
  suppressedBy?: readonly SignalId[];
}

/**
 * The one category no modifier may raise. It used to take three entries, and several rows had to name
 * `vendor` a fourth time on top — collapsing the labels collapsed the exception lists with them, which is
 * a fair part of what the simpler taxonomy bought.
 */
const NEVER: readonly Category[] = ['junk'];
const SALES_EVIDENCE: readonly SignalId[] = ['selling_language', 'recruiting_language'];

const PRIORITY_MODIFIERS: readonly PriorityModifier[] = [
  // A deadline in a pitch is the sender's calendar, not our exposure: a vendor asking "are you free next
  // week?" has stated no obligation of ours, and a date inside MIME garbage is not a date at all. The
  // modifier deliberately still applies to `unknown` - a stated deadline is a fact about the message, not
  // about who sent it, and reconciliation takes the maximum priority regardless of category confidence.
  { signal: 'explicit_deadline', points: 2, exceptFor: NEVER },
  // Money at risk, on an account that is already ours.
  { signal: 'fee_dispute', points: 2, exceptFor: NEVER },
  { signal: 'attrition', points: 2, exceptFor: NEVER },
  { signal: 'escalation', points: 2, exceptFor: NEVER },
  { signal: 'wire_change', points: 2, exceptFor: NEVER },
  // Money arriving. Both are cancelled by sales evidence, which is the whole point of scoring direction
  // instead of magnitude: a figure inside a pitch cannot buy priority.
  { signal: 'liquidity_event', points: 2, exceptFor: NEVER, suppressedBy: SALES_EVIDENCE },
  {
    signal: 'money_inbound',
    points: 2,
    exceptFor: NEVER,
    suppressedBy: [...SALES_EVIDENCE, 'money_outbound'],
  },
  // Money leaving. Someone billing the firm is work for operations, not for an advisor.
  { signal: 'money_outbound', points: -1, exceptFor: NEVER },
  // An adjective, worth half a date.
  { signal: 'time_sensitive_claim', points: 1, exceptFor: NEVER },
  { signal: 'third_party_requester', points: 1, exceptFor: NEVER },
  // Anger is not urgency. It is worth one point from someone who is already a client, because retention is
  // the exposure, and nothing at all from anyone else.
  { signal: 'dissatisfaction', points: 1, onlyFor: ['existing_client'] },
  // The sender said there is no clock. That is evidence, not silence.
  { signal: 'no_urgency', points: -1, exceptFor: NEVER },
];

/**
 * Confidence in the winning category, from two things a count cannot see: how strong the evidence is, and
 * how far ahead of the runner-up it is.
 *
 * Separation is what the old count-based function was missing. Two categories tied on weak evidence is a
 * genuinely uncertain read, and it now scores below the threshold at which this layer is allowed to
 * override the model - which is the behaviour you want, and which "one signal, so 0.65" could not express.
 *
 * It never reaches 1.0. A regex list is not certainty.
 */
const CONFIDENCE_BASE = 0.45;
const STRENGTH_SHARE = 0.35;
const SEPARATION_SHARE = 0.2;
const CONFIDENCE_CEILING = 0.9;
/** The weight at which evidence counts as fully strong: two solid signals agreeing. */
const STRENGTH_SATURATION = 8;

function confidenceFor(winner: number, runnerUp: number): number {
  if (winner <= 0) return 0;
  const strength = Math.min(1, winner / STRENGTH_SATURATION);
  const separation = (winner - runnerUp) / winner;
  const raw = CONFIDENCE_BASE + STRENGTH_SHARE * strength + SEPARATION_SHARE * separation;
  return Math.round(Math.min(CONFIDENCE_CEILING, raw) * 100) / 100;
}

function isPresent(signals: Signal[], id: SignalId): boolean {
  return signals.some((s) => s.id === id && s.present);
}

function weightPresent(signals: Signal[], evidence: readonly Evidence[]): number {
  return evidence.reduce((sum, e) => (isPresent(signals, e.signal) ? sum + e.weight : sum), 0);
}

const MIN_RANK = Math.min(...Object.values(PRIORITY_RANK));
const MAX_RANK = Math.max(...Object.values(PRIORITY_RANK));

function rankToPriority(rank: number): Priority {
  const clamped = Math.max(MIN_RANK, Math.min(MAX_RANK, rank));
  const found = (Object.keys(PRIORITY_RANK) as Priority[]).find((p) => PRIORITY_RANK[p] === clamped);
  // Unreachable: the clamp guarantees a rank every Priority maps onto. Thrown rather than defaulted so a
  // future rank that is not a whole number fails loudly instead of silently becoming `low`.
  if (found === undefined) throw new Error(`no priority for rank ${rank}`);
  return found;
}

function priorityFor(category: Category, signals: Signal[]): Priority {
  let rank = PRIORITY_RANK[CATEGORY_PRIORITY_FLOOR[category]];
  for (const mod of PRIORITY_MODIFIERS) {
    if (!isPresent(signals, mod.signal)) continue;
    if (mod.exceptFor?.includes(category)) continue;
    if (mod.onlyFor && !mod.onlyFor.includes(category)) continue;
    if (mod.suppressedBy?.some((id) => isPresent(signals, id))) continue;
    rank += mod.points;
  }
  return rankToPriority(rank);
}

/**
 * Why a message has nothing checkable in it, or null when it is a real message - however vague. The
 * caller writes `junk` and records this as the row's `reason`.
 *
 * A merely vague message is NOT this. "Just following up" is real correspondence whose intent cannot be
 * determined, which is `unknown` - a different label with a different next action (D-012), and the one
 * label that deliberately did not collapse into `junk`. `no-id` is
 * not returned here either: a missing identifier is a defect in the record rather than in the text, so the
 * loader rules on it (DESIGN §4.1).
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
      category: 'junk',
      priority: CATEGORY_PRIORITY_FLOOR.junk,
      confidence: confidenceFor(weightPresent(signals, UNREADABLE_SUPPORT), 0),
    };
  }

  // The heaviest evidence wins, and the runner-up is kept because how close it came IS the uncertainty.
  // The walk follows CATEGORIES order and replaces the leader only on a strictly greater weight, so the
  // same input always produces the same verdict with no dependence on sort stability or key order. Unlike
  // the count-based version this order almost never decides anything, because distinct weights rarely tie.
  let best: Category = 'unknown';
  let bestWeight = 0;
  let runnerUp = 0;
  for (const row of CATEGORIES) {
    const weight = weightPresent(signals, CATEGORY_EVIDENCE[row.id]);
    if (weight > bestWeight) {
      runnerUp = bestWeight;
      best = row.id;
      bestWeight = weight;
    } else if (weight > runnerUp) {
      runnerUp = weight;
    }
  }

  // Nothing agreed with anything: `unknown` at zero, never the nearest neighbour. Past this point a guess
  // is indistinguishable from evidence, and reconciliation would weigh it as if it were.
  return {
    category: best,
    priority: priorityFor(best, signals),
    confidence: confidenceFor(bestWeight, runnerUp),
  };
}
