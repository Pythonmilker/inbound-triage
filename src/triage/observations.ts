/**
 * The observation layer: what the text demonstrably contains, reported as an instrument reading.
 *
 * SYMMETRY IS THE POINT. `observe` returns an entry for every declared signal, present or absent, and
 * `renderObservations` prints the misses beside the hits in a fixed order with no emphasis on either. A
 * list of only-what-fired — or one ordered by importance — is a suggested answer in disguise, and a
 * suggestion drags a small model toward it while its prose still reads as independent reasoning
 * (DESIGN §5b). The model receives readings. It never receives the rules' verdict.
 *
 * DIRECTION AND POSSESSION DECIDE SIGN, not the noun. `our invoice` is a vendor billing us; `the invoice
 * you sent` is a client asking about ours. `to invest` is money arriving; `payment is due` is money
 * leaving. The same word carries opposite meaning one determiner apart, so the patterns capture the
 * determiner rather than the noun.
 *
 * Pure by construction: no clock, no I/O, no randomness. Dates are derived from the message's own
 * `received_at`, never from the current time, so re-running the queue re-derives the same ISO dates.
 */

import { isOrgSentinel, type InboundMessage } from './types.js';

export type Signal = { id: string; present: boolean; detail?: string };

/**
 * Declaration order. It is fixed so the rendered block is stable, and it is NOT a ranking — nothing
 * downstream may read position as weight.
 */
export const SIGNAL_IDS = [
  'self_identified_client',
  'client_referral_named',
  'prospect_language',
  'money_inbound',
  'money_outbound',
  'liquidity_event',
  'fee_dispute',
  'dissatisfaction',
  'attrition',
  'escalation',
  'wire_change',
  'regulatory_notice',
  'third_party_requester',
  'explicit_deadline',
  'time_sensitive_claim',
  'no_urgency',
  'selling_language',
  'recruiting_language',
  'partner_language',
  'bulk_markers',
  'org_is_sentinel',
  'body_is_negligible',
  'transport_garbage',
] as const;

export type SignalId = (typeof SIGNAL_IDS)[number];

/** A body with fewer than this many letters or digits has nothing in it to check. */
export const MIN_WORD_CHARS = 3;

/** Details are quoted into the prompt, so a long match is truncated rather than allowed to bloat it. */
const PHRASE_MAX = 80;

// No pattern used with `.test()` or `.exec()` below carries the `g` flag: a global regex advances
// `lastIndex`, so the second call answers about a different offset and this module stops being pure.
// Only TRANSPORT_STRIP and WORD_CHAR are global, and both are only ever handed to a method that resets
// `lastIndex` for them (`.replace()`, `.match()`).

/**
 * A first-person claim of being a client. It must stay first-person: `inb-013` says "Dana Whitfield, a
 * client of yours, suggested I reach out", which is a third party's status, not the sender's — and
 * reconciliation lets this signal override the model's category (DESIGN §4.3), so a false positive here
 * is expensive.
 */
const SELF_IDENTIFIED_CLIENT: readonly RegExp[] = [
  /\bi'?m\s+(?:an?\s+)?(?:existing|current|long[-\s]?time)?\s*client\b/i,
  /\bi\s+am\s+(?:an?\s+)?(?:existing|current|long[-\s]?time)?\s*client\b/i,
  /\b(?:existing|current|long[-\s]?time)\s+client\s+here\b/i,
  /\bi'?ve\s+been\s+a\s+client\b/i,
  /\bas\s+(?:an?\s+)?(?:existing|current)?\s*client\s+of\s+yours\b/i,
  /\bmy\s+advisor\s+(?:at|with)\s+your\b/i,
];

/** Someone who is not a client asking about becoming one, or pricing the relationship. */
/**
 * The vocabulary of someone who is NOT yet a client, pricing the relationship. It asks about the terms of
 * engagement — minimums, fees, who to talk to — which a client already has.
 *
 * Three earlier patterns were removed as fixture-fitted: `looking for (help|advice|comprehensive|...)`,
 * `exploring (options|advisors|firms)`, and `gathering information` each matched exactly one message in
 * that message's own wording, which is the signature of a pattern written backwards from the sample. What
 * replaced them names the ROLE being shopped for (advisor, planner, fiduciary) or the terms being asked
 * about, both of which are stable across inboxes.
 */
const PROSPECT_LANGUAGE: readonly RegExp[] = [
  /\bwho\s+should\s+i\s+(?:speak|talk)\s+(?:with|to)\b/i,
  /\b(?:what'?s|what\s+is)\s+your\s+(?:account\s+)?minimum\b/i,
  /\byour\s+(?:account\s+)?minimums?\b/i,
  /\bhow\s+(?:do|does|are)\s+(?:your\s+)?fees?\s+(?:work|structured|calculated)\b/i,
  /\bwhat\s+(?:do\s+)?you\s+charge\b/i,
  /\bwork(?:ing)?\s+with\s+an\s+advisor\b/i,
  /\b(?:intro|introductory|initial)\s+(?:call|meeting|conversation|consultation)\b/i,
  /\bnot\s+(?:yet\s+)?a\s+client\b/i,
  /\bconsidering\s+(?:whether|hiring|engaging|working)\b/i,
  /\btak(?:e|ing)\s+on\s+new\s+clients\b/i,
  /\b(?:accept(?:ing)?|onboard(?:ing)?)\s+new\s+clients\b/i,
  /\b(?:seeking|looking\s+for|in\s+the\s+market\s+for|shopping\s+for)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:fee[-\s]?only\s+)?(?:financial\s+)?(?:advisor|adviser|planner|wealth\s+manager|fiduciary|firm\s+to\s+manage)\b/i,
  /\b(?:interested\s+in|inquiring\s+about|enquiring\s+about)\s+(?:your\s+)?(?:services|wealth\s+management|financial\s+planning|advisory)\b/i,
  /\bwhat\s+(?:services|offerings)\s+(?:do\s+)?you\s+(?:offer|provide)\b/i,
];

