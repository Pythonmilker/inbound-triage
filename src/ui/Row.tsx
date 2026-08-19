/**
 * One queue row and its inline detail. Three states have to be rendered honestly, and each of them is
 * easy to get wrong in a way that looks fine:
 *
 *   1. A `pending_retry` row asserts NO category and NO priority (D-011b). It gets a "not triaged" chip
 *      and its attempt sentence in the summary column — never a grey category chip, never a normal-
 *      looking row with empty cells.
 *   2. `unreadable` is a verdict about the CONTENT, not a crash. It is styled in the neutral family and
 *      the failure family is the only thing wearing red, because someone scanning chips must not read
 *      "this message is garbage" as "the app broke" — the collision that got `error` rejected (D-013).
 *   3. The verdict SOURCE is always on the collapsed row. A verdict never hides where it came from.
 *
 * The per-attempt table is what makes a failure diagnosable rather than merely visible, so it is shown
 * whenever attempts exist — a row that succeeded on its third model is worth the same look.
 */

import { attemptSummary, FAILURE_POLICY, fixForRow } from '../triage/retry.js';
import { CONFIDENCE_THRESHOLD } from '../triage/schema.js';
import {
  CATEGORIES,
  PRIORITIES,
  isOrgSentinel,
  type Attempt,
  type Category,
  type Priority,
  type TriageResult,
  type UnreadableReason,
} from '../triage/types.js';
import type { QueueRow } from './App.js';

const CATEGORY_LABEL = new Map<Category, string>(CATEGORIES.map((c) => [c.id, c.label]));
const PRIORITY_LABEL = new Map<Priority, string>(PRIORITIES.map((p) => [p.id, p.label]));

/** types.ts owns the enum; the words a person reads about it belong to the surface showing them. */
const REASON_TEXT: Record<UnreadableReason, string> = {
  'empty-body': 'the body is empty',
  garbled: 'the body is transport damage',
  'no-id': 'the record arrived with no id',
  'below-threshold': 'too short to contain anything checkable',
};

