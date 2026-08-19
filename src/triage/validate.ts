/**
 * Re-validation after the schema.
 *
 * A `strict` structured-output schema is a strong hint, not a guarantee: support is a property of the
 * endpoint rather than the model, and DESIGN §3 records an endpoint that advertises `response_format` and
 * returns prose with a 200 anyway. Nothing downstream may trust a field this file has not re-checked, so
 * there is no cast from the parsed payload to `ModelVerdict` outside `assembleVerdict` below.
 *
 * The length ceilings are enforced here because the JSON schema cannot express them — `maxLength` is a hard
 * 400 on some providers (schema.ts's header). Same reason the confidence range is checked here.
 */

import { FIELD_LIMITS, TRIAGE_SCHEMA } from './schema.js';
import { MODEL_CATEGORY_IDS, PRIORITY_IDS } from './types.js';
import type { Category, FailureKind, ModelVerdict, Priority } from './types.js';

/**
 * The two kinds are separated because they are fixed differently: 'truncated' means raise `max_tokens` and
 * retry the SAME model, 'unparseable' means hand the message to the NEXT model in the chain. Getting the
 * split wrong spends a chain slot on a problem a bigger cap solves (D-013c).
 */
export type ValidationFailure = Extract<FailureKind, 'unparseable' | 'truncated'>;

export type ValidationOk = { ok: true; value: ModelVerdict };

export type ValidationErr = { ok: false; failure: ValidationFailure; problems: string[] };

const REQUIRED_KEYS = TRIAGE_SCHEMA.required;

type VerdictKey = (typeof REQUIRED_KEYS)[number];

type TextField = keyof typeof FIELD_LIMITS;

const TEXT_FIELDS = Object.keys(FIELD_LIMITS) as readonly TextField[];

export function validateVerdict(raw: unknown): ValidationOk | ValidationErr {
  // A cut-off reply is only distinguishable from a malformed one while it is still text: once JSON.parse
  // has thrown, the shape of what it choked on is gone. So a string argument is scanned before it is
  // parsed, and callers should hand this function the model's raw content rather than pre-parsing it.
  if (typeof raw === 'string') return validateText(raw);
  return validateObject(raw);
}

function validateText(text: string): ValidationOk | ValidationErr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      failure: looksCutOff(text) ? 'truncated' : 'unparseable',
      problems: [`reply is not JSON: ${reason}`, `reply ends: ${quoted(tail(text))}`],
    };
  }
  return validateObject(parsed);
}

function validateObject(raw: unknown): ValidationOk | ValidationErr {
  if (!isRecord(raw)) {
    return {
      ok: false,
      failure: 'unparseable',
      problems: [`reply is not a JSON object (got ${quoted(raw)})`],
    };
  }

  const problems: string[] = [];
  let violated = false;
  const violation = (message: string): void => {
    problems.push(message);
    violated = true;
  };

  const missing = REQUIRED_KEYS.filter((key) => raw[key] === undefined);
  const cutOffAt = truncationPoint(raw, missing);
  if (cutOffAt !== null) {
    problems.push(`"${cutOffAt}" is empty and nothing after it arrived — the reply stops mid-value`);
  }
  for (const key of missing) {
    const message = `missing required key "${key}"`;
    if (cutOffAt === null) violation(message);
    else problems.push(message);
  }

  /*
   * A key the schema never declared is a rejection, not something to ignore.
   *
   * The schema sets `additionalProperties: false`, so a compliant provider cannot send one — which means
   * an extra key is evidence that the schema was not enforced on this reply at all. That is the exact
   * silent failure this layer exists to catch: the endpoint ignored `response_format` and answered from
   * the prompt instead. Dropping the unknown key and accepting the rest would let a completely
   * unconstrained reply through whenever it happened to contain the right field names.
   */
  const undeclared = Object.keys(raw).filter(
    (key) => !(REQUIRED_KEYS as readonly string[]).includes(key),
  );
  for (const key of undeclared) {
    violation(`unexpected key "${key}" — the schema declares additionalProperties: false`);
  }

  const draft: Partial<ModelVerdict> = {};

  // A near-miss is a failure, not a value to fix. Mapping "High" onto `high` or "existing-client" onto
  // `existing_client` would hide a real prompt problem behind a verdict that reads as clean.
  const category = raw['category'];
  if (category !== undefined) {
    if (isCategory(category)) draft.category = category;
    else violation(`category ${quoted(category)} is not one of: ${MODEL_CATEGORY_IDS.join(', ')}`);
  }

  const priority = raw['priority'];
  if (priority !== undefined) {
    if (isPriority(priority)) draft.priority = priority;
    else violation(`priority ${quoted(priority)} is not one of: ${PRIORITY_IDS.join(', ')}`);
  }

  // Confidence clamps where the text fields do not: 1.04 is a formatting slip that loses no information,
  // whereas an over-long summary means the model ignored "one sentence" and trimming it would hide that.
  const confidence = raw['confidence'];
  if (confidence !== undefined) {
    if (typeof confidence === 'number' && Number.isFinite(confidence)) {
      draft.confidence = Math.min(1, Math.max(0, confidence));
    } else {
      violation(`confidence ${quoted(confidence)} is not a finite number`);
    }
  }

  for (const field of TEXT_FIELDS) {
    const value = raw[field];
    if (value === undefined || field === cutOffAt) continue;
    if (typeof value !== 'string') {
      violation(`${field} ${quoted(value)} is not a string`);
      continue;
    }
    // All three fields are specified as one line, so a wrapped value is normalised rather than rejected.
    const single = value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (single === '') {
      violation(`${field} is empty`);
      continue;
    }
    const limit = FIELD_LIMITS[field];
    if (single.length > limit) {
      violation(`${field} is ${single.length} characters, over the ${limit}-character limit`);
      continue;
    }
    draft[field] = single;
  }

  if (problems.length === 0) {
    const value = assembleVerdict(draft);
    if (value !== null) return { ok: true, value };
    // Unreachable while every key of ModelVerdict is checked above; it stops a field added to the type
    // later from reaching a caller unvalidated.
    problems.push(`validated fields do not cover every key of the verdict: ${REQUIRED_KEYS.join(', ')}`);
    return { ok: false, failure: 'unparseable', problems };
  }

  // Positive cut-off evidence only wins when everything that did arrive was well formed. If the reply
  // already violates the contract, a bigger token cap will not change that.
  return { ok: false, failure: cutOffAt !== null && !violated ? 'truncated' : 'unparseable', problems };
}

