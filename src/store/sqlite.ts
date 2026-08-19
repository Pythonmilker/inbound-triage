/**
 * The only Store implementation that ships (D-010: one store, no fallback).
 *
 * `node:sqlite` is built in, so there is nothing to install and no native module to compile — a failed
 * native build on a fresh clone is exactly the failure a new user would hit. It needs Node >= 22.13.0,
 * which is declared in `engines` and checked by the dev preflight; the requirement is stated, not
 * cushioned with a second code path.
 *
 * Two tables, `messages` and `triage_results`. There is no `parked` table: an unreadable message is an
 * ordinary result row with category `unreadable` (D-011), so there is no second surface to go and find.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import {
  CATEGORY_IDS,
  PRIORITY_IDS,
  type Attempt,
  type Category,
  type FailureKind,
  type InboundMessage,
  type Priority,
  type TriageResult,
  type TriageStatus,
  type UnreadableReason,
  type VerdictSource,
} from '../triage/types.js';
import type { Store } from './types.js';

/** Typed so renaming the status in types.ts breaks the build rather than silently emptying the queue. */
const PENDING_RETRY: TriageStatus = 'pending_retry';

/**
 * The unions repeated as record keys rather than as arrays: adding a member in types.ts without adding it
 * here is a compile error, so the CHECK constraints below cannot drift away from the taxonomy *in source*.
 *
 * That is not the same as not drifting on disk, and the difference was a real bug. `CREATE TABLE IF NOT
 * EXISTS` leaves an existing file's constraints exactly as they were written, so a database created before
 * a taxonomy change keeps enforcing the old enum forever. Renaming a category made every write of the new
 * label fail with `CHECK constraint failed` — invisible to the whole test suite, because each test starts
 * from a fresh database, and immediate for anyone who had run the app once. See `applySchema` below.
 */
const STATUSES: Record<TriageStatus, true> = { triaged: true, pending_retry: true };
const SOURCES: Record<VerdictSource, true> = { model: true, rules: true, reconciled: true };
const REASONS: Record<UnreadableReason, true> = {
  'empty-body': true,
  garbled: true,
  'no-id': true,
  'below-threshold': true,
};
const FAILURE_KINDS: Record<FailureKind, true> = {
  no_key: true,
  key_rejected: true,
  unfunded: true,
  rate_limited: true,
  timeout: true,
  server_error: true,
  network: true,
  unparseable: true,
  truncated: true,
};

/** DDL cannot take bound parameters. Every value passed here is an internal literal, never input. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * `STRICT` plus the enum CHECKs mirror what TypeScript already guarantees at every call site, so they can
 * only fire on a hand-edited or corrupted file — which is why they are safe to add.
 *
 * Deliberately NOT a constraint: the D-011b coupling that a `pending_retry` row asserts no verdict.
 * `TriageResult` permits that combination, so enforcing it here would turn another module's bug into a
 * failed run instead of a visible row.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  channel     TEXT NOT NULL,
  from_name   TEXT NOT NULL,
  from_org    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS triage_results (
  message_id          TEXT PRIMARY KEY,
  content_hash        TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (${sqlList(Object.keys(STATUSES))})),
  category            TEXT CHECK (category IS NULL OR category IN (${sqlList(CATEGORY_IDS)})),
  priority            TEXT CHECK (priority IS NULL OR priority IN (${sqlList(PRIORITY_IDS)})),
  summary             TEXT,
  next_action         TEXT,
  confidence          REAL,
  source              TEXT CHECK (source IS NULL OR source IN (${sqlList(Object.keys(SOURCES))})),
  reason              TEXT CHECK (reason IS NULL OR reason IN (${sqlList(Object.keys(REASONS))})),
  reconciliation_note TEXT,
  attempts            TEXT NOT NULL DEFAULT '[]',
  updated_at          TEXT NOT NULL
) STRICT;
`;

function readText(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function readNullableText(value: SQLOutputValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function readNullableNumber(value: SQLOutputValue | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

function toAttempt(value: unknown): Attempt | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.model !== 'string' || typeof raw.at !== 'string' || typeof raw.ok !== 'boolean') {
    return null;
  }
  const attempt: Attempt = { model: raw.model, at: raw.at, ok: raw.ok };
  // The cast is guarded by membership in FAILURE_KINDS, whose keys are exactly FailureKind.
  if (typeof raw.failure === 'string' && raw.failure in FAILURE_KINDS) {
    attempt.failure = raw.failure as FailureKind;
  }
  if (typeof raw.httpStatus === 'number') attempt.httpStatus = raw.httpStatus;
  if (typeof raw.detail === 'string') attempt.detail = raw.detail;
  return attempt;
}

/**
 * `attempts` is the one column SQLite cannot type-check for us, so it is the one column validated on read.
 * A corrupt or half-written value yields an empty array and leaves the rest of the row usable: a bad
 * attempt log must not take down the whole listing, which is the surface the user is looking at.
 */
