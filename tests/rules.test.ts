/**
 * A corpus, because a classifier tested only on the examples it was written against tells you nothing.
 *
 * Every row is a phrasing a person would actually send, and each names the quirk it exists to cover:
 * contractions and curly apostrophes, all-lowercase typing, one-line replies with no greeting, and the
 * pairs that sit next to each other in the taxonomy (a referred prospect is not a referral partner; a
 * prospect saying "I'm not a client yet" is not an existing client).
 *
 * The rule floor is deterministic and pure, so these are exact expectations rather than tolerances. Where
 * a row expects `high`, a deadline or a money signal is in the text — never tone.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadInbound } from '../src/ingest/load.js';
import {
  SIGNAL_IDS,
  observe,
  renderObservations,
  type Signal,
  type SignalId,
} from '../src/triage/observations.js';
import { applyRules, unreadableReason } from '../src/triage/rules.js';
import {
  CATEGORY_IDS,
  PRIORITY_RANK,
  type Category,
  type InboundMessage,
  type Priority,
} from '../src/triage/types.js';

interface Phrasing {
  /** The quirk this row covers. Shown in the test name, so a failure says what stopped working. */
  readonly why: string;
  readonly subject?: string;
  readonly body: string;
  readonly from_org?: string;
  readonly category: Category;
  readonly priority: Priority;
}

/** Fixed so nothing here depends on the clock: a Monday, matching the supplied queue. */
const RECEIVED = '2026-07-20T09:00:00-04:00';

