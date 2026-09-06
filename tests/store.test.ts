/**
 * The store, against a real SQLite file rather than an in-memory database.
 *
 * A file is the configuration the app actually ships: it exercises the mkdir, the WAL pragma and the
 * STRICT tables on disk, and it is the only way to corrupt a column behind the store's back — which is
 * how the `attempts` blob gets tested for the property that matters, that a bad attempt log costs one
 * row's history and not the whole listing the user is looking at.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contentHash } from '../src/triage/hash.js';
import { createSqliteStore } from '../src/store/sqlite.js';
import type { Store } from '../src/store/types.js';
import type { Attempt, InboundMessage, TriageResult } from '../src/triage/types.js';

let dir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inbound-triage-store-'));
  // A nested path on purpose: the store creates its own directory, and `data/` never exists in a clone.
  dbPath = join(dir, 'data', 'triage.db');
  store = createSqliteStore(dbPath);
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const MESSAGE: InboundMessage = {
  id: 'inb-002',
  received_at: '2026-07-20T10:02:00-04:00',
  channel: 'web-form',
  from_name: 'Dana Whitfield',
  from_org: '(individual)',
  subject: 'Need updated statement by Friday',
  body: "I'm an existing client and my mortgage lender needs an updated portfolio statement by this Friday.",
};

const ATTEMPTS: Attempt[] = [
  {
    model: 'meta-llama/llama-3.1-8b-instruct',
    at: '2026-07-21T12:00:00.000Z',
    ok: false,
    failure: 'unparseable',
    httpStatus: 200,
    detail: 'returned prose, not JSON',
  },
  { model: 'openai/gpt-4.1-nano', at: '2026-07-21T12:00:04.000Z', ok: true },
];

/**
 * Typed as `TriageResult` rather than inferred, so a field added to the interface fails to compile here
 * until this fixture — and therefore the round trip — covers it.
 */
const TRIAGED: TriageResult = {
  message_id: MESSAGE.id,
  content_hash: contentHash(MESSAGE),
  status: 'triaged',
  category: 'existing_client',
  priority: 'high',
  summary: 'An existing client needs an updated portfolio statement for a lender by Friday.',
  next_action: 'Send the statement to the client today.',
  confidence: 0.82,
  source: 'reconciled',
  reason: null,
  reconciliation_note:
    "Priority raised to high from the model's medium: the rules matched explicit deadline.",
  attempts: ATTEMPTS,
  updated_at: '2026-07-21T12:00:04.000Z',
};

/** What a failed call may write: the failure and the count, and nothing it cannot stand behind. */
const PENDING: TriageResult = {
  message_id: 'inb-003',
  content_hash: 'a1b2c3d4e5f60718',
  status: 'pending_retry',
  category: null,
  priority: null,
  summary: null,
  next_action: null,
  confidence: null,
  source: null,
  reason: null,
  reconciliation_note: null,
  attempts: [
    {
      model: 'meta-llama/llama-3.1-8b-instruct',
      at: '2026-07-21T12:00:00.000Z',
      ok: false,
      failure: 'unfunded',
      httpStatus: 402,
      detail: '{"error":{"message":"insufficient credits"}}',
    },
  ],
  updated_at: '2026-07-21T12:00:00.000Z',
};

/** Rewrites the one column SQLite cannot type-check, behind the store's back. */
function corruptAttempts(messageId: string, blob: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const changed = db
      .prepare('UPDATE triage_results SET attempts = :attempts WHERE message_id = :id')
      .run({ attempts: blob, id: messageId });
    if (Number(changed.changes) !== 1) {
      throw new Error(`expected to rewrite one row, rewrote ${String(changed.changes)}`);
    }
  } finally {
    db.close();
  }
}

/** Closes the store, mutates the file, and hands back a store reading the same file. */
async function reopenAfter(mutate: () => void): Promise<void> {
  await store.close();
  mutate();
  store = createSqliteStore(dbPath);
}

