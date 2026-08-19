/**
 * The observation layer: what the text demonstrably contains, reported as an instrument reading.
 *
 * SYMMETRY IS THE POINT. `observe` returns an entry for every declared signal, present or absent, and
 * `renderObservations` prints the misses beside the hits in a fixed order with no emphasis on either. A
 * list of only-what-fired — or one ordered by importance — is a suggested answer in disguise, and a
 * suggestion drags a small model toward it while its prose still reads as independent reasoning
 * (DESIGN §5b). The model receives readings. It never receives the rules' verdict.
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
  'prospect_language',
  'explicit_deadline',
  'complaint_language',
  'selling_language',
  'recruiting_language',
  'referral_language',
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
const PROSPECT_LANGUAGE: readonly RegExp[] = [
  /\blooking\s+for\s+(?:help|advice|guidance|comprehensive|an?\s+advisor|someone)\b/i,
  /\bwho\s+should\s+i\s+(?:speak|talk)\s+(?:with|to)\b/i,
  /\bwhat'?s\s+your\s+(?:account\s+)?minimum\b/i,
  /\byour\s+(?:account\s+)?minimums?\b/i,
  /\bhow\s+(?:do|does|are)\s+(?:your\s+)?fees?\s+work\b/i,
  /\bwork(?:ing)?\s+with\s+an\s+advisor\b/i,
  /\b(?:intro|introductory|initial)\s+(?:call|meeting|conversation|consultation)\b/i,
  /\bnot\s+(?:yet\s+)?a\s+client\b/i,
  /\bconsidering\s+(?:whether|hiring|engaging|working)\b/i,
  /\bexploring\s+(?:options|advisors|firms)\b/i,
  /\bgathering\s+information\b/i,
  /\btak(?:e|ing)\s+on\s+new\s+clients\b/i,
];

/**
 * A date, day or deadline expression. Urgency claims ("asap", "time-sensitive") are deliberately NOT
 * here: priority is deadline and money at risk, never tone (DESIGN §4.2), and a bare urgency claim is
 * the sender's adjective rather than a date.
 *
 * Order is specificity, not importance — the first match becomes the quoted detail, so the forms an ISO
 * date can be derived from are tried first. A bare weekday is deliberately absent: it fires on "Your
 * Monday market digest", where no deadline exists.
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
  /\bthis\s+(?:morning|afternoon|evening|week)\b/i,
  /\bnext\s+week\b/i,
  // Last of the phrase-yielding forms: "deadline is next Friday" should quote the day, not the noun.
  /\b(?:deadline|due\s+date)\b/i,
  /\bwithin\s+(?:the\s+next\s+)?\d+\s+(?:hours?|days?|weeks?)\b/i,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
];

/** Dissatisfaction about a charge or a service. */
const COMPLAINT: readonly RegExp[] = [
  /\b(?:don'?t|do\s+not|didn'?t)\s+understand\b/i,
  /\b(?:not\s+happy|unhappy|disappointed|frustrat(?:ed|ing)|unacceptable)\b/i,
  // "frankly" was here and is deliberately gone: it is a discourse marker, not dissatisfaction.
  // "Frankly, this looks great" is not a complaint, and priority is defined by deadline and money at
  // risk rather than register. The one complaint in the sample fixture still matches twice without it
  // ("don't understand" and "not happy"), so nothing is lost by dropping it.
  /\bcomplain(?:t|ing|ts)?\b/i,
  /\b(?:unexpected|surprise|unexplained|duplicate)\s+(?:fee|charge|billing)\b/i,
  /\b(?:fee|charge|billing)\s+(?:dispute|error|issue|question)\b/i,
  /\bwhy\s+(?:was|am)\s+i\s+(?:charged|billed)\b/i,
  /\bthis\s+is\s+not\s+(?:acceptable|right|what)\b/i,
  /\bshouldn'?t\s+have\s+been\s+(?:charged|billed)\b/i,
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

/** A peer proposing a referral or partnership, rather than buying or selling. */
const REFERRAL: readonly RegExp[] = [
  /\breferral\s+(?:arrangement|partnership|relationship|agreement|fee|program)\b/i,
  /\brefer(?:red|ring)\s+(?:by|to\s+you)\b/i,
  /\bsuggested\s+i\s+(?:reach\s+out|contact|get\s+in\s+touch|call)\b/i,
  /\b(?:explore|discuss)\s+a\s+(?:referral|partnership)\b/i,
  /\bpartnership\b/i,
  /\boutside\s+(?:our|my)\s+(?:scope|expertise)\b/i,
  /\bi\s+run\s+a\s+(?:small\s+)?(?:ria|firm|practice)\b/i,
  /\bmutual\s+clients?\b/i,
  /\bwhite[-\s]?label\b/i,
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

const DETECTORS: Record<SignalId, Detector> = {
  self_identified_client: phrase(SELF_IDENTIFIED_CLIENT),
  prospect_language: phrase(PROSPECT_LANGUAGE),
  explicit_deadline: (scan) => {
    const hit = matchPhrase(scan.text, DEADLINE);
    if (hit === undefined) return { present: false };
    const iso = deriveIsoDate(hit, scan.day);
    return { present: true, detail: iso === undefined || iso === hit ? hit : `${hit} -> ${iso}` };
  },
  complaint_language: phrase(COMPLAINT),
  selling_language: phrase(SELLING),
  recruiting_language: phrase(RECRUITING),
  referral_language: phrase(REFERRAL),
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
