/**
 * Put the queue back to untriaged: every message present, no verdicts.
 *
 * The store is a cache of derived data — each row is `raw/inbound.json` plus one model call — so clearing it
 * costs one re-run and loses nothing that cannot be regenerated. That is what makes this safe to offer as a
 * one-liner rather than something to be careful with.
 *
 * It exists because verdicts are idempotent by design: `run.ts` skips any message whose `content_hash`
 * already matches a stored row, so pressing Run twice correctly does nothing the second time. Useful in
 * production, awkward for a demo — without this you would be hand-deleting a database between takes.
 *
 * Messages are kept. Only the verdicts go, which is exactly the state a first-time reader sees on a fresh
 * clone: thirteen rows waiting, nothing triaged.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env['TRIAGE_DB'] ?? join(ROOT, 'data', 'triage.db');

if (!existsSync(dbPath)) {
  console.log(`Nothing to reset — no database at ${dbPath}. The queue is already untriaged.`);
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');

const before = db.prepare('SELECT count(*) AS n FROM triage_results').get() as { n: number };
db.exec('DELETE FROM triage_results');
const messages = db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
db.close();

console.log(
  `Cleared ${before.n} verdict(s). ${messages.n} message(s) still loaded, all untriaged — press "Run triage".`,
);