describe('results', () => {
  it('round-trips every field, attempts included', async () => {
    await store.saveResult(TRIAGED);

    const read = await store.getResult(TRIAGED.message_id);
    expect(read).toEqual(TRIAGED);
    expect(read?.attempts).toEqual(ATTEMPTS);
    expect(await store.listResults()).toEqual([TRIAGED]);
  });

  it('round-trips a failed row with no verdict asserted', async () => {
    await store.saveResult(PENDING);

    const read = await store.getResult(PENDING.message_id);
    expect(read).toEqual(PENDING);
    // D-011b, stored as written: category and priority stay null rather than borrowing the rule floor's.
    expect(read?.category).toBeNull();
    expect(read?.priority).toBeNull();
    expect(read?.attempts[0]?.failure).toBe('unfunded');
    expect(read?.attempts[0]?.httpStatus).toBe(402);
  });

  it('returns null for a message that has never been triaged', async () => {
    expect(await store.getResult('inb-999')).toBeNull();
  });

  it('upserts on message_id instead of duplicating the row', async () => {
    await store.saveResult(PENDING);
    const drained: TriageResult = {
      ...PENDING,
      status: 'triaged',
      category: 'junk',
      priority: 'low',
      summary: 'A vendor is pitching analytics software.',
      next_action: 'Decline, or route to operations.',
      confidence: 0.74,
      source: 'model',
      attempts: [
        ...PENDING.attempts,
        { model: 'openai/gpt-4.1-nano', at: '2026-07-21T12:05:00.000Z', ok: true },
      ],
      updated_at: '2026-07-21T12:05:00.000Z',
    };
    await store.saveResult(drained);

    const all = await store.listResults();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(drained);
    expect(all[0]?.attempts).toHaveLength(2);
  });

  it('orders listResults by message id, so two runs render identically', async () => {
    await store.saveResult(TRIAGED);
    await store.saveResult(PENDING);
    await store.saveResult({ ...PENDING, message_id: 'inb-001' });

    expect((await store.listResults()).map((row) => row.message_id)).toEqual([
      'inb-001',
      'inb-002',
      'inb-003',
    ]);
  });
});

describe('idempotence', () => {
  it('hands back a stored hash to compare, and it moves only when the message does', async () => {
    // The store deliberately does not decide this — `getResult` returns the stored hash and the caller
    // compares. What is asserted here is that the comparison is possible and answers correctly: an
    // untouched message matches the row it produced, so no model call is spent, and an edited one does
    // not, so it is triaged again. tests/engine.test.ts counts the calls that follow from each.
    await store.saveResult(TRIAGED);

    const stored = await store.getResult(MESSAGE.id);
    expect(stored?.content_hash).toBe(contentHash(MESSAGE));
    expect(stored?.status).toBe('triaged');

    const edited: InboundMessage = {
      ...MESSAGE,
      body: `${MESSAGE.body} Actually, make it Thursday.`,
    };
    expect(contentHash(edited)).not.toBe(stored?.content_hash);

    // Re-triaging the edited message replaces the row rather than adding a second one for the same id.
    await store.saveResult({
      ...TRIAGED,
      content_hash: contentHash(edited),
      summary: 'Now Thursday.',
    });
    const after = await store.listResults();
    expect(after).toHaveLength(1);
    expect(after[0]?.content_hash).toBe(contentHash(edited));
  });

  it('gives the same hash for the same content across store instances', async () => {
    await store.saveResult(TRIAGED);
    await reopenAfter(() => undefined);

    expect((await store.getResult(MESSAGE.id))?.content_hash).toBe(contentHash(MESSAGE));
  });
});

describe('a corrupt attempts blob', () => {
  it('yields an empty array and leaves the rest of the row readable', async () => {
    await store.saveResult(TRIAGED);
    await reopenAfter(() => corruptAttempts(TRIAGED.message_id, 'not json at all'));

    const read = await store.getResult(TRIAGED.message_id);
    // The listing is the surface the user is looking at. Throwing here would take all thirteen rows
    // down over one bad column, so the history is what is lost, not the verdict.
    expect(read).not.toBeNull();
    expect(read?.attempts).toEqual([]);
    expect(read?.category).toBe('existing_client');
    expect(read?.summary).toBe(TRIAGED.summary);
    expect(await store.listResults()).toHaveLength(1);
  });

  it('yields an empty array when the blob is valid JSON but not an array', async () => {
    await store.saveResult(TRIAGED);
    await reopenAfter(() =>
      corruptAttempts(TRIAGED.message_id, '{"model":"one attempt, unwrapped"}'),
    );

    expect((await store.getResult(TRIAGED.message_id))?.attempts).toEqual([]);
  });

  it('drops only the entries that are not attempts', async () => {
    await store.saveResult(TRIAGED);
    const good = ATTEMPTS[1];
    if (good === undefined) throw new Error('the fixture needs a well-formed attempt');
    await reopenAfter(() =>
      corruptAttempts(
        TRIAGED.message_id,
        JSON.stringify([{ model: 42, at: null }, null, 'nope', good]),
      ),
    );

    expect((await store.getResult(TRIAGED.message_id))?.attempts).toEqual([good]);
  });
});