/**
 * MONEY, AND WHICH WAY IT FLOWS.
 *
 * The noun does not decide the sign and neither does the amount — the DIRECTION does. Money the sender
 * proposes to place WITH the firm is the strongest positive evidence a wealth-management inbox can carry.
 * Money the sender wants FROM the firm is someone billing us, and it is negative.
 *
 * This replaced a proposed threshold ("assets over $X escalate"). A threshold has to be a number, and any
 * number is a business rule about who this firm wants — unknowable from outside it, and arbitrary from
 * inside it. Magnitude tiers were considered and rejected for the same reason: they trade one arbitrary
 * boundary for three. Direction needs no number at all.
 *
 * So THE AMOUNT IS DISPLAYED, NEVER SCORED. `$8M` is captured into the detail because a human reading the
 * row should see it, and it contributes nothing to the score. What scores is `to invest`.
 */
const MONEY_INBOUND: readonly RegExp[] = [
  /\b(?:to|and|then|would\s+like\s+to|want\s+to|hoping\s+to|need\s+to)\s+invest\b/i,
  /\binvest(?:ing)?\s+(?:it|this|these|the\s+proceeds|the\s+funds|the\s+money)\b/i,
  /\bput\s+(?:it|this|them|the\s+(?:money|funds|proceeds|cash))\s+to\s+work\b/i,
  /\blooking\s+to\s+(?:invest|allocate|deploy|diversify)\b/i,
  /\b(?:assets?|portfolio|funds?|proceeds|accounts?|savings)\s+(?:to|for)\s+(?:be\s+)?(?:manage|managed|management|invest|invested)\b/i,
  /\b(?:manage|managing|management\s+of|oversee)\s+(?:my|our)\s+(?:money|assets|portfolio|investments?|wealth)\b/i,
  /\b(?:roll(?:ing)?\s+over|transferr?(?:ing)?|mov(?:e|ing)|consolidat(?:e|ing))\s+(?:my|our)\s+(?:401\(?k\)?|ira|portfolio|accounts?|assets|holdings)\b/i,
  /\bopen(?:ing)?\s+(?:an?\s+)?(?:new\s+)?account\s+with\b/i,
  /\b(?:investable|liquid|deployable)\s+(?:assets|capital|funds)\b/i,
  /\bunder\s+management\s+(?:for|with)\s+(?:you|your)\b/i,
  // A rollover names a specific transaction that moves retirement money to a new custodian. Added after
  // removing a fitted `looking for (help|advice|...)` pattern left "advice on a rollover" with no evidence
  // at all - the fix is to recognise the transaction, which generalises, rather than to widen a phrase
  // back out until one sentence passes again.
  /\b(?:a|an|my|our|the)\s+rollover\b/i,
  /\b(?:401\(?k\)?|ira|roth|pension|retirement\s+account)\s+rollover\b/i,
];

/**
 * Money flowing the other way: the sender wants payment from the firm. Possession is what separates this
 * from `fee_dispute` — *our* invoice is a vendor billing us; *the invoice you sent* is a client asking
 * about ours. Same noun, opposite sign, one determiner apart.
 *
 * This absorbs the `asks_firm_to_pay` guard: same job, wider net, and the direction rule is what makes it
 * generalise instead of enumerating the ways a bill can be phrased.
 */