const CORPUS: readonly Phrasing[] = [
  {
    why: 'liquidity event: states a need rather than asking to become a client',
    subject: 'Wealth planning after a liquidity event',
    body: 'I recently sold my business and have around $8M in proceeds to invest. Looking for help with tax-efficient planning and setting up a family office structure. Who should I speak with?',
    category: 'prospect',
    priority: 'medium',
  },
  {
    why: 'all lowercase, no greeting',
    body: 'who should i talk to about rolling over an old 401k?',
    category: 'prospect',
    priority: 'medium',
  },
  {
    why: 'five-word one-liner',
    subject: 'question',
    body: 'What is your account minimum?',
    category: 'prospect',
    priority: 'medium',
  },
  {
    why: 'curly apostrophes, and a stated non-client',
    body: 'How do fees work at your firm? I’m not a client yet but I’d like to understand the costs.',
    category: 'prospect',
    priority: 'medium',
  },
  {
    why: 'two independent prospect phrasings in one message',
    body: 'Are you taking on new clients? I am considering hiring an advisor for the first time.',
    category: 'prospect',
    priority: 'medium',
  },
  {
    why: 'explicitly unhurried',
    subject: 'Just exploring options',
    body: 'No rush at all — I am early in thinking about whether to work with an advisor and just gathering information.',
    category: 'prospect',
    priority: 'medium',
  },
  {
    why: 'prospect with a real deadline',
    body: 'Looking for advice on a rollover — I have to decide by Friday and would rather not do it alone.',
    category: 'prospect',
    priority: 'high',
  },
  {
    why: 'referred prospect: the client is someone else',
    subject: 'Referred by Dana Whitfield',
    body: 'Dana Whitfield, a client of yours, suggested I reach out. I am looking for comprehensive planning for my family and would like to set up an intro call soon.',
    category: 'prospect',
    priority: 'medium',
  },
  {
    why: 'client status plus a dated obligation of ours',
    subject: 'Need updated statement by Friday',
    body: "I'm an existing client and my mortgage lender needs an updated portfolio statement by this Friday. Can someone send it over? This is fairly time-sensitive.",
    category: 'existing_client',
    priority: 'high',
  },
  {
    why: 'status without a first-person verb',
    subject: 'Quarterly review scheduling',
    body: "Hi, existing client here — I'd like to get our quarterly review on the calendar sometime in the next few weeks. Mornings work best for me.",
    category: 'existing_client',
    priority: 'medium',
  },
  {
    why: 'all lowercase, "i am a client"',
    body: 'i am a client and i need to add a beneficiary to my account. what do you need from me?',
    category: 'existing_client',
    priority: 'medium',
  },
  {
    why: 'client status in the past tense',
    body: "I've been a client since 2019. Could you resend last year's tax documents?",
    category: 'existing_client',
    priority: 'medium',
  },
  {
    why: 'first-person "as a client of yours"',
    body: 'As a client of yours, could someone confirm my address change went through?',
    category: 'existing_client',
    priority: 'medium',
  },
  {
    why: 'status implied by naming their advisor at the firm',
    body: 'My advisor at your firm suggested I email this address about setting up a wire.',
    category: 'existing_client',
    priority: 'medium',
  },
  {
    why: 'voicemail transcript: fee dispute and a same-day callback',
    body: "Yeah, hi, this is Bob Ellison, I'm a client. I just saw a fee on my last statement I don't understand and frankly I'm not happy about it. Someone needs to call me back today.",
    category: 'existing_client',
    priority: 'high',
  },
  {
    why: 'fee dispute with no deadline — money at risk is the reason, not tone',
    body: "I'm a client and I don't understand the advisory fee that appeared on my last statement.",
    category: 'existing_client',
    priority: 'high',
  },
  {
    why: 'vendor pitch whose date is the sender’s calendar, not our exposure',
    subject: 'Portfolio analytics platform — quick demo?',
    body: 'Hi team, we sell portfolio analytics software used by 200+ RIAs. Would love 20 minutes to show you what we do. Are you free next week?',
    from_org: 'Lumen Analytics',
    category: 'vendor',
    priority: 'low',
  },
  {
    why: 'two-word pitch',
    subject: 'Portfolio analytics',
    body: 'Quick demo?',
    from_org: 'Lumen Analytics',
    category: 'vendor',
    priority: 'low',
  },
  {
    why: 'product-led pitch with a trial offer',
    body: 'Our platform cuts reconciliation time for RIAs by half. Free trial if you want to try it.',
    from_org: 'Ledgerly',
    category: 'vendor',
    priority: 'low',
  },
  {
    why: 'recruiter outreach, which the taxonomy files under vendor',
    subject: 'Exciting opportunity',
    body: "Hello! I came across your profile and think you'd be a great fit for a senior role with one of my clients. Open to a chat this week?",
    from_org: 'TalentBridge Recruiting',
    category: 'vendor',
    priority: 'low',
  },
  {
    why: 'lowercase recruiter, self-described',
    body: "hi — i'm recruiting for a director of operations role and wanted to see if you're open to a conversation.",
    from_org: 'TalentBridge Recruiting',
    category: 'vendor',
    priority: 'low',
  },
  {
    why: 'peer firm proposing an arrangement, neither buying nor selling',
    subject: 'Possible referral partnership',
    body: 'I run a small RIA and occasionally have clients whose needs fall outside our scope. Could we explore a referral arrangement?',
    from_org: 'Cedar Ridge Wealth',
    category: 'partner_referral',
    priority: 'medium',
  },
  {
    why: 'five-word proposal',
    subject: 'Partnership',
    body: 'Interested in a referral arrangement?',
    from_org: 'Cedar Ridge Wealth',
    category: 'partner_referral',
    priority: 'medium',
  },
  {
    why: 'shared book of clients, without the word referral',
    body: "We have a few mutual clients and I'd like to discuss a partnership before year end.",
    from_org: 'Harbor Point Advisors',
    category: 'partner_referral',
    priority: 'medium',
  },
  {
    why: 'bulk mail with markers in both the subject and the body',
    subject: 'Your Monday market digest',
    body: 'MARKETS: Equities edged higher... [automated newsletter] To unsubscribe click here.',
    from_org: 'Market Daily',
    category: 'noise',
    priority: 'low',
  },
  {
    why: 'list-management boilerplate, contraction',
    body: "You're receiving this because you subscribed to our list. Manage your email preferences or opt out at any time.",
    from_org: 'Market Daily',
    category: 'noise',
    priority: 'low',
  },
  {
    why: 'one-line bulk mail whose only tell is the browser link',
    subject: 'Weekly digest',
    body: 'View this in your browser.',
    from_org: 'Market Daily',
    category: 'noise',
    priority: 'low',
  },
  {
    why: 'real correspondence about a conversation the inbox has no record of',
    subject: 'Following up',
    body: 'Hi — just following up on our conversation. Let me know the next step whenever you get a chance. Thanks!',
    from_org: '(unknown)',
    category: 'unknown',
    priority: 'low',
  },
  {
    why: 'a request whose subject matter is missing entirely',
    body: 'Can you send over that thing we discussed?',
    category: 'unknown',
    priority: 'low',
  },
  {
    why: 'undeterminable intent with a stated deadline',
    body: 'Following up on the item from our call — I need this before Friday.',
    category: 'unknown',
    priority: 'high',
  },
  {
    why: 'a single period',
    body: '.',
    from_org: '',
    category: 'unreadable',
    priority: 'low',
  },
  {
    why: 'an empty body',
    body: '',
    from_org: '',
    category: 'unreadable',
    priority: 'low',
  },
  {
    why: 'truncated forward: a MIME encoded-word and no prose left after it is stripped',
    subject: 'RE: RE: FWD:',
    body: '=?utf-8?B?RmFrZQ== --- forwarded message truncated ---',
    from_org: '(unknown)',
    category: 'unreadable',
    priority: 'low',
  },
];