describe('the retry queue', () => {
  it('lists pending rows only', async () => {
    await store.saveResult(TRIAGED);
    await store.saveResult(PENDING);
    await store.saveResult({ ...PENDING, message_id: 'inb-009' });

    const pending = await store.listPendingRetry();
    expect(pending.map((row) => row.message_id)).toEqual(['inb-003', 'inb-009']);
    expect(pending.every((row) => row.status === 'pending_retry')).toBe(true);
  });

  it('empties as rows are drained', async () => {
    await store.saveResult(PENDING);
    expect(await store.listPendingRetry()).toHaveLength(1);

    await store.saveResult({
      ...PENDING,
      status: 'triaged',
      category: 'junk',
      priority: 'low',
      source: 'model',
    });
    expect(await store.listPendingRetry()).toEqual([]);
  });
});

/**
 * Built with `fromCharCode` rather than as escapes so this file stays plain text: a source file with a
 * real NUL byte in it reads as binary to grep, to a diff viewer, and to tests/no-secrets.test.ts.
 */
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe('messages', () => {
  it('round-trips a body carrying the NUL characters the supplied file smuggles in', async () => {
    // `inb-011` carries two illegal `\x00` escapes that the loader rewrites to legal NUL characters, so real
    // NUL characters reach the store. If SQLite truncated the value at the first one, the garbled
    // message would arrive with an empty body and be ruled unreadable for the wrong reason.
    const garbled: InboundMessage = {
      id: 'inb-011',
      received_at: '2026-07-20T16:44:00-04:00',
      channel: 'email',
      from_name: '=?utf-8?B?',
      from_org: '(unknown)',
      subject: 'RE: RE: FWD:',
      body: `${NUL}${NUL} ${REPLACEMENT}${REPLACEMENT}${REPLACEMENT} --- forwarded message truncated ---`,
    };
    await store.saveMessages([garbled]);

    const read = await store.listMessages();
    expect(read).toEqual([garbled]);
    expect(read[0]?.body).toBe(garbled.body);
  });

  it('upserts by id in inbox order', async () => {
    const later: InboundMessage = {
      ...MESSAGE,
      id: 'inb-013',
      received_at: '2026-07-20T17:52:00-04:00',
    };
    await store.saveMessages([later, MESSAGE]);
    await store.saveMessages([{ ...MESSAGE, subject: 'Edited subject' }]);

    const read = await store.listMessages();
    expect(read.map((m) => m.id)).toEqual(['inb-002', 'inb-013']);
    expect(read[0]?.subject).toBe('Edited subject');
  });
});

describe('close', () => {
  it('is not an error to call twice', async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
    store = createSqliteStore(dbPath);
  });
});

describe('a database created under an older taxonomy', () => {
  /**
   * The bug this covers was found by running the app, not by the suite — and the suite could not have found
   * it, because every other test here starts from a fresh file. `CREATE TABLE IF NOT EXISTS` leaves an
   * existing database's CHECK constraints exactly as they were written, so after a category was renamed
   * every write of the new label failed with `CHECK constraint failed` on any machine that had run the app
   * once. A reviewer's second run would have been the first time anyone saw it.
   */
  it('is rebuilt rather than left enforcing an enum that no longer exists', async () => {
    const stalePath = join(dir, 'stale.db');
    const stale = new DatabaseSync(stalePath);
    stale.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, received_at TEXT NOT NULL, channel TEXT NOT NULL,
        from_name TEXT NOT NULL, from_org TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL
      ) STRICT;
      CREATE TABLE triage_results (
        message_id TEXT PRIMARY KEY,
        category TEXT CHECK (category IS NULL OR category IN ('prospect', 'noise', 'unreadable'))
      ) STRICT;
      PRAGMA user_version = 12345;
    `);
    stale.close();

    const reopened = createSqliteStore(stalePath);
    const message: InboundMessage = {
      id: 'inb-x',
      received_at: '2026-07-20T09:00:00-04:00',
      channel: 'email',
      from_name: 'A',
      from_org: '(individual)',
      subject: 's',
      body: 'b',
    };
    await reopened.saveMessages([message]);

    const row: TriageResult = {
      message_id: 'inb-x',
      content_hash: contentHash(message),
      status: 'triaged',
      category: 'junk',
      priority: 'low',
      summary: 'machine-sent',
      next_action: 'delete',
      confidence: 0.83,
      source: 'rules',
      reason: null,
      reconciliation_note: null,
      attempts: [],
      updated_at: '2026-08-19T09:00:00.000Z',
    };
    // `junk` is not in the stale constraint. Before the rebuild this rejected and the row was lost.
    await expect(reopened.saveResult(row)).resolves.toBeUndefined();
    expect((await reopened.listResults()).map((r) => r.category)).toEqual(['junk']);
    await reopened.close();
  });
});