const MONEY_OUTBOUND: readonly RegExp[] = [
  /\bour\s+(?:invoice|fees?|pricing|rates?|retainer|quote|proposal|minimum)\b/i,
  /\b(?:invoice|bill)\s+(?:attached|enclosed|for\s+services|number)\b/i,
  /\bpayment\s+(?:is\s+)?(?:due|overdue|outstanding|expected)\b/i,
  /\b(?:past\s+due|remit\s+payment|settle\s+the\s+(?:invoice|balance|account))\b/i,
  /\bwe\s+(?:charge|bill|invoice)\b/i,
  /\b(?:pricing|plans?|packages?)\s+start(?:s|ing)?\s+at\b/i,
  /\b(?:sponsorship|donation|advertis(?:e|ing))\s+(?:opportunit|rate|package|inquir)/i,
  /\b(?:what'?s|is\s+there)\s+(?:your|a)\s+budget\s+for\b/i,
  /\bplease\s+(?:remit|pay|process\s+payment)\b/i,
];

/**
 * A stated change in the sender's own circumstances that turns illiquid life into investable money. This
 * carries the highest weight of any category evidence, because unlike a question about minimums it is a
 * FACT the sender volunteered about themselves rather than an enquiry anyone could make.
 */
const LIQUIDITY_EVENT: readonly RegExp[] = [
  /\b(?:sold|selling|sale\s+of)\s+(?:my|our|the|a)\s+(?:business|company|practice|firm|stake|shares?|property|home|building)\b/i,
  /\b(?:business|company)\s+(?:sale|exit)\b/i,
  /\b(?:inherit(?:ed|ance|ing)|estate\s+settlement|bequest|trust\s+distribution)\b/i,
  /\b(?:retir(?:e|ing|ement)|stepping\s+(?:down|back|away))\b/i,
  /\b(?:liquidity|exit)\s+event\b/i,
  /\b(?:ipo|tender\s+offer|acquisition\s+clos(?:e|ed|ing)|equity\s+vest(?:ing|ed)?|rsus?\s+vest)/i,
  /\b(?:severance|buyout|windfall|settlement\s+(?:proceeds|payout)|pension\s+lump\s+sum)\b/i,
  /\b(?:divorce|widow(?:ed)?|passing\s+of\s+my|death\s+of\s+my|loss\s+of\s+my\s+(?:spouse|husband|wife))\b/i,
  /\b(?:came\s+into|received)\s+(?:a\s+)?(?:significant|large|substantial)\s+(?:sum|amount|inheritance)\b/i,
];

/**
 * A date, day or deadline expression. Urgency claims ("asap", "time-sensitive") are deliberately NOT
 * here: priority is deadline and money at risk, never tone (DESIGN §4.2), and a bare urgency claim is
 * the sender's adjective rather than a date.
 *
 * Order is specificity, not importance — the first match becomes the quoted detail, so the forms an ISO
 * date can be derived from are tried first. A bare weekday is deliberately absent: it fires on "Your
 * Monday market digest", where no deadline exists.
 *
 * `this week` and `next week` were here and were measured out. They fired on "Are you free next week?"
 * and "a chat this week" - an availability question in both cases, where the sender has stated no
 * obligation of ours. Requiring a named day, a calendar date, or today/tomorrow leaves only the real
 * ones. A weekday inside a question ("free next Friday?") still slips through; that is what the model
 * half is for, and the vendor exception in rules.ts catches the common case.
 */
const DEADLINE: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i,
  /\b(?:by|before|no\s+later\s+than|due\s+(?:by|on))\s+(?:this\s+|next\s+|the\s+|end\s+of\s+(?:the\s+)?)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|noon|eod|cob|day|week|month|\d{1,2}(?:st|nd|rd|th)?)\b/i,
  /\b(?:today|tonight|tomorrow)\b/i,
  /\bthis\s+(?:coming\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bend\s+of\s+(?:the\s+)?(?:day|week|month)\b/i,
  /\b(?:eod|eow|cob|close\s+of\s+business)\b/i,
  // Last of the phrase-yielding forms: "deadline is next Friday" should quote the day, not the noun.
  /\b(?:deadline|due\s+date)\b/i,
  /\bwithin\s+(?:the\s+next\s+)?\d+\s+(?:hours?|days?|weeks?)\b/i,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
];

/**
 * A charge the sender is questioning - money already OURS, which is why this is service work and not a
 * vendor billing us. The possession rule from `money_outbound` runs the other way here: *the invoice you
 * sent*, *the fee on my statement*, *my subscription* are all the client's side of our own billing.
 *
 * Split out of what used to be one `complaint_language` signal, because conflating the two put tone and
 * money on the same footing. A fee dispute is money at risk and escalates. Being annoyed is not.
 *
 * The `(?:[a-z]+\s+){0,2}` gaps are there because a possessive almost never sits flush against its noun in
 * real writing. "A fee on my last statement" was missed by a pattern demanding `my statement`, and that is
 * the single most important sentence this signal exists to catch. Two intervening words is enough for
 * "my most recent invoice" without loosening what the pattern is anchored to.
 */
const FEE_DISPUTE: readonly RegExp[] = [
  /\b(?:unexpected|unexplained|duplicate|extra|additional|surprise)\s+(?:fee|charge|billing)\b/i,
  /\b(?:fee|charge|billing)\s+(?:dispute|error|issue|question|discrepancy)\b/i,
  /\bwhy\s+(?:was|am|were)\s+i\s+(?:charged|billed)\b/i,
  /\bshouldn'?t\s+have\s+been\s+(?:charged|billed)\b/i,
  /\b(?:fee|charge|line\s+item)\s+on\s+(?:my|our|the)\s+(?:[a-z]+\s+){0,2}(?:statement|account|invoice|bill)\b/i,
  /\b(?:the\s+)?(?:[a-z]+\s+){0,2}(?:invoice|bill|statement)\s+you\s+sent\b/i,
  /\bdouble[-\s]?(?:charged|billed)\b/i,
  /\brefund\b/i,
  /\b(?:my|our)\s+(?:[a-z]+\s+){0,2}(?:subscription|advisory\s+fee|management\s+fee)\b/i,
];

/**
 * Dissatisfaction with the service, as distinct from a dispute about money. Deliberately weak: priority is
 * deadline and money at risk, never tone (types.ts), so this contributes one point toward urgency for
 * someone who is already a client and nothing at all for anyone else.
 */
