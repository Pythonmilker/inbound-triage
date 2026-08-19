/**
 * The bounded pool. Four properties, and each one is a bug the queue would otherwise ship with.
 *
 * Results must come back in INPUT order, because the UI renders the queue in inbox order and a pool
 * that returns completion order silently reorders the grid. Concurrency must actually be bounded, or a
 * 13-item queue meets the provider's rate limit. A rejection must not cancel the survivors — "one dead
 * call does not abort the other twelve" is a design commitment, not an implementation detail. And a
 * limit that failed to parse must degrade to serial rather than to zero workers, which would return an
 * empty array and look like a completed run.
 */

import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '../src/lib/pool.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ordering', () => {
  it('returns results in input order even when everything finishes backwards', async () => {
    const items = [0, 1, 2, 3, 4];
    // Descending delays with the whole batch in flight: the last item finishes first. Gaps of 25ms
    // because a Windows timer is not precise enough for 10.
    const delays = [100, 75, 50, 25, 0];
    const completed: number[] = [];

    const results = await mapWithConcurrency(items, items.length, async (item, index) => {
      const delay = delays[index];
      if (delay === undefined) throw new Error(`no delay for index ${index}`);
      await sleep(delay);
      completed.push(item);
      return `item-${item}`;
    });

    expect(results).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);
    // The test would be vacuous if the two orders happened to agree.
    expect(completed).toEqual([4, 3, 2, 1, 0]);
    expect(completed).not.toEqual(items);
  });

  it('passes each item its own index', async () => {
    const seen: [string, number][] = [];
    const results = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, index) => {
      seen.push([item, index]);
      return index;
    });

    expect(results).toEqual([0, 1, 2]);
    expect([...seen].sort((x, y) => x[1] - y[1])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });
});

describe('the bound', () => {
  it('never runs more than the limit at once', async () => {
    const limit = 3;
    let live = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), limit, async (item) => {
      live += 1;
      peak = Math.max(peak, live);
      await sleep(5);
      live -= 1;
      return item;
    });

    expect(peak).toBeLessThanOrEqual(limit);
    // And it does reach the limit: a pool that ran everything serially would also satisfy the ceiling
    // while being the slow failure the limiter exists to avoid.
    expect(peak).toBe(limit);
    expect(live).toBe(0);
  });

  it('never spawns more workers than there are items', async () => {
    let peak = 0;
    let live = 0;

    const results = await mapWithConcurrency([1, 2], 10, async (item) => {
      live += 1;
      peak = Math.max(peak, live);
      await sleep(5);
      live -= 1;
      return item * 2;
    });

    expect(results).toEqual([2, 4]);
    expect(peak).toBe(2);
  });

  it.each([0, -5, 0.4, Number.NaN, Number.POSITIVE_INFINITY])(
    'coerces a limit of %p to at least one worker',
    async (limit) => {
      let live = 0;
      let peak = 0;

      const results = await mapWithConcurrency([1, 2, 3, 4], limit, async (item) => {
        live += 1;
        peak = Math.max(peak, live);
        await sleep(2);
        live -= 1;
        return item;
      });

      // The failure this pins: left as NaN the width is zero, no worker is ever started, and the run
      // returns an array of holes — a silent no-op that reads as success.
      expect(results).toEqual([1, 2, 3, 4]);
      expect(peak).toBeGreaterThanOrEqual(1);
      expect(peak).toBeLessThanOrEqual(4);
    },
  );
});

describe('a rejection', () => {
  it('does not stop the other items from running', async () => {
    const ran: number[] = [];
    const items = [0, 1, 2, 3, 4];

    const failed = await mapWithConcurrency(items, 2, async (item) => {
      await sleep(2);
      if (item === 2) throw new Error('boom on 2');
      ran.push(item);
      return item;
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failed).toBeInstanceOf(Error);
    expect(failed instanceof Error ? failed.message : '').toBe('boom on 2');
    // Every survivor ran. This is the property the whole design leans on: a dead model call costs one
    // row, not the run.
    expect([...ran].sort((a, b) => a - b)).toEqual([0, 1, 3, 4]);
  });

  it('rethrows a lone failure as itself, so a caller can still match on its type', async () => {
    class ProviderRefused extends Error {}
    const thrown = new ProviderRefused('refused');

    const failed = await mapWithConcurrency([1], 4, async () => {
      throw thrown;
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failed).toBe(thrown);
  });

  it('collects several failures into one AggregateError in input order', async () => {
    const failed = await mapWithConcurrency([0, 1, 2, 3], 4, async (item) => {
      await sleep(item === 3 ? 0 : 10);
      if (item === 1 || item === 3) throw new Error(`failed ${item}`);
      return item;
    }).then(
      () => null,
      (error: unknown) => error,
    );

    if (!(failed instanceof AggregateError)) {
      throw new Error(`expected an AggregateError, got ${String(failed)}`);
    }
    expect(failed.message).toContain('2 of 4');
    // Index order, not completion order: item 3 rejects first and still reports second.
    expect(failed.errors.map((error: unknown) => (error instanceof Error ? error.message : ''))).toEqual([
      'failed 1',
      'failed 3',
    ]);
  });
});

describe('an empty queue', () => {
  it('resolves to an empty array without calling the function', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, async (item: number) => {
      calls += 1;
      return item;
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