function message(row: Phrasing, index: number): InboundMessage {
  return {
    id: `corpus-${String(index + 1).padStart(3, '0')}`,
    received_at: RECEIVED,
    channel: 'email',
    from_name: 'Sender',
    from_org: row.from_org ?? '(individual)',
    subject: row.subject ?? '',
    body: row.body,
  };
}

const MESSAGES: readonly InboundMessage[] = CORPUS.map(message);

/** Looked up by its `why` rather than by index, so reordering the corpus cannot silently retarget a test. */
function corpusMessage(whyFragment: string): InboundMessage {
  const index = CORPUS.findIndex((row) => row.why.includes(whyFragment));
  const row = CORPUS[index];
  if (row === undefined) throw new Error(`no corpus row whose reason contains "${whyFragment}"`);
  return message(row, index);
}

function adHoc(body: string, subject = ''): InboundMessage {
  return {
    id: 'ad-hoc',
    received_at: RECEIVED,
    channel: 'email',
    from_name: 'Sender',
    from_org: '(individual)',
    subject,
    body,
  };
}

function verdictFor(m: InboundMessage): ReturnType<typeof applyRules> {
  return applyRules(m, observe(m));
}

function reading(signals: readonly Signal[], id: SignalId): Signal {
  const found = signals.find((s) => s.id === id);
  if (!found) throw new Error(`observe() returned no entry for ${id}; the list is not symmetric`);
  return found;
}

function isPresent(m: InboundMessage, id: SignalId): boolean {
  return reading(observe(m), id).present;
}

describe('the corpus itself', () => {
  it('is large enough, and covers every category', () => {
    // Below about 25 rows a corpus stops being evidence and becomes a handful of examples. Every category
    // has to appear, including the two that are easiest to leave untested.
    expect(CORPUS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(CORPUS.map((row) => row.category))).toEqual(new Set(CATEGORY_IDS));
  });
});

describe('phrasings', () => {
  for (const [index, row] of CORPUS.entries()) {
    const m = message(row, index);

    it(`${row.category} · ${row.why}`, () => {
      const verdict = verdictFor(m);

      expect(verdict.category).toBe(row.category);
      expect(verdict.priority).toBe(row.priority);
      expect(verdict.confidence).toBeGreaterThanOrEqual(0);
      expect(verdict.confidence).toBeLessThanOrEqual(1);
    });
  }
});

describe('the two false positives that would be expensive', () => {
  it('does not read "I’m not a client yet" as self-identification', () => {
    // Self-identification overrides the model's category in reconciliation, so a false positive here
    // relabels a prospect as an existing client and routes them to a servicing advisor with no file open.
    const prospect = corpusMessage('curly apostrophes');

    expect(isPresent(prospect, 'self_identified_client')).toBe(false);
    expect(isPresent(prospect, 'prospect_language')).toBe(true);
    expect(verdictFor(prospect).category).toBe('prospect');
  });

  it('does not read a third party’s client status as the sender’s', () => {
    const referred = corpusMessage('referred prospect');

    expect(referred.body).toContain('a client of yours');
    expect(isPresent(referred, 'self_identified_client')).toBe(false);
    expect(isPresent(referred, 'referral_language')).toBe(true);
    // A prospect signal and a referral signal both fired; the tie goes to declaration order, which puts
    // the person asking for planning under prospect rather than under partnerships.
    expect(verdictFor(referred).category).toBe('prospect');
  });
});