const DISSATISFACTION: readonly RegExp[] = [
  /\b(?:don'?t|do\s+not|didn'?t)\s+understand\b/i,
  /\b(?:not\s+happy|unhappy|disappointed|frustrat(?:ed|ing)|unacceptable)\b/i,
  // "frankly" was here and is deliberately gone: it is a discourse marker, not dissatisfaction.
  // "Frankly, this looks great" is not a complaint.
  /\bcomplain(?:t|ing|ts)?\b/i,
  /\bthis\s+is\s+not\s+(?:acceptable|right|what)\b/i,
  /\b(?:poor|terrible|awful|dreadful)\s+(?:service|communication|experience|response)\b/i,
  /\bno\s+(?:one|body)\s+(?:has\s+)?(?:got(?:ten)?\s+back|responded|replied|called)\b/i,
  /\b(?:third|fourth|second)\s+time\s+i'?ve\s+(?:asked|written|emailed)\b/i,
];

/**
 * A client signalling they may leave. A retention signal, not a tone signal - it names an ACTION on the
 * account rather than a feeling about it.
 */
const ATTRITION: readonly RegExp[] = [
  /\b(?:clos(?:e|ing)|transferr?(?:ing)?|mov(?:e|ing))\s+(?:my|our)\s+(?:account|accounts|assets|portfolio|holdings)\b/i,
  /\b(?:leav(?:e|ing)|terminat(?:e|ing)|end(?:ing)?)\s+(?:the\s+|our\s+)?(?:relationship|engagement|agreement|arrangement)\b/i,
  /\b(?:another|different|new|competing)\s+(?:advisor|adviser|firm|manager)\b/i,
  /\bno\s+longer\s+(?:wish|want|need|see\s+the\s+value)\b/i,
  /\b(?:withdraw|liquidate)\s+(?:my|our|all)\s+(?:funds|assets|holdings|positions)\b/i,
  /\bcancel\s+(?:my|our)\s+(?:account|service|engagement|advisory)\b/i,
  /\breconsider(?:ing)?\s+(?:our|the)\s+(?:relationship|arrangement)\b/i,
];

/**
 * The sender has gone over the desk's head, or is threatening to. Kept separate from `regulatory_notice`:
 * this is a CLIENT invoking an authority, where that one is the authority itself writing to the firm. The
 * bare agency names live there, not here, so the two cannot both fire on one mention and double-count.
 */
const ESCALATION: readonly RegExp[] = [
  /\b(?:speak|talk)\s+(?:to|with)\s+(?:your|a|the)\s+(?:manager|supervisor|principal|partner|owner|president|ceo)\b/i,
  /\bescalat(?:e|ing|ion|ed)\b/i,
  /\b(?:my|our)\s+(?:attorney|lawyer|counsel)\b/i,
  /\b(?:legal\s+action|small\s+claims|arbitration|litigation)\b/i,
  /\bfil(?:e|ing)\s+a\s+(?:formal\s+)?(?:complaint|grievance)\b/i,
  /\b(?:better\s+business\s+bureau|bbb)\b/i,
];

/**
 * A request to change where money goes. THE top fraud vector against a wealth-management firm, and the
 * reason it is its own category rather than a priority bump: the correct handling is not "deal with this
 * quickly" but "do not act on this instruction at all until you have called a number already on file".
 *
 * It fires on nothing in the sample fixture and that is the point (D-018). A guard is judged on the input
 * it has not seen yet.
 */
const WIRE_CHANGE: readonly RegExp[] = [
  /\b(?:new|updated|different|changed|revised)\s+(?:wire|wiring|bank|banking|account|routing|remittance|deposit)\s+(?:instructions?|details?|information|number|info)\b/i,
  /\b(?:chang(?:e|ing)|updat(?:e|ing)|switch(?:ing)?)\s+(?:my|our|the)\s+(?:wire|bank|banking|routing|deposit|payment)\s+(?:instructions?|details?|account|information)\b/i,
  /\b(?:wire|send|transfer)\s+(?:the\s+)?(?:funds?|money|proceeds|balance|distribution)\s+to\s+(?:the\s+)?(?:following|new|this)\b/i,
  /\bnew\s+(?:routing|account)\s+(?:and\s+account\s+)?number\b/i,
  /\b(?:redirect|reroute)\s+(?:the\s+)?(?:payment|funds|distribution|transfer)\b/i,
  /\b(?:use|switch\s+to)\s+(?:this|the\s+following|these)\s+(?:new\s+)?(?:wire|bank|account|instructions)\b/i,
];

/**
 * A regulator, auditor, or custodian writing to the firm. These carry statutory clocks, which is why the
 * category floor is high on arrival rather than on a deadline being spotted in the text - the obligation
 * exists whether or not the letter spells the date out.
 */
