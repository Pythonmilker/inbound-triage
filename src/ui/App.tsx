/**
 * The screen: load the queue, run the engine, filter, expand. Derivation lives here and the children
 * render what they are handed, so there is exactly one place that decides what a row is.
 *
 * Three things are load-bearing:
 *
 *   1. THE IN-FLIGHT GUARD IS A REF, not the `busy` state. A state update is not visible to a second
 *      event in the same tick, so a held Enter can start a second run while `busy` is still false —
 *      that is a real bug from the sibling repo, where the button was disabled and the key handler was
 *      not. The ref flips synchronously and is cleared in a `finally`; `busy` only drives appearance.
 *   2. Every loaded message is a row once anything has been triaged, including a message with no result
 *      row at all. A message the run could not process must not quietly leave the queue.
 *   3. No priority is not a priority. An unranked row cannot be interleaved by rank, so it sorts below
 *      every ranked one; the summary bar and the pending chip are how it gets found (DESIGN §4.2d).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunSummary } from '../triage/run.js';
import {
  PRIORITY_RANK,
  type Category,
  type InboundMessage,
  type TriageResult,
} from '../triage/types.js';
import { errorText, fetchQueue, retryPending, runTriage } from './api.js';
import { FilterBar, type FilterCounts, type FilterId } from './FilterBar.js';
import { Grid } from './Grid.js';
import { SummaryBar } from './SummaryBar.js';

export interface QueueRow {
  message: InboundMessage;
  /** Null before the first run, and after a run whose pipeline threw on this message. */
  result: TriageResult | null;
}

export function App() {
  const [messages, setMessages] = useState<readonly InboundMessage[]>([]);
  const [results, setResults] = useState<readonly TriageResult[]>([]);
  const [loaderNote, setLoaderNote] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [filter, setFilter] = useState<FilterId>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const snapshot = await fetchQueue();
        if (!live) return;
        setMessages(snapshot.messages);
        setResults(snapshot.results);
        setLoaderNote(snapshot.parseNote);
      } catch (cause) {
        if (live) setError(errorText(cause));
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const perform = useCallback(async (action: () => Promise<RunSummary>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      setSummary(await action());
      const snapshot = await fetchQueue();
      setMessages(snapshot.messages);
      setResults(snapshot.results);
      setLoaderNote(snapshot.parseNote);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  const onRun = useCallback(() => {
    void perform(runTriage);
  }, [perform]);

  const onRetry = useCallback(() => {
    void perform(retryPending);
  }, [perform]);

  const onToggle = useCallback((messageId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  }, []);

  const rows = useMemo(() => {
    const byMessage = new Map(results.map((result) => [result.message_id, result]));
    return sortRows(
      messages.map((message) => ({ message, result: byMessage.get(message.id) ?? null })),
    );
  }, [messages, results]);

  const counts = useMemo(() => tally(rows), [rows]);
  const visible = useMemo(() => rows.filter((row) => matches(row, filter)), [rows, filter]);

  // Visible as soon as messages load, with every row uncategorised. A queue you cannot see until after
  // it has been processed hides the state the tool exists to change: a reader has to be able to look at
  // thirteen untriaged messages, press one button, and watch them get labelled. Rows already carry a null
  // result (see `rows` above and Row.tsx), so this is a gate that was costing the "before" state for
  // nothing.
  const showQueue = rows.length > 0;
  /** Has anything in this queue been triaged, in this session or a previous one? */
  const ranYet = results.length > 0 || summary !== null;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Inbound triage</h1>
          <p className="app-sub">
            {messages.length > 0
              ? `${messages.length} messages · one model call each, key held by the Node process`
              : 'One model call per message; the key stays in the Node process.'}
          </p>
        </div>
        <div className="app-actions">
          {busy && (
            <span className="working" role="status">
              working…
            </span>
          )}
          <button type="button" className="button-primary" onClick={onRun} disabled={busy}>
            Run triage
          </button>
        </div>
      </header>

      {error !== null && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}

      {showQueue ? (
        <>
          <SummaryBar
            summary={summary}
            rows={rows}
            loaderNote={loaderNote}
            busy={busy}
            onRetry={onRetry}
          />
          <FilterBar counts={counts} active={filter} onSelect={setFilter} />
          <Grid rows={visible} expanded={expanded} onToggle={onToggle} ranYet={ranYet} />
        </>
      ) : (
        <>
          {/* The message file does not parse as JSON at all, so its repair is reportable
              before anything has been triaged rather than only in a run summary (DESIGN §4.1). */}
          {loaderNote !== null && <p className="banner banner-note">Loader: {loaderNote}</p>}
          <p className="empty">{emptyText(loaded, messages.length)}</p>
        </>
      )}
    </div>
  );
}

function emptyText(loaded: boolean, messageCount: number): string {
  if (!loaded) return 'Loading the queue…';
  if (messageCount === 0) {
    return 'No messages loaded. Check raw/inbound.json and the dev server console.';
  }
  return `${messageCount} messages loaded, none triaged yet. Press “Run triage”.`;
}

function sortRows(rows: readonly QueueRow[]): QueueRow[] {
  return [...rows].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      a.message.received_at.localeCompare(b.message.received_at) ||
      a.message.id.localeCompare(b.message.id),
  );
}

/** Below every real priority, because a row that asserts none has not claimed to be urgent. */
function rank(row: QueueRow): number {
  const priority = row.result?.priority;
  return priority === undefined || priority === null ? -1 : PRIORITY_RANK[priority];
}

function tally(rows: readonly QueueRow[]): FilterCounts {
  const byCategory: Partial<Record<Category, number>> = {};
  let pending = 0;
  for (const { result } of rows) {
    if (result === null) continue;
    if (result.status === 'pending_retry') {
      pending += 1;
      continue;
    }
    if (result.category !== null) {
      byCategory[result.category] = (byCategory[result.category] ?? 0) + 1;
    }
  }
  return { all: rows.length, pending_retry: pending, byCategory };
}

function matches(row: QueueRow, filter: FilterId): boolean {
  if (filter === 'all') return true;
  if (filter === 'pending_retry') return row.result?.status === 'pending_retry';
  return row.result?.category === filter;
}
