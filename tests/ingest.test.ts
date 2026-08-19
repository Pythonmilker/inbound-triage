/**
 * The supplied file is one of the planted edge cases, so the headline assertion is a pair: a strict
 * JSON.parse of `raw/inbound.json` throws, and `loadInbound` of the same path returns all thirteen
 * messages anyway. Either half alone proves nothing — the first without the second is just a broken
 * fixture, and the second without the first would still pass if someone quietly fixed the file.
 *
 * NUL and U+FFFD are written as escapes throughout. A literal control character in a test file is
 * invisible in a diff and does not survive an editor that normalises encoding.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadInbound, repairIllegalEscapes, type LoadOutcome } from '../src/ingest/load.js';
import { contentHash } from '../src/lib/hash.js';
import type { InboundMessage } from '../src/triage/types.js';

const INBOUND = fileURLToPath(new URL('../raw/inbound.json', import.meta.url));

const NUL = '\u0000';
const REPLACEMENT = '\ufffd';

/** The message the JSON parser itself produces for a given text, so no assertion hardcodes V8 wording. */
function parserMessage(text: string): string {
  try {
    JSON.parse(text);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('this text parses cleanly; it cannot be used as an unrepairable fixture');
}

function find(messages: readonly InboundMessage[], id: string): InboundMessage {
  const found = messages.find((m) => m.id === id);
  if (!found) throw new Error(`no message ${id} in the loaded queue`);
  return found;
}

function occurrences(text: string, character: string): number {
  return text.split(character).length - 1;
}

let scratch = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'inbound-triage-ingest-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string, contents: string): string {
  const path = join(scratch, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('loading the supplied queue', () => {
  it('yields 13 messages from a file that strict JSON.parse rejects', () => {
    const raw = readFileSync(INBOUND, 'utf8');
    expect(() => JSON.parse(raw)).toThrow();

    const { messages } = loadInbound(INBOUND);

    expect(messages).toHaveLength(13);
    expect(messages.map((m) => m.id)).toEqual([
      'inb-001',
      'inb-002',
      'inb-003',
      'inb-004',
      'inb-005',
      'inb-006',
      'inb-007',
      'inb-008',
      'inb-009',
      'inb-010',
      'inb-011',
      'inb-012',
      'inb-013',
    ]);
  });

  it('reports the repair instead of hiding it', () => {
    const { parseNote } = loadInbound(INBOUND);

    expect(parseNote).not.toBeNull();
    expect(parseNote).toContain('inbound.json');
    expect(parseNote).toContain('2 illegal \\x escapes');
  });

  it('keeps a clean file silent — parseNote is null when nothing was repaired', () => {
    const path = fixture('clean.json', JSON.stringify([{ id: 'a', body: 'hello' }]));

    expect(loadInbound(path).parseNote).toBeNull();
  });
});

describe('the repair preserves the garbage it makes parseable', () => {
  it('leaves inb-011 holding real NUL characters, not the text of the escape', () => {
    const message = find(loadInbound(INBOUND).messages, 'inb-011');

    // Two NULs in, two NULs out. Stripping them would hand a clean-looking body to the layer whose whole
    // job is to rule the message unreadable, and that layer would then find nothing wrong with it.
    expect(occurrences(message.body, NUL)).toBe(2);
    expect(message.body.startsWith(NUL + NUL)).toBe(true);
    expect(message.body).not.toContain('\\x00');
    expect(occurrences(message.body, REPLACEMENT)).toBe(3);
    expect(message.body).toContain('Content-Type: multipart/alternative');
  });

  it('rewrites \\xHH to the same codepoint rather than deleting it', () => {
    const { text, repairs } = repairIllegalEscapes('["\\x41\\x00"]');

    expect(repairs).toBe(2);
    expect(JSON.parse(text)).toEqual([`A${NUL}`]);
  });

  it('does not touch an escaped backslash that happens to be followed by x', () => {
    // A global replace of /\\x../ would turn the two-character value `\x41` into the single letter `A`,
    // silently changing data it was only meant to make parseable.
    const source = '["\\\\x41"]';
    const { text, repairs } = repairIllegalEscapes(source);

    expect(repairs).toBe(0);
    expect(text).toBe(source);
    expect(JSON.parse(text)).toEqual(['\\x41']);
  });

  it('counts only the escapes it repaired', () => {
    expect(repairIllegalEscapes('["plain text", "\\u0041"]').repairs).toBe(0);
    expect(repairIllegalEscapes(readFileSync(INBOUND, 'utf8')).repairs).toBe(2);
  });
});

describe('a file the repair cannot save', () => {
  it('throws with the parser’s own message rather than returning an empty queue', () => {
    const broken = '[ { "id": "inb-001", "body": "unterminated';
    const path = fixture('broken.json', broken);

    let outcome: LoadOutcome | null = null;
    let thrown: unknown = null;
    try {
      outcome = loadInbound(path);
    } catch (error) {
      thrown = error;
    }

    // The distinction that matters: a run of zero rows looks like an empty inbox, and nobody
    // investigates an empty inbox.
    expect(outcome).toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).toContain(path);
    expect(message).toContain(parserMessage(broken));
  });

  it('says the repair ran and still did not help', () => {
    const path = fixture('broken-escapes.json', '[ { "id": "a", "body": "\\x00 and then nothing');

    expect(() => loadInbound(path)).toThrow(/even after repairing 1 illegal \\x escape\b/);
  });

  it('refuses a parseable file that is not an array of messages', () => {
    const path = fixture('object.json', '{"messages": []}');

    expect(() => loadInbound(path)).toThrow(/array of messages/);
  });

  it('stops rather than dropping a message with no usable id', () => {
    const path = fixture('no-id.json', JSON.stringify([{ id: 'a', body: 'x' }, { body: 'y' }]));

    // Twelve rows where thirteen were expected is the failure nobody notices, so the loader refuses to
    // produce it.
    expect(() => loadInbound(path)).toThrow(/index 1 has no usable id/);
  });
});

describe('the content hash that makes a re-run idempotent', () => {
  it('is stable across calls and across loads', () => {
    const first = loadInbound(INBOUND).messages;
    const second = loadInbound(INBOUND).messages;
    const message = find(first, 'inb-002');

    expect(contentHash(message)).toBe(contentHash(message));
    expect(first.map(contentHash)).toEqual(second.map(contentHash));
  });

  it('changes when the body changes, and when only the subject changes', () => {
    const message = find(loadInbound(INBOUND).messages, 'inb-002');
    const before = contentHash(message);

    expect(contentHash({ ...message, body: `${message.body} One more thing.` })).not.toBe(before);
    expect(contentHash({ ...message, subject: 'Different subject' })).not.toBe(before);
  });

  it('does not collide when text moves between fields', () => {
    const base: InboundMessage = {
      id: 'inb-100',
      received_at: '2026-07-20T09:00:00-04:00',
      channel: 'email',
      from_name: 'Ada',
      from_org: '(individual)',
      subject: 'a',
      body: 'b',
    };

    // Unprefixed concatenation would hash `subject: "a\nbody: b"` and `subject: "a"`, `body: "b"`
    // identically, which is a stale row served for edited content.
    expect(contentHash({ ...base, subject: 'a\nbody: b', body: '' })).not.toBe(contentHash(base));
  });

  it('gives every message in the supplied queue a distinct hash', () => {
    const hashes = loadInbound(INBOUND).messages.map(contentHash);

    expect(new Set(hashes).size).toBe(hashes.length);
  });
});