const REGULATORY_NOTICE: readonly RegExp[] = [
  /\b(?:examination|exam)\s+(?:notice|request|letter|scope)\b/i,
  /\b(?:sec|finra|state\s+securities|dol|fincen)\b[^.\n]{0,30}\b(?:examination|exam|inquiry|request|notice|staff|division|filing)\b/i,
  /\b(?:subpoena|summons|court\s+order|preservation\s+notice)\b/i,
  /\b(?:audit\s+confirmation|auditor'?s?\s+request|annual\s+audit|books\s+and\s+records)\b/i,
  /\b(?:form\s+adv|form\s+pf|13f|13d|rule\s+206\(4\))/i,
  /\b(?:compliance|regulatory)\s+(?:review|filing|deadline|examination|inquiry)\b/i,
  /\b(?:aml|kyc|ofac|suspicious\s+activity\s+report)\b/i,
  /\brespond\s+(?:to\s+this\s+)?(?:request\s+)?within\s+\d+\s+(?:business\s+)?days\b/i,
];

/**
 * Someone other than the sender is waiting on the answer - a lender, an accountant, an underwriter. Worth
 * one point rather than two: it makes a request harder to reschedule without itself stating a date.
 */
const THIRD_PARTY_REQUESTER: readonly RegExp[] = [
  /\b(?:my|our)\s+(?:mortgage\s+)?(?:lender|broker|bank|accountant|cpa|attorney|lawyer|landlord|underwriter|auditor|custodian)\s+(?:needs|requires|is\s+asking|asked|requested|wants|has\s+requested)\b/i,
  /\b(?:for|to\s+(?:give|send|provide)\s+to)\s+(?:my|our)\s+(?:lender|accountant|cpa|attorney|underwriter|auditor|bank)\b/i,
  /\b(?:closing|underwriting|loan\s+application|refinanc\w*|mortgage\s+application)\b/i,
  /\b(?:on\s+behalf\s+of|power\s+of\s+attorney|as\s+trustee\s+for|as\s+executor)\b/i,
];

/**
 * The sender's own urgency adjective. One point, not two: an adjective is a claim about importance, where
 * a date is a fact about the calendar. Treating "urgent" as equal to "by Friday" is how everything becomes
 * high priority.
 */
const TIME_SENSITIVE_CLAIM: readonly RegExp[] = [
  /\b(?:asap|as\s+soon\s+as\s+possible|urgent(?:ly)?|time[-\s]?sensitive|time[-\s]?critical)\b/i,
  /\b(?:right\s+away|immediately|first\s+thing)\b/i,
  /\bquick(?:ly)?\s+as\s+(?:you\s+)?can\b/i,
  /\bpressing\b/i,
];

/**
 * The sender explicitly disclaiming urgency. The only signal in the set that SUBTRACTS. It exists because
 * a polite prospect saying "no rush at all" is otherwise indistinguishable from one who said nothing, and
 * the absence of a deadline is much weaker evidence than a sender telling you there is none.
 */
const NO_URGENCY: readonly RegExp[] = [
  /\bno\s+(?:rush|hurry|urgency)\b/i,
  /\bwhenever\s+(?:you\s+(?:get|have|can)|it'?s|is)\b/i,
  /\bat\s+your\s+convenience\b/i,
  /\bno\s+(?:particular\s+|hard\s+)?deadline\b/i,
  /\btak(?:e|ing)\s+your\s+time\b/i,
  /\bnot\s+(?:in\s+a\s+rush|urgent|time[-\s]?sensitive|pressing)\b/i,
];

/** A vendor pitching the firm. Kept to first-person-plural vendor idiom so "I sold my business" is safe. */
const SELLING: readonly RegExp[] = [
  /\bwe\s+(?:sell|offer|provide|build|help)\b/i,
  /\bour\s+(?:platform|software|product|solution|service|tool)\b/i,
  /\b(?:quick|short|brief)?\s*demos?\b/i,
  /\b\d{1,3}\s+minutes?\s+(?:to|of)\b/i,
  /\bshow\s+you\s+what\s+we\s+do\b/i,
  /\bused\s+by\s+\d+\+?\b/i,
  /\b(?:free\s+trial|book\s+a\s+(?:call|demo)|schedule\s+a\s+(?:call|demo))\b/i,
  /\bcase\s+stud(?:y|ies)\b/i,
];

/** Recruiter outreach. The taxonomy files this under `vendor`: someone selling to the firm. */
const RECRUITING: readonly RegExp[] = [
  /\bcame\s+across\s+your\s+(?:profile|background|linkedin)\b/i,
  /\bgreat\s+fit\s+for\b/i,
  /\b(?:senior|leadership|executive)\s+role\b/i,
  /\brole\s+with\s+one\s+of\s+my\s+clients\b/i,
  /\b(?:recruit(?:er|ing|ment)|talent\s+acquisition|headhunt)/i,
  /\bhiring\s+for\b/i,
  /\byour\s+(?:candidacy|cv|resume)\b/i,
];

/**
 * The sender arrived through an existing client's recommendation. This is PROSPECT evidence, not partner
 * evidence, and separating it from the partner idiom is the whole reason the old single `referral_language`
 * signal was split.
 *
 * It was landing "Dana Whitfield, a client of yours, suggested I reach out" on `partner_referral` - a peer
 * firm proposing an arrangement - which routes a warm, client-referred prospect to partnerships. The old
 * code only got that row right by accident: both signals fired once each and `prospect` happened to be
 * declared first in the record, so an arbitrary list order was producing the correct answer.
 */
const CLIENT_REFERRAL_NAMED: readonly RegExp[] = [
  /\ba\s+client\s+of\s+yours\b/i,
  /\b(?:one\s+of\s+)?your\s+clients?\s+(?:suggested|recommended|referred|mentioned|told\s+me|spoke)\b/i,
  /\b(?:suggested|recommended)\s+(?:that\s+)?i\s+(?:reach\s+out|contact|get\s+in\s+touch|call|email|write)\b/i,
  /\bwas\s+referred\s+to\s+(?:you|your\s+firm)\b/i,
  /\b(?:friend|neighbou?r|colleague|family\s+member|relative)\s+(?:of\s+mine\s+)?(?:who\s+)?(?:is|works)\s+with\s+you\b/i,
  /\bcomes?\s+highly\s+recommended\b/i,
];

/**
 * A peer firm proposing an arrangement, rather than buying, selling, or being referred in. Every pattern
 * requires the PROPOSAL, which is what actually distinguishes a peer from a prospect - "I run a small RIA"
 * was removed for matching one message in its own wording while saying nothing about intent, and a bare
 * /partnership/ was removed for firing on any sentence containing the word.
 */
const PARTNER_LANGUAGE: readonly RegExp[] = [
  /\breferral\s+(?:arrangement|partnership|relationship|agreement|fee|program)\b/i,
  /\b(?:explore|discuss|propose|set\s+up)\s+a\s+(?:referral|partnership|joint|co[-\s]?advisory)\b/i,
  /\b(?:strategic|business|channel|mutually\s+beneficial)\s+partnership\b/i,
  /\bmutual\s+clients?\b/i,
  /\bwhite[-\s]?label\b/i,
  /\boutside\s+(?:our|my)\s+(?:scope|expertise|wheelhouse)\b/i,
  /\b(?:our|my)\s+(?:ria|firm|practice)\s+(?:specialis|specializ|focus|works\s+with)/i,
  /\b(?:refer|send)\s+(?:you\s+)?(?:clients?|business|cases|work)\b/i,
  /\bcenter\s+of\s+influence\b/i,
];

/** Automated bulk mail. */
const BULK: readonly RegExp[] = [
  /\bunsubscribe\b/i,
  /\[automated[^\]]*\]/i,
  /\bautomated\s+(?:newsletter|message|digest|notification)\b/i,
  /\bnewsletter\b/i,
  /\b(?:market|news|weekly|daily|monday|morning)\s+digest\b/i,
  /\bview\s+(?:this\s+)?in\s+(?:your\s+)?browser\b/i,
  /\byou'?re\s+receiving\s+this\b/i,
  /\byou\s+are\s+receiving\s+this\b/i,
  /\bmanage\s+(?:your\s+)?(?:email\s+)?preferences\b/i,
  /\b(?:do\s+not\s+reply|no[-\s]?reply@)\b/i,
  /\bmailing\s+list\b/i,
  /\bopt[-\s]?out\b/i,
];

/**
 * Transport damage. Each marker is paired with a label, and the label is what reaches the prompt — the
 * detail names the marker instead of quoting it, because quoting a NUL byte into the request is how you
 * corrupt the request you are describing.
 */
const GARBAGE_MARKERS: readonly (readonly [string, RegExp])[] = [
  ['control characters', /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/],
  ['U+FFFD replacement characters', /\ufffd/],
  // The loader may hand the illegal `\x00` escapes on as literal text rather than as bytes; both count.
  ['literal escape sequences', /\\(?:x[0-9a-f]{2}|u[0-9a-f]{4})/i],
  ['MIME encoded-word fragment', /=\?[\w-]+\?[bq]\?/i],
  [
    'MIME header fragment',
    /\b(?:content-type|content-transfer-encoding|content-disposition|mime-version)\s*:/i,
  ],
  ['MIME multipart boundary', /\bboundary\s*=/i],
];

/** Removed to ask what prose, if any, survives the damage. Global — only ever used with `.replace()`. */
const TRANSPORT_STRIP: readonly RegExp[] = [
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
  /\ufffd/g,
  /\\(?:x[0-9a-f]{2}|u[0-9a-f]{4})/gi,
  /=\?[\w-]+\?[bq]\?[^?]*\?{0,2}=?/gi,
  // Deliberately NOT `:[^\n]*` — a truncated forward often lands the header fragment and the sender's
  // own words on one line, and stripping to end-of-line would eat the prose and rule a real message
  // unreadable, which means never showing it to the model at all. Take the header's value, nothing more.
  /\b(?:content-type|content-transfer-encoding|content-disposition|mime-version)\s*:\s*(?:[\w.+-]+\/[\w.+-]+|[\w.+-]+)?\s*;?/gi,
  /\b(?:boundary|charset|name|filename)\s*=\s*"?[\w.+-]*"?/gi,
  /-{2,}/g,
  /\b(?:forwarded|original)\s+message\b/gi,
  /\btruncated\b/gi,
];

/** The body with transport damage and mail-plumbing boilerplate removed. What is left is sender prose. */
export function strippedProse(body: string): string {
  return TRANSPORT_STRIP.reduce((text, pattern) => text.replace(pattern, ' '), body).trim();
}

/**
 * `\w` is ASCII-only, so a Cyrillic or CJK body would count zero characters and be ruled unreadable.
 * Letters and numbers of any script count.
 */
const WORD_CHAR = /[\p{L}\p{N}]/gu;

export function wordCharCount(text: string): number {
  return (text.match(WORD_CHAR) ?? []).length;
}

/**
 * Phone keyboards and word processors substitute a curly apostrophe, so `i'?m` never matches what the
 * sender actually typed unless the text is folded first.
 */
function normalize(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00a0\u2007\u202f]/g, ' ');
}