describe('no signals means unknown, not the nearest neighbour', () => {
  it('returns unknown at confidence 0 when nothing matched', () => {
    const m = corpusMessage('subject matter is missing');

    // `org_is_sentinel` fires on "(individual)" and is deliberately evidence for no category: that the
    // sender named no organisation says nothing about what they want. Naming one silences it, which is the
    // case where genuinely nothing fires.
    expect(observe(m).filter((s) => s.present).map((s) => s.id)).toEqual(['org_is_sentinel']);
    expect(verdictFor(m)).toEqual({ category: 'unknown', priority: 'low', confidence: 0 });

    const named: InboundMessage = { ...m, from_org: 'Ridgeline Co' };

    expect(observe(named).filter((s) => s.present)).toEqual([]);
    expect(verdictFor(named)).toEqual({ category: 'unknown', priority: 'low', confidence: 0 });
  });

  it('scores confidence by how many independent signals agreed', () => {
    const one = adHoc('What is your account minimum?');
    const two = adHoc("We sell an analytics platform, and separately I'm recruiting for a senior role.");

    // Repeated phrasings inside one signal are one observation about the message; two different signals
    // are two. A constant would claim the same certainty for a single weak match.
    expect(verdictFor(one).confidence).toBe(0.65);
    expect(verdictFor(two).confidence).toBe(0.8);
  });

  it('separates a vague message from an unreadable one', () => {
    const vague = corpusMessage('conversation the inbox has no record of');
    const nothing = corpusMessage('a single period');

    // `unknown` is a valid message whose intent cannot be determined; `unreadable` is nothing checkable at
    // all. Merging them loses the difference between "reply and ask" and "discard".
    expect(unreadableReason(vague, observe(vague))).toBeNull();
    expect(verdictFor(vague).category).toBe('unknown');
    expect(unreadableReason(nothing, observe(nothing))).toBe('below-threshold');
    expect(unreadableReason(adHoc(''), observe(adHoc('')))).toBe('empty-body');
  });

  it('puts the unreadable line at the word-character threshold, not at a word count', () => {
    const under = adHoc('ok');
    const over = adHoc('yes');

    expect(isPresent(under, 'body_is_negligible')).toBe(true);
    expect(isPresent(over, 'body_is_negligible')).toBe(false);
    expect(verdictFor(over).category).toBe('unknown');
  });
});

describe('priority moves on deadlines and money, never on tone', () => {
  it('leaves an angry message with no deadline and no charge dispute where it was', () => {
    const angry = adHoc('This is completely unacceptable. I have asked twice now and nobody has replied.');

    expect(isPresent(angry, 'complaint_language')).toBe(true);
    expect(isPresent(angry, 'explicit_deadline')).toBe(false);
    expect(verdictFor(angry).priority).toBe('low');
  });

  it('does not read a discourse marker as a complaint, or raise priority on one', () => {
    const routine = adHoc("Existing client here. Frankly, I'd like to get our quarterly review booked at some point.");
    const complaint = reading(observe(routine), 'complaint_language');

    // Nothing here is a dispute: no charge, no service failure, no deadline. `complaint_language` is
    // documented as "dissatisfaction about a charge or a service", and for an existing client it sets a
    // `high` floor — so whatever it matches here promotes a scheduling request to the top of the queue on
    // register alone, which is the one thing priority is defined never to do.
    expect(isPresent(routine, 'explicit_deadline')).toBe(false);
    expect({ present: complaint.present, matched: complaint.detail ?? null }).toEqual({
      present: false,
      matched: null,
    });
    expect(verdictFor(routine).priority).not.toBe('high');
  });

  it('raises priority for a calm message with a stated deadline', () => {
    const calm = adHoc('Could you send the signed forms back by Thursday? Happy to help if you need anything.');

    expect(isPresent(calm, 'complaint_language')).toBe(false);
    expect(isPresent(calm, 'explicit_deadline')).toBe(true);
    expect(verdictFor(calm).priority).toBe('high');
  });

  it('ignores a vendor’s own calendar', () => {
    const vendor = corpusMessage('vendor pitch whose date');

    expect(isPresent(vendor, 'explicit_deadline')).toBe(true);
    expect(verdictFor(vendor).priority).toBe('low');
  });

  it('never lowers priority when a signal is added', () => {
    for (const [index, row] of CORPUS.entries()) {
      const base = message(row, index);
      const dated: InboundMessage = { ...base, body: `${base.body} I need this by Thursday.` };

      expect(PRIORITY_RANK[verdictFor(dated).priority]).toBeGreaterThanOrEqual(
        PRIORITY_RANK[verdictFor(base).priority],
      );
    }
  });
});

