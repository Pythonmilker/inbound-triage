/**
 * The storage seam.
 *
 * Every method returns a Promise even though the shipped implementation (`node:sqlite`) is synchronous.
 * That asymmetry is the point: an Airtable-backed store is HTTP, so a synchronous interface would push the
 * rewrite out into every caller instead of keeping it inside one file.
 *
 * `AirtableStore` is the documented migration path and is deliberately NOT built — an Airtable adapter is
 * out of scope (DESIGN R9/R10), and the field mapping lives in the README. The seam is still real rather
 * than decorative because SqliteStore runs through it: an interface with one working implementation is a
 * seam, one with none is a guess.
 */

import type { InboundMessage, TriageResult } from '../triage/types.js';

export interface Store {
  /** Upsert by message id, in one transaction, so a re-ingest replaces rows instead of duplicating them. */
  saveMessages(messages: readonly InboundMessage[]): Promise<void>;

  /** Inbox order: `received_at` then `id`, so two runs render the queue identically. */
  listMessages(): Promise<InboundMessage[]>;

  /** Upsert keyed on `message_id`. One row per message, always — there is no second table. */
  saveResult(result: TriageResult): Promise<void>;

  /**
   * Null when the message has never been triaged.
   *
   * This is where idempotence is decided, and the decision belongs to the caller, not the store: compare
   * the row's `content_hash` against the message's current hash. Equal means the stored verdict stands
   * and no model call is spent; different means the message was edited and must be triaged again.
   */
  getResult(messageId: string): Promise<TriageResult | null>;

  /** Every result row, ordered by message id. Queue order comes from `listMessages`. */
  listResults(): Promise<TriageResult[]>;

  /** The deferred-work queue: rows whose model call has not succeeded yet (DESIGN §4.2c). */
  listPendingRetry(): Promise<TriageResult[]>;

  /** Idempotent — calling it twice is not an error. */
  close(): Promise<void>;
}