function readAttempts(value: SQLOutputValue | undefined): Attempt[] {
  if (typeof value !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: unknown[] = parsed;
  return entries.flatMap((entry) => toAttempt(entry) ?? []);
}

function toMessage(row: Record<string, SQLOutputValue>): InboundMessage {
  return {
    id: readText(row.id),
    received_at: readText(row.received_at),
    channel: readText(row.channel),
    from_name: readText(row.from_name),
    from_org: readText(row.from_org),
    subject: readText(row.subject),
    body: readText(row.body),
  };
}

/** The enum casts are backed by the CHECK constraints above, not assumed here. */
function toResult(row: Record<string, SQLOutputValue>): TriageResult {
  return {
    message_id: readText(row.message_id),
    content_hash: readText(row.content_hash),
    status: readText(row.status) as TriageStatus,
    category: readNullableText(row.category) as Category | null,
    priority: readNullableText(row.priority) as Priority | null,
    summary: readNullableText(row.summary),
    next_action: readNullableText(row.next_action),
    confidence: readNullableNumber(row.confidence),
    source: readNullableText(row.source) as VerdictSource | null,
    reason: readNullableText(row.reason) as UnreadableReason | null,
    reconciliation_note: readNullableText(row.reconciliation_note),
    attempts: readAttempts(row.attempts),
    updated_at: readText(row.updated_at),
  };
}

/**
 * A fingerprint of the schema text, kept in `PRAGMA user_version`.
 *
 * 31 bits, because `user_version` is a signed 32-bit integer. It only has to CHANGE when the DDL changes,
 * never to be cryptographically anything, so a cheap string hash is the right tool.
 */
function schemaFingerprint(ddl: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < ddl.length; i += 1) {
    hash ^= ddl.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0x7fffffff;
}

const SCHEMA_VERSION = schemaFingerprint(SCHEMA);

/**
 * Create the schema, and rebuild it when the DDL has changed since this file was written.
 *
 * The tables are a CACHE. Every row in them is derived from `raw/inbound.json` plus a model call, so a
 * rebuild costs one re-run and loses nothing that cannot be regenerated — which is what makes dropping
 * them the right move rather than a destructive one. The alternative, telling the operator to go and delete
 * a file by hand, makes a person do work the program can do correctly.
 *
 * Deliberately NOT a numbered migration ladder. A hand-maintained version number is one more thing to
 * forget to bump, and forgetting is exactly the failure this exists to prevent: the enum drifted on disk
 * precisely because nothing was watching the DDL. Hashing the DDL means the check cannot be forgotten,
 * because the thing being checked IS the thing that changed.
 */
function applySchema(db: DatabaseSync): void {
  const stored = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const found = typeof stored?.user_version === 'number' ? stored.user_version : 0;

  // A fresh file reports 0 and has no tables; there is nothing to drop and nothing to warn about.
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('messages', 'triage_results')")
    .all();

  if (existing.length > 0 && found !== SCHEMA_VERSION) {
    console.warn(
      `[store] schema changed since this database was created (${found} -> ${SCHEMA_VERSION}); ` +
        'rebuilding messages and triage_results. Stored verdicts are derived data — re-run triage to refill them.',
    );
    db.exec('DROP TABLE IF EXISTS triage_results; DROP TABLE IF EXISTS messages;');
  }

  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * `dbPath` accepts `':memory:'`, which tests use. WAL is a no-op on an in-memory database and that is
 * harmless: there is no file to recover.
 */
export function createSqliteStore(dbPath: string): Store {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  applySchema(db);

  const insertMessage = db.prepare(`
    INSERT INTO messages (id, received_at, channel, from_name, from_org, subject, body)
    VALUES (:id, :received_at, :channel, :from_name, :from_org, :subject, :body)
    ON CONFLICT(id) DO UPDATE SET
      received_at = excluded.received_at,
      channel     = excluded.channel,
      from_name   = excluded.from_name,
      from_org    = excluded.from_org,
      subject     = excluded.subject,
      body        = excluded.body
  `);

  const selectMessages = db.prepare('SELECT * FROM messages ORDER BY received_at, id');

  const upsertResult = db.prepare(`
    INSERT INTO triage_results (
      message_id, content_hash, status, category, priority, summary, next_action, confidence,
      source, reason, reconciliation_note, attempts, updated_at
    ) VALUES (
      :message_id, :content_hash, :status, :category, :priority, :summary, :next_action, :confidence,
      :source, :reason, :reconciliation_note, :attempts, :updated_at
    )
    ON CONFLICT(message_id) DO UPDATE SET
      content_hash        = excluded.content_hash,
      status              = excluded.status,
      category            = excluded.category,
      priority            = excluded.priority,
      summary             = excluded.summary,
      next_action         = excluded.next_action,
      confidence          = excluded.confidence,
      source              = excluded.source,
      reason              = excluded.reason,
      reconciliation_note = excluded.reconciliation_note,
      attempts            = excluded.attempts,
      updated_at          = excluded.updated_at
  `);

  const selectResult = db.prepare('SELECT * FROM triage_results WHERE message_id = :message_id');
  const selectResults = db.prepare('SELECT * FROM triage_results ORDER BY message_id');
  const selectPending = db.prepare(
    'SELECT * FROM triage_results WHERE status = :status ORDER BY message_id',
  );

  let closed = false;

  return {
    async saveMessages(messages) {
      db.exec('BEGIN');
      try {
        for (const message of messages) {
          insertMessage.run({
            id: message.id,
            received_at: message.received_at,
            channel: message.channel,
            from_name: message.from_name,
            from_org: message.from_org,
            subject: message.subject,
            body: message.body,
          });
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async listMessages() {
      return selectMessages.all().map(toMessage);
    },

    async saveResult(result) {
      upsertResult.run({
        message_id: result.message_id,
        content_hash: result.content_hash,
        status: result.status,
        category: result.category,
        priority: result.priority,
        summary: result.summary,
        next_action: result.next_action,
        confidence: result.confidence,
        source: result.source,
        reason: result.reason,
        reconciliation_note: result.reconciliation_note,
        attempts: JSON.stringify(result.attempts),
        updated_at: result.updated_at,
      });
    },

    async getResult(messageId) {
      const row = selectResult.get({ message_id: messageId });
      return row ? toResult(row) : null;
    },

    async listResults() {
      return selectResults.all().map(toResult);
    },

    async listPendingRetry() {
      return selectPending.all({ status: PENDING_RETRY }).map(toResult);
    },

    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