/**
 * Truncation evidence in an already-parsed payload: a text field present but empty with every later field
 * absent is a reply that stopped while that value was being written. Returns the field it stopped on.
 */
function truncationPoint(
  raw: Record<string, unknown>,
  missing: readonly VerdictKey[],
): TextField | null {
  const first = missing[0];
  if (first === undefined) return null;
  const firstIndex = REQUIRED_KEYS.indexOf(first);
  if (firstIndex <= 0) return null;
  // Anything other than a clean suffix of the field order is a shape problem, not a stopping point.
  if (missing.length !== REQUIRED_KEYS.length - firstIndex) return null;
  const previous = REQUIRED_KEYS[firstIndex - 1];
  if (previous === undefined || !isTextField(previous)) return null;
  const value = raw[previous];
  return typeof value === 'string' && value.trim() === '' ? previous : null;
}

/**
 * Whether a reply that failed JSON.parse failed because it was cut off. Prose that never opened an object
 * is a different problem entirely, so the scan only reports truncation for text that started one and left
 * a string or a container open.
 */
function looksCutOff(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
  }
  return inString || escaped || depth > 0;
}

function assembleVerdict(draft: Partial<ModelVerdict>): ModelVerdict | null {
  const { summary, evidence, category, priority, next_action, confidence } = draft;
  if (
    summary === undefined ||
    evidence === undefined ||
    category === undefined ||
    priority === undefined ||
    next_action === undefined ||
    confidence === undefined
  ) {
    return null;
  }
  return { summary, evidence, category, priority, next_action, confidence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A category the MODEL is allowed to assign — deliberately narrower than every category that exists. The
 * schema already refuses the machine-decided ones, and this re-checks it: a provider that ignores the enum
 * must not slip a label past us that the design settled before the call was made.
 */
function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (MODEL_CATEGORY_IDS as readonly string[]).includes(value);
}

function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITY_IDS as readonly string[]).includes(value);
}

function isTextField(key: VerdictKey): key is TextField {
  return (TEXT_FIELDS as readonly string[]).includes(key);
}

function tail(text: string): string {
  const end = text.trimEnd();
  return end.length > 60 ? `…${end.slice(-60)}` : end;
}

/** Quotes a value so a problem string can be read back verbatim in the UI. */
function quoted(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
  }
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value;
}

/**
 * Words that grade the PERSON rather than describing the message. A summary should say what someone asked
 * for; "a promising high-value prospect" is a sales appraisal the tool has no standing to make, and it is
 * the kind of line a reader trusts because it sounds decisive.
 *
 * Boundaries are explicit on both ends so a bare pattern cannot fire inside an unrelated compound —
 * `\bvaluable\b` does not match "invaluable" — and the multi-word terms take a space or a hyphen because
 * models write both. No `g` flag: these are module-level, and a sticky `lastIndex` would make each result
 * depend on the previous call.
 */
const APPRAISAL_PATTERNS: readonly RegExp[] = [
  /\bpromising\b/i,
  /\bunpromising\b/i,
  /\bvaluable\b/i,
  /\bhigh[\s-]+valued?\b/i,
  /\blow[\s-]+valued?\b/i,
  /\bworthless\b/i,
  /\bdifficult\b/i,
  /\bunreasonable\b/i,
  /\bdemanding\b/i,
  /\bpushy\b/i,
  /\brude\b/i,
  /\bentitled\b/i,
  /\bimpatient\b/i,
  /\bannoying\b/i,
  /\bincompetent\b/i,
  /\btime[\s-]?waster\b/i,
  /\btime[\s-]?wasting\b/i,
  /\btyre?[\s-]?kicker\b/i,
  /\bimportant[\s-]+(?:client|clients|prospect|prospects|customer|contact|sender|person|people)\b/i,
  /\bworth[\s-]+(?:pursuing|chasing|(?:your|our|the)[\s-]+time)\b/i,
];

/**
 * Returns the offending word, as written, when the text appraises the sender instead of describing what
 * they wrote — otherwise null. Deliberately NOT called by `validateVerdict`: a graded summary is a prompt
 * problem to surface, not a schema violation, and the caller decides what to do about it.
 */
export function gradesTheSender(text: string): string | null {
  // Earliest offender in the text wins, ties broken by declaration order, so the result is stable.
  let found: { index: number; word: string } | null = null;
  for (const pattern of APPRAISAL_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    if (found === null || match.index < found.index) found = { index: match.index, word: match[0] };
  }
  return found === null ? null : found.word;
}
