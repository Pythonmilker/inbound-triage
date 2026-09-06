/**
 * The headline half of the error surface (DESIGN §4.2d).
 *
 * Always present once anything has been triaged, and it says what happened in one line. A clean run says
 * it is clean rather than going blank: a bar that only appears on failure teaches a reader that its
 * absence means nothing happened, and then a real failure has to compete with that lesson.
 *
 * `summary` is the run that just finished. Rows but no summary — a reload against a store that already
 * holds verdicts — derives the same counts from the rows and says they are STORED, because reporting an
 * earlier session's cost, calls or elapsed time as this session's would be an invention.
 *
 * What the failure sentence is built from is deliberate: the pending ROWS, not `summary.failures`. A
 * failure that a later attempt recovered from is in the run's failure tally and is not something that
 * "could not be triaged"; conflating them overstates the damage. The tally is reported separately.
 */

import { attemptSummary, FAILURE_POLICY, fixForRow } from '../triage/types.js';
import type { RunSummary } from '../runContract.js';
import type { FailureKind, TriageResult } from '../triage/types.js';
import type { QueueRow } from './types.js';

const MAX_LISTED_ERRORS = 3;

export function SummaryBar({
  summary,
  rows,
  loaderNote,
  busy,
  onRetry,
}: {
  summary: RunSummary | null;
  rows: readonly QueueRow[];
  /** The loader's repair note from the last read, shown when no run has reported one of its own. */
  loaderNote: string | null;
  busy: boolean;
  onRetry: () => void;
}) {
  const pendingRows = rows
    .map((row) => row.result)
    .filter((result): result is TriageResult => result !== null && result.status === 'pending_retry');

  const triaged =
    summary?.counts.triaged ?? rows.filter((row) => row.result?.status === 'triaged').length;
  const pending = summary?.counts.pending_retry ?? pendingRows.length;
  /** Rows with no verdict of any kind: loaded, waiting, never sent anywhere. */
  const waiting = rows.filter((row) => row.result === null).length;
  const parseNote = summary?.parseNote ?? loaderNote;
  const tally = summary === null ? null : failureTally(summary.failures);

  return (
    <section className="summary" aria-live="polite">
      <div className="summary-body">
        <p className="summary-line">{headline(triaged, pending, waiting, pendingRows)}</p>
        <p className="summary-meta">{summary === null ? storedNote(triaged) : meta(summary)}</p>

        {parseNote !== null && <p className="summary-note">Loader: {parseNote}</p>}

        {tally !== null && <p className="summary-note">Attempts that failed this run: {tally}</p>}

        {fixes(pendingRows).map((fix) => (
          <p className="summary-fix" key={fix}>
            {fix}
          </p>
        ))}

        {summary !== null &&
          summary.internalErrors.slice(0, MAX_LISTED_ERRORS).map((note) => (
            <p className="summary-note" key={`${note.messageId}-${note.detail}`}>
              Could not process {note.messageId}: {note.detail}
            </p>
          ))}
        {summary !== null && summary.internalErrors.length > MAX_LISTED_ERRORS && (
          <p className="summary-note">
            and {summary.internalErrors.length - MAX_LISTED_ERRORS} more the run could not process
          </p>
        )}
      </div>

      {/*
        Counted from the ROWS, not from the run: the button acts on everything the store still has
        queued, which after a partial retry is more than the rows this run happened to touch.
      */}
      {pendingRows.length > 0 && (
        <button type="button" className="button-secondary" onClick={onRetry} disabled={busy}>
          Retry {pendingRows.length} pending
        </button>
      )}
    </section>
  );
}

/**
 * With no run in this session there are two different situations and they must not share a sentence:
 * verdicts already in the store from an earlier session, or a queue that has never been triaged at all.
 */
function storedNote(triaged: number): string {
  return triaged === 0
    ? 'Nothing has been triaged yet. One model call per message will be made when you run it.'
    : 'Stored results — no run yet in this session.';
}

function headline(
  triaged: number,
  pending: number,
  waiting: number,
  pendingRows: readonly TriageResult[],
): string {
  // A fresh queue is not a run that did nothing. Saying "the run touched no rows" to someone who has not
  // pressed the button yet reports a failure that has not happened.
  if (triaged === 0 && pending === 0) {
    return waiting > 0
      ? `${waiting} waiting · none triaged yet — press “Run triage”`
      : 'Nothing to do — the run touched no rows.';
  }
  const rest = waiting > 0 ? ` · ${waiting} still waiting` : '';
  if (pending === 0) {
    return `${triaged} triaged · nothing failed${rest}`;
  }
  return `${triaged} triaged · ${pending} could not be triaged — ${worstAttempts(pendingRows)}${rest}`;
}

/**
 * The most-attempted pending row speaks for the set. It is the one closest to its cap, so it is the one
 * whose sentence a person needs; the rest are one filter click away.
 */
function worstAttempts(pendingRows: readonly TriageResult[]): string {
  let worst: TriageResult | null = null;
  for (const row of pendingRows) {
    if (worst === null || row.attempts.length > worst.attempts.length) worst = row;
  }
  return worst === null ? 'no attempts are recorded on those rows' : attemptSummary(worst.attempts);
}

function meta(summary: RunSummary): string {
  const parts = [plural(summary.calls, 'model call')];
  if (summary.calls > 0) parts.push(formatUsd(summary.costUsd));
  parts.push(`${(summary.elapsedMs / 1000).toFixed(1)}s`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} unchanged, so not re-run`);
  if (summary.drained > 0) parts.push(`${summary.drained} retried once the provider answered`);
  if (summary.unpricedCalls > 0) {
    parts.push(`${plural(summary.unpricedCalls, 'call')} with no price reported`);
  }
  return parts.join(' · ');
}

function failureTally(failures: Partial<Record<FailureKind, number>>): string | null {
  const listed: string[] = [];
  for (const [kind, count] of Object.entries(failures) as [FailureKind, number][]) {
    if (count > 0) listed.push(`${FAILURE_POLICY[kind].phrase} ×${count}`);
  }
  return listed.length === 0 ? null : listed.join(' · ');
}

/** Deduplicated: thirteen rows blocked on one dead key is one thing to fix, not thirteen. */
function fixes(pendingRows: readonly TriageResult[]): string[] {
  const unique = new Set<string>();
  for (const row of pendingRows) {
    const fix = fixForRow(row.attempts);
    if (fix !== null) unique.add(fix);
  }
  return [...unique];
}

function formatUsd(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