export function Row({
  row,
  expanded,
  onToggle,
  columns,
  ranYet,
}: {
  row: QueueRow;
  expanded: boolean;
  onToggle: (messageId: string) => void;
  columns: number;
  /**
   * Whether anything in this queue has been triaged at all. A row with no result means two entirely
   * different things either side of that: before a run it is simply waiting, and after one it is a message
   * the run dropped without recording a verdict — which is a defect and has to say so. Without this flag
   * the resting state of a fresh queue reads as thirteen internal errors.
   */
  ranYet: boolean;
}) {
  const { message, result } = row;
  const detailId = `detail-${message.id}`;
  const verdict = result !== null && result.status === 'triaged' ? result : null;
  const org = isOrgSentinel(message.from_org) ? null : message.from_org;

  return (
    <>
      <tr className={verdict === null ? 'is-unresolved' : undefined}>
        <td className="col-expand">
          <button
            type="button"
            className="expander"
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            onClick={() => onToggle(message.id)}
          >
            <span className="expander-mark" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
            <span className="sr-only">
              {expanded ? 'Collapse' : 'Expand'} {message.subject === '' ? message.id : message.subject}
            </span>
          </button>
        </td>
        <td className="col-when">{formatWhen(message.received_at)}</td>
        <td className="col-from">
          <span className="from-name">{message.from_name === '' ? '(no name)' : message.from_name}</span>
          {org !== null && <span className="from-org">{org}</span>}
        </td>
        <td className="col-subject">
          {message.subject === '' ? <span className="no-value">(no subject)</span> : message.subject}
        </td>
        <td className="col-tag">
          {verdict !== null && verdict.category !== null ? (
            <span className={`chip cat-${verdict.category}`}>
              {label(CATEGORY_LABEL, verdict.category)}
            </span>
          ) : ranYet ? (
            <span className="chip tone-pending">not triaged</span>
          ) : (
            // Neutral, not the failure colour. `tone-pending` is right for a row whose model call failed
            // and wrong for one that has not been attempted: thirteen red chips on a queue nobody has run
            // yet announce thirteen failures that have not happened.
            <span className="chip tone-waiting">awaiting</span>
          )}
        </td>
        <td className="col-tag">
          {verdict !== null && verdict.priority !== null ? (
            <span className={`chip prio-${verdict.priority}`}>
              {label(PRIORITY_LABEL, verdict.priority)}
            </span>
          ) : (
            <span className="no-value" title="no priority asserted">
              —
            </span>
          )}
        </td>
        <td className="col-summary">{summaryCell(result, verdict, ranYet)}</td>
        <td className="col-source">
          {verdict !== null && verdict.source !== null ? (
            <span className="chip chip-source">{verdict.source}</span>
          ) : (
            <span className="no-value">—</span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="detail-row" id={detailId}>
          <td colSpan={columns}>
            <div className="detail">
              <p className="detail-meta">
                <span>{message.id}</span>
                <span>{message.channel === '' ? 'channel unrecorded' : message.channel}</span>
                <span>{message.received_at}</span>
              </p>

              <div className="detail-block">
                <h3>Message</h3>
                {message.body.trim() === '' ? (
                  <p className="no-value">The body is empty.</p>
                ) : (
                  <pre className="detail-body">{message.body}</pre>
                )}
              </div>

              {result !== null && <Verdict result={result} />}

              {result !== null && result.attempts.length > 0 && (
                <div className="detail-block">
                  <h3>Attempts</h3>
                  <p className="detail-line">{attemptSummary(result.attempts)}</p>
                  <AttemptTable attempts={result.attempts} />
                  <Unblock attempts={result.attempts} />
                </div>
              )}

              {result === null && (
                <p className="detail-line">
                  {ranYet
                    ? 'No result row exists for this message. The run recorded an internal error for it rather than a verdict — see the run summary.'
                    : 'Not triaged yet. Press “Run triage” to send this message for a verdict — one model call, alongside the deterministic read.'}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Verdict({ result }: { result: TriageResult }) {
  return (
    <dl className="detail-fields">
      <div>
        <dt>Next action</dt>
        <dd>
          {result.next_action === null ? (
            <span className="no-value">none — this row reached no verdict</span>
          ) : (
            result.next_action
          )}
        </dd>
      </div>
      <div>
        <dt>Confidence</dt>
        <dd>
          {result.confidence === null ? (
            <span className="no-value">none</span>
          ) : (
            <>
              {result.confidence.toFixed(2)}
              {result.confidence < CONFIDENCE_THRESHOLD && (
                <span className="hint"> below the {CONFIDENCE_THRESHOLD} trust threshold</span>
              )}
            </>
          )}
        </dd>
      </div>
      {result.reason !== null && (
        <div>
          <dt>Unreadable because</dt>
          <dd>{REASON_TEXT[result.reason]}</dd>
        </div>
      )}
      {result.reconciliation_note !== null && (
        <div>
          <dt>Reconciled</dt>
          <dd>{result.reconciliation_note}</dd>
        </div>
      )}
      <div>
        <dt>Row written</dt>
        <dd>{formatWhen(result.updated_at)}</dd>
      </div>
    </dl>
  );
}

function AttemptTable({ attempts }: { attempts: readonly Attempt[] }) {
  return (
    <table className="attempts">
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">Status</th>
          <th scope="col">Failure</th>
          <th scope="col">When</th>
        </tr>
      </thead>
      <tbody>
        {attempts.map((attempt, index) => (
          <tr key={`${attempt.at}-${attempt.model}-${index}`}>
            <td className="attempt-model">{attempt.model}</td>
            <td className={attempt.ok ? 'attempt-ok' : 'attempt-failed'}>
              {attempt.ok ? 'answered' : 'failed'}
              {attempt.httpStatus !== undefined && <span className="hint"> HTTP {attempt.httpStatus}</span>}
            </td>
            <td>
              {attempt.failure === undefined ? (
                <span className="no-value">—</span>
              ) : (
                FAILURE_POLICY[attempt.failure].phrase
              )}
              {attempt.detail !== undefined && <div className="attempt-detail">{attempt.detail}</div>}
            </td>
            <td className="attempt-when">{formatWhen(attempt.at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Unblock({ attempts }: { attempts: readonly Attempt[] }) {
  const fix = fixForRow(attempts);
  if (fix === null) return null;
  return (
    <p className="detail-fix">
      <strong>To unblock:</strong> {fix}
    </p>
  );
}

function summaryCell(result: TriageResult | null, verdict: TriageResult | null, ranYet: boolean) {
  // "no result row" is the right words for a message a run dropped and the wrong words for one that has
  // simply not been run. Same null, opposite meanings.
  if (result === null) {
    return <span className="no-value">{ranYet ? 'no result row' : 'awaiting triage'}</span>;
  }
  if (verdict === null) return <span className="failure-line">{attemptSummary(result.attempts)}</span>;
  if (verdict.summary === null) return <span className="no-value">no summary</span>;
  return verdict.summary;
}

function label<T extends string>(labels: ReadonlyMap<T, string>, id: T): string {
  // The id is what shows if a label is missing: a taxonomy row can be added without its chip going blank.
  return labels.get(id) ?? id;
}

function formatWhen(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