function condense(match: string): string {
  const single = match.replace(/\s+/g, ' ').trim();
  return single.length > PHRASE_MAX ? `${single.slice(0, PHRASE_MAX)}...` : single;
}

function matchPhrase(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found) return condense(found[0]);
  }
  return undefined;
}

interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

/**
 * The calendar date the sender wrote on, read textually from `received_at`.
 *
 * The UTC offset is ignored on purpose: "today" means the sender's own calendar day, and converting a
 * late-evening `-04:00` timestamp to UTC would roll it onto the following date.
 */
function receivedDay(receivedAt: string): CalendarDay | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(receivedAt.trim());
  if (!parts) return null;
  const [, year, month, day] = parts;
  if (year === undefined || month === undefined || day === undefined) return null;
  return { y: Number(year), m: Number(month), d: Number(day) };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toIso(day: CalendarDay): string {
  return `${day.y}-${pad(day.m)}-${pad(day.d)}`;
}

function addDays(day: CalendarDay, n: number): CalendarDay {
  const shifted = new Date(Date.UTC(day.y, day.m - 1, day.d) + n * 86_400_000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

function dayOfWeek(day: CalendarDay): number {
  return new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const WEEKDAY_PATTERNS: readonly RegExp[] = [
  /\bsunday\b/,
  /\bmonday\b/,
  /\btuesday\b/,
  /\bwednesday\b/,
  /\bthursday\b/,
  /\bfriday\b/,
  /\bsaturday\b/,
];

const MONTH_PREFIXES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/** The next occurrence of a day-of-month, rolling into the following month once that day has passed. */
function nextDayOfMonth(from: CalendarDay, dom: number): string | undefined {
  if (dom < 1) return undefined;
  if (dom >= from.d) {
    return dom <= daysInMonth(from.y, from.m) ? toIso({ y: from.y, m: from.m, d: dom }) : undefined;
  }
  const y = from.m === 12 ? from.y + 1 : from.y;
  const m = from.m === 12 ? 1 : from.m + 1;
  return dom <= daysInMonth(y, m) ? toIso({ y, m, d: dom }) : undefined;
}

/**
 * An ISO date for the matched phrase, when one follows from the message's own date without a guess.
 *
 * Two conventions are stated because they are conventions rather than facts: a weekday means its next
 * occurrence at or after the received date, and a bare day-of-month means its next occurrence. Anything
 * containing "next" derives nothing at all — "next Friday" genuinely means either the coming Friday or
 * the one after, and a wrong date is worse than no date.
 */
function deriveIsoDate(phrase: string, day: CalendarDay | null): string | undefined {
  if (!day) return undefined;
  const p = phrase.toLowerCase();
  if (/\bnext\b/.test(p)) return undefined;

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(p);
  if (iso) {
    const [, y, m, d] = iso;
    if (y !== undefined && m !== undefined && d !== undefined) return `${y}-${m}-${d}`;
  }

  if (/\b(?:today|tonight|eod|cob|end\s+of\s+(?:the\s+)?day|close\s+of\s+business)\b/.test(p)) {
    return toIso(day);
  }
  if (/\btomorrow\b/.test(p)) return toIso(addDays(day, 1));

  const monthDay = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(p);
  if (monthDay) {
    const [, prefix, dom] = monthDay;
    const month = prefix === undefined ? -1 : MONTH_PREFIXES.indexOf(prefix as (typeof MONTH_PREFIXES)[number]);
    if (month !== -1 && dom !== undefined) {
      const target = Number(dom);
      const y = month + 1 < day.m || (month + 1 === day.m && target < day.d) ? day.y + 1 : day.y;
      if (target >= 1 && target <= daysInMonth(y, month + 1)) {
        return toIso({ y, m: month + 1, d: target });
      }
    }
  }

  const weekday = WEEKDAY_PATTERNS.findIndex((pattern) => pattern.test(p));
  if (weekday !== -1) return toIso(addDays(day, (weekday - dayOfWeek(day) + 7) % 7));

  const dom = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(p) ?? /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(p);
  if (dom) {
    const [, value] = dom;
    if (value !== undefined) return nextDayOfMonth(day, Number(value));
  }

  return undefined;
}

/**
 * A money amount, in the shapes people actually type: `$8M`, `$1,200`, `8 million`, `750k`.
 *
 * It is used for ONE thing - enriching the detail on a money signal so a human reading the row sees the
 * figure. It is deliberately NOT a signal and contributes nothing to any score. An amount on its own says
 * nothing: `$8M` appears in "I have $8M to invest" and in "our platform manages $8M for firms like yours",
 * and only the direction of flow separates a top prospect from a cold pitch. Scoring the number would
 * reward both equally, which is exactly the threshold design this replaced.
 */
const MONEY_AMOUNT =
  /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|bn?|thousand|million|billion)?\b|\b\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|thousand|million|billion)\b/i;

function amountIn(text: string): string | undefined {
  const found = MONEY_AMOUNT.exec(text);
  return found === null ? undefined : found[0].replace(/\s+/g, ' ').trim();
}

interface Reading {
  present: boolean;
  detail?: string;
}

interface Scan {
  /** Subject and body together: the subject carries real signal — "market digest" appears only there. */
  text: string;
  message: InboundMessage;
  day: CalendarDay | null;
}

type Detector = (scan: Scan) => Reading;

function phrase(patterns: readonly RegExp[]): Detector {
  return (scan) => {
    const hit = matchPhrase(scan.text, patterns);
    return hit === undefined ? { present: false } : { present: true, detail: hit };
  };
}

/**
 * A money signal reports the direction it found, and appends the figure when the message names one. The
 * figure rides along in the detail so the grid and the prompt can both show it; nothing downstream reads
 * it as a number.
 */
function money(patterns: readonly RegExp[]): Detector {
  return (scan) => {
    const hit = matchPhrase(scan.text, patterns);
    if (hit === undefined) return { present: false };
    const amount = amountIn(scan.text);
    return { present: true, detail: amount === undefined ? hit : `${hit}  (amount named: ${amount})` };
  };
}

const DETECTORS: Record<SignalId, Detector> = {
  self_identified_client: phrase(SELF_IDENTIFIED_CLIENT),
  client_referral_named: phrase(CLIENT_REFERRAL_NAMED),
  prospect_language: phrase(PROSPECT_LANGUAGE),
  money_inbound: money(MONEY_INBOUND),
  money_outbound: money(MONEY_OUTBOUND),
  liquidity_event: phrase(LIQUIDITY_EVENT),
  fee_dispute: phrase(FEE_DISPUTE),
  dissatisfaction: phrase(DISSATISFACTION),
  attrition: phrase(ATTRITION),
  escalation: phrase(ESCALATION),
  wire_change: phrase(WIRE_CHANGE),
  regulatory_notice: phrase(REGULATORY_NOTICE),
  third_party_requester: phrase(THIRD_PARTY_REQUESTER),
  explicit_deadline: (scan) => {
    const hit = matchPhrase(scan.text, DEADLINE);
    if (hit === undefined) return { present: false };
    const iso = deriveIsoDate(hit, scan.day);
    return { present: true, detail: iso === undefined || iso === hit ? hit : `${hit} -> ${iso}` };
  },
  time_sensitive_claim: phrase(TIME_SENSITIVE_CLAIM),
  no_urgency: phrase(NO_URGENCY),
  selling_language: phrase(SELLING),
  recruiting_language: phrase(RECRUITING),
  partner_language: phrase(PARTNER_LANGUAGE),
  bulk_markers: phrase(BULK),
  org_is_sentinel: (scan) => {
    if (!isOrgSentinel(scan.message.from_org)) return { present: false };
    const org = scan.message.from_org.trim();
    return org === '' ? { present: true } : { present: true, detail: org };
  },
  body_is_negligible: (scan) => {
    const count = wordCharCount(scan.message.body.trim());
    return count < MIN_WORD_CHARS ? { present: true, detail: `${count} word characters` } : { present: false };
  },
  transport_garbage: (scan) => {
    const found = GARBAGE_MARKERS.filter(([, pattern]) => pattern.test(scan.message.body)).map(
      ([label]) => label,
    );
    return found.length === 0 ? { present: false } : { present: true, detail: found.join('; ') };
  },
};

/** Every declared signal, in declaration order, present or absent. Never a sparse list. */
export function observe(m: InboundMessage): Signal[] {
  const scan: Scan = {
    text: normalize(`${m.subject}\n${m.body}`),
    message: m,
    day: receivedDay(m.received_at),
  };
  return SIGNAL_IDS.map((id) => ({ id, ...DETECTORS[id](scan) }));
}

const HEADER = [
  'OBSERVATIONS - deterministic scan of this message. Every check is listed with its result, hit or miss,',
  'in a fixed order that carries no ranking. Quoted values come from the message; dates are ISO-normalised',
  "from the message's own timestamp. These are readings, not a verdict - no category or priority is implied.",
].join('\n');

function declarationIndex(id: string): number {
  const index = (SIGNAL_IDS as readonly string[]).indexOf(id);
  return index === -1 ? SIGNAL_IDS.length : index;
}

/**
 * The block injected into the prompt.
 *
 * It refuses a sparse list rather than rendering one. Handing the model only the signals that fired is
 * the tempting shortcut this whole layer exists to prevent, and it fails silently — the prompt still
 * looks reasonable and the model still writes confident prose. Failing loudly here is the only way the
 * symmetry rule is enforceable at all.
 */
export function renderObservations(signals: Signal[]): string {
  const missing = SIGNAL_IDS.filter((id) => !signals.some((s) => s.id === id));
  if (missing.length > 0) {
    throw new Error(
      `renderObservations: asymmetric input, missing ${missing.join(', ')}. Every declared signal must be reported, present or absent (DESIGN §5b).`,
    );
  }

  const ordered = [...signals].sort((a, b) => declarationIndex(a.id) - declarationIndex(b.id));
  const width = Math.max(...ordered.map((s) => s.id.length));
  const lines = ordered.map((s) => {
    const state = s.present ? 'present' : 'absent';
    const detail = s.detail === undefined ? '' : `  ${s.detail}`;
    return `  ${s.id.padEnd(width)}  ${state}${detail}`;
  });

  return [HEADER, ...lines].join('\n');
}
