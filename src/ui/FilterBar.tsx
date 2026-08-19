/**
 * The tag filter.
 *
 * Labels, order and membership come from the CATEGORIES rows — nothing in here lists a category. That
 * is the same property the schema has (DESIGN §4.2): a category added to the taxonomy appears as a
 * chip with no edit to this file, and one removed cannot linger here as a dead filter.
 *
 * `pending_retry` sits beside them because reaching the failed rows is the same gesture (DESIGN §4.2d),
 * but it is a STATUS rather than a category, which is what the rule between them says.
 */

import { CATEGORIES, type Category } from '../triage/types.js';

export type FilterId = 'all' | Category | 'pending_retry';

export interface FilterCounts {
  all: number;
  pending_retry: number;
  byCategory: Partial<Record<Category, number>>;
}

export function FilterBar({
  counts,
  active,
  onSelect,
}: {
  counts: FilterCounts;
  active: FilterId;
  onSelect: (id: FilterId) => void;
}) {
  return (
    <div className="filterbar" role="group" aria-label="Filter the queue">
      <Chip id="all" label="All" count={counts.all} active={active} onSelect={onSelect} />
      {CATEGORIES.map((category) => (
        <Chip
          key={category.id}
          id={category.id}
          label={category.label}
          count={counts.byCategory[category.id] ?? 0}
          active={active}
          onSelect={onSelect}
          tone={`cat-${category.id}`}
          title={category.definition}
        />
      ))}
      <span className="filterbar-rule" aria-hidden="true" />
      <Chip
        id="pending_retry"
        label="Pending retry"
        count={counts.pending_retry}
        active={active}
        onSelect={onSelect}
        tone="tone-pending"
        title="Rows whose model call has not succeeded yet. They assert no category and no priority."
      />
    </div>
  );
}

function Chip({
  id,
  label,
  count,
  active,
  onSelect,
  tone,
  title,
}: {
  id: FilterId;
  label: string;
  count: number;
  active: FilterId;
  onSelect: (id: FilterId) => void;
  tone?: string;
  title?: string;
}) {
  const selected = active === id;
  return (
    <button
      type="button"
      className={`chip chip-filter${tone === undefined ? '' : ` ${tone}`}${selected ? ' is-active' : ''}`}
      aria-pressed={selected}
      // A filter that would empty the grid is not offered. `all` always is, and so is the active one,
      // because a chip that vanished as you clicked it would take its own way back out with it.
      disabled={count === 0 && id !== 'all' && !selected}
      title={title}
      onClick={() => onSelect(selected && id !== 'all' ? 'all' : id)}
    >
      <span className="chip-label">{label}</span>
      <span className="chip-count">{count}</span>
    </button>
  );
}
