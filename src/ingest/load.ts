/**
 * Reading the queue off disk, with one repair.
 *
 * `raw/inbound.json` is malformed at the FILE level, not just the item level: `inb-011`'s body carries two
 * literal `\x00` escapes, which JSON does not define, so a strict `JSON.parse` of the whole file fails at
 * position 3329 — before any per-item check can run, and yielding no messages at all rather than twelve good
 * ones. So the loader reads text, rewrites the illegal escapes to the equivalent legal `\u00HH`, then parses.
 *
 * Repairing here rather than editing the data is the decision. Fixing the fixture by hand would have been
 * quicker and would have destroyed the malformed message the tool is supposed to survive.
 *
 * WHERE THIS COMES FROM IN A REAL SYSTEM, because it is not a quirk of one fixture. A sender cannot put
 * `\x00` into JSON; they have no access to the file. What they control is the bytes of a message body: a
 * NUL, a truncated MIME forward, an attachment mangled inline. Something then has to serialise that body
 * into JSON, and a correct serialiser writes `\u0000`. A naive one emits `\x00`, which is valid JavaScript and
 * invalid JSON, and the file is broken. The sender is the trigger; the ingestion layer is the defect.
 *
 * Which makes this a denial of service rather than an oddity: without the repair, ONE sender's message makes
 * the whole queue unparseable and the run yields zero rows, not twelve good ones and one bad one. NUL bytes
 * in a user-controlled field are a well-worn truncation and injection vector, so a hostile sender would
 * reach for exactly this. The real fix belongs upstream in whatever writes the file; this is defence against
 * a producer we do not control.
 *
 * The NUL characters survive that rewrite on purpose. Same codepoint, legal syntax: stripping them here
 * would hide the garbage from the layer whose job it is to call the message unreadable.
 *
 * Nothing here classifies anything. Deciding a message has nothing checkable in it belongs to the rules
 * layer, which owns `UnreadableReason`. Ingest loads, repairs, and says so.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { InboundMessage } from '../triage/types.js';

export interface LoadOutcome {
  messages: InboundMessage[];
  /** A sentence for the run to display when the file needed repair. `null` when it parsed clean. */
  parseNote: string | null;
}

export function loadInbound(filePath: string): LoadOutcome {
  const source = readFileSync(filePath, 'utf8');
  const { text, repairs } = repairIllegalEscapes(source);

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    const parserSaid = err instanceof Error ? err.message : String(err);
    const after =
      repairs > 0 ? ` even after repairing ${count(repairs, 'illegal \\x escape')}` : '';
    throw new Error(`Could not parse ${filePath}${after}. The JSON parser said: ${parserSaid}`);
  }

  if (!Array.isArray(root)) {
    throw new Error(
      `Expected ${filePath} to hold a JSON array of messages, found ${describe(root)}.`,
    );
  }
  const items: unknown[] = root;

  const messages = items.map((item, index) => toMessage(item, index, filePath));

  const parseNote =
    repairs === 0
      ? null
      : `${basename(filePath)} was not valid JSON: ${count(repairs, 'illegal \\x escape')} rewritten as \\u00HH before parsing. The characters they encode are unchanged.`;

  return { messages, parseNote };
}

/**
 * Rewrites `\xHH` to `\u00HH` inside JSON string literals. Exported because this, not the file read, is the
 * part worth testing directly.
 *
 * It walks the text rather than running one global replace, because a global replace would also match the
 * `\x` in a legitimately escaped backslash (`\\x41`, meaning backslash-x-4-1) and silently turn that value
 * into the character `A`. Escapes other than `\xHH` pass through untouched, including `\\`, which consumes
 * the character after it so that character can never be read as starting an escape.
 */
export function repairIllegalEscapes(source: string): { text: string; repairs: number } {
  let out = '';
  let repairs = 0;
  let inString = false;
  let i = 0;

  while (i < source.length) {
    const ch = source.charAt(i);

    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '\\') {
      const next = source.charAt(i + 1);
      const hex = source.slice(i + 2, i + 4);
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(hex)) {
        out += `\\u00${hex}`;
        repairs += 1;
        i += 4;
        continue;
      }
      out += ch + next;
      i += 2;
      continue;
    }

    if (ch === '"') inString = false;
    out += ch;
    i += 1;
  }

  return { text: out, repairs };
}

/**
 * Shape validation only. A missing `id` throws rather than dropping the item: a message we cannot key or
 * hash is not a message we can quietly lose, and a run that silently returns twelve of thirteen rows is the
 * failure nobody notices.
 */
function toMessage(item: unknown, index: number, filePath: string): InboundMessage {
  const record = asRecord(item);
  if (record === null) {
    throw new Error(
      `${filePath} item at index ${index} is ${describe(item)}, not a message object. Fix the source rather than dropping the item.`,
    );
  }

  // The id alone is not coerced: it is the primary key everything downstream joins on, so a number or an
  // object there is a source defect to report, not a value to invent a string for. Trimmed because a stray
  // space would open a second row for one message. Every other field is kept verbatim, including a body
  // that is nothing but punctuation.
  const rawId = record['id'];
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (id === '') {
    throw new Error(
      `${filePath} item at index ${index} has no usable id (found ${describe(rawId)}). Every message needs a non-empty string id; loading stopped rather than dropping it.`,
    );
  }

  return {
    id,
    received_at: coerceToString(record['received_at']),
    channel: coerceToString(record['channel']),
    from_name: coerceToString(record['from_name']),
    from_org: coerceToString(record['from_org']),
    subject: coerceToString(record['subject']),
    body: coerceToString(record['body']),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Missing becomes `''`; anything else becomes its text, so a wrong type is visible instead of lost. */
function coerceToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  const kind = typeof value;
  return `${'aeiou'.includes(kind.charAt(0)) ? 'an' : 'a'} ${kind}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
