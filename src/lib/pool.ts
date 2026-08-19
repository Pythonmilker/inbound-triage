/**
 * Bounded concurrency, and all of it (DESIGN §2.3). Serial is slow, unbounded gets rate-limited; a worker
 * pool or instance orchestration would be over-engineering for a queue this size, so this is the whole mechanism.
 *
 * REJECT-SAFE BY CAPTURE, which is the load-bearing choice here: a rejected `fn` cancels nothing. Every
 * item still runs, and the failure is rethrown only once everything has settled — one dead model call must
 * not abort the other twelve. Callers that want failures as data rather than as a throw (the retry queue
 * does) should hand in an `fn` that resolves with a typed failure instead of throwing.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures: { index: number; error: unknown }[] = [];
  // A non-finite limit — an env var that failed to parse — becomes serial. Left as NaN it would spawn zero
  // workers and return an empty array, which is a silent no-op rather than a slow run.
  const width = Math.min(items.length, Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1);
  // One iterator shared by all workers: `next()` is synchronous, so no two workers can take the same entry,
  // and a worker pulls again only after its own await resolves. That is what bounds the concurrency.
  const queue = items.entries();

  async function worker(): Promise<void> {
    for (const [index, item] of queue) {
      try {
        results[index] = await fn(item, index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));

  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    const errors = failures.map((failure) => failure.error);
    // A lone failure is rethrown as itself so a caller can still match on its type.
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${errors.length} of ${items.length} concurrent tasks failed`);
  }

  return results;
}
