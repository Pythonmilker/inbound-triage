/**
 * The grid is a real table, and the inline detail is a second `<tr>` in the same `<tbody>` as the row
 * it belongs to. That is what keeps the detail from drifting away from its row under sort or filter,
 * and it is why expansion is not a modal: the queue stays on screen while you read one item of it.
 */

import type { QueueRow } from './App.js';
import { Row } from './Row.js';

/** Passed to the detail row rather than imported by it, so a column added here cannot leave it short. */
const GRID_COLUMNS = 8;

export function Grid({
  rows,
  expanded,
  onToggle,
  ranYet,
}: {
  rows: readonly QueueRow[];
  expanded: ReadonlySet<string>;
  onToggle: (messageId: string) => void;
  /** Passed through to Row: a missing result is "waiting" before a run and a defect after one. */
  ranYet: boolean;
}) {
  if (rows.length === 0) {
    return <p className="grid-empty">Nothing in the queue matches this filter.</p>;
  }

  return (
    <div className="grid-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th scope="col" className="col-expand">
              <span className="sr-only">Expand</span>
            </th>
            <th scope="col" className="col-when">
              Received
            </th>
            <th scope="col" className="col-from">
              From
            </th>
            <th scope="col" className="col-subject">
              Subject
            </th>
            <th scope="col" className="col-tag">
              Category
            </th>
            <th scope="col" className="col-tag">
              Priority
            </th>
            <th scope="col" className="col-summary">
              Summary
            </th>
            <th scope="col" className="col-source">
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row
              key={row.message.id}
              row={row}
              expanded={expanded.has(row.message.id)}
              onToggle={onToggle}
          ranYet={ranYet}
              columns={GRID_COLUMNS}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