describe('symmetry — every check reports, hit or miss', () => {
  it('observe() returns one entry per declared signal, in declaration order', () => {
    for (const m of MESSAGES) {
      const signals = observe(m);

      expect(signals.map((s) => s.id)).toEqual([...SIGNAL_IDS]);
      expect(signals.every((s) => typeof s.present === 'boolean')).toBe(true);
    }
  });

  it('renderObservations prints the misses beside the hits', () => {
    const m = corpusMessage('dated obligation');
    const signals = observe(m);
    const rendered = renderObservations(signals);

    // A list of only-what-fired is a suggested answer in disguise: the absent rows are what stop the block
    // from reading as a verdict.
    for (const s of signals) {
      const state = s.present ? 'present' : 'absent';
      expect(new RegExp(`\\b${s.id}\\s+${state}\\b`).test(rendered)).toBe(true);
    }
    const states = rendered.match(/\b(?:present|absent)\b/g) ?? [];
    expect(states).toHaveLength(SIGNAL_IDS.length);
    expect(states).toContain('present');
    expect(states).toContain('absent');
  });

  it('refuses a sparse list rather than rendering one', () => {
    const onlyWhatFired: Signal[] = [{ id: 'self_identified_client', present: true }];

    expect(() => renderObservations(onlyWhatFired)).toThrow(/asymmetric input/);
  });

  it('renders in declaration order however the list arrives', () => {
    const m = corpusMessage('dated obligation');
    const rendered = renderObservations([...observe(m)].reverse());
    const positions = SIGNAL_IDS.map((id) => rendered.indexOf(`${id} `));

    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('determinism', () => {
  it('produces identical output for the whole corpus on a second pass', () => {
    // Two full passes rather than two calls on one message: a regex carrying the `g` flag advances its own
    // lastIndex, so that bug only shows once another message has been scanned in between.
    const first = MESSAGES.map((m) => ({ signals: observe(m), verdict: verdictFor(m) }));
    const second = MESSAGES.map((m) => ({ signals: observe(m), verdict: verdictFor(m) }));

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not depend on the order the messages were scanned in', () => {
    const forwards = MESSAGES.map(verdictFor);
    const backwards = [...MESSAGES].reverse().map(verdictFor).reverse();

    expect(backwards).toEqual(forwards);
  });
});

describe('the planted edge cases in the supplied queue', () => {
  const loaded = loadInbound(fileURLToPath(new URL('../raw/inbound.json', import.meta.url)));

  function supplied(id: string): InboundMessage {
    const found = loaded.messages.find((m) => m.id === id);
    if (!found) throw new Error(`no ${id} in raw/inbound.json`);
    return found;
  }

  it('rules inb-010 unreadable for having nothing in it', () => {
    const m = supplied('inb-010');
    const signals = observe(m);

    expect(unreadableReason(m, signals)).toBe('below-threshold');
    expect(applyRules(m, signals).category).toBe('unreadable');
  });

  it('rules inb-011 garbled, on the transport damage the loader preserved', () => {
    const m = supplied('inb-011');
    const signals = observe(m);

    expect(reading(signals, 'transport_garbage').present).toBe(true);
    expect(unreadableReason(m, signals)).toBe('garbled');
    expect(applyRules(m, signals).category).toBe('unreadable');
  });

  it('leaves inb-009 as unknown at zero rather than guessing', () => {
    const m = supplied('inb-009');

    expect(applyRules(m, observe(m))).toEqual({ category: 'unknown', priority: 'low', confidence: 0 });
  });

  it('rules exactly two of the thirteen unreadable', () => {
    const unreadable = loaded.messages.filter((m) => applyRules(m, observe(m)).category === 'unreadable');

    expect(unreadable.map((m) => m.id)).toEqual(['inb-010', 'inb-011']);
  });
});
