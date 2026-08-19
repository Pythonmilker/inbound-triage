/**
 * The engine, end to end, on the unhappy paths — which is what R4 actually asks for: survive a
 * malformed message and an API error without falling over.
 *
 * Everything here runs against the real thirteen-message fixture, a real SQLite file in a temp
 * directory, and an injected fetch that answers per message id. No network, no real credential, and a
 * fixed clock.
 *
 * The claims worth stating up front, because each is a decision a refactor could quietly lose:
 *   - a run over a queue where the model fails on some items still finishes and writes a row for every
 *     message, including the ones that failed;
 *   - a message with nothing checkable in it costs no model call at all;
 *   - a failed call writes `pending_retry` with category and priority BOTH null — it asserts no verdict,
 *     not even the rule floor's, which is sitting right there;
 *   - a rejected key QUEUES. It is the failure an operator can fix, so making it terminal throws away
 *     the whole run's pending work while the fix is one environment variable away.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadInbound } from '../src/ingest/load.js';
import type { NotifyEvent, Notifier } from '../src/integrations/notify.js';
import { TRIAGE_CHAIN } from '../src/llm/protocol.js';
import { createSqliteStore } from '../src/store/sqlite.js';
import type { Store } from '../src/store/types.js';
import { fixForRow } from '../src/triage/retry.js';
import { createTriageEngine, type RunSummary, type TriageEngine } from '../src/triage/run.js';
import type { InboundMessage, TriageResult, TriageStatus } from '../src/triage/types.js';

/** The supplied file, used as supplied: it is itself one of the planted edge cases. */
const REAL_FIXTURE = fileURLToPath(new URL('../raw/inbound.json', import.meta.url));

const KEY = 'unit-test-key-do-not-ship';

const FIXED_NOW = Date.UTC(2026, 6, 21, 12, 0, 0);

/** The two messages with nothing checkable in them: a single period, and MIME wreckage. */
const UNREADABLE_IDS = ['inb-010', 'inb-011'] as const;

let dir: string;
let store: Store;
let notifications: NotifyEvent[];
let fixtureSeq = 0;

const notifier: Notifier = {
  notify: async (event) => {
    notifications.push(event);
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inbound-triage-engine-'));
  store = createSqliteStore(join(dir, 'data', 'triage.db'));
  notifications = [];
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

interface Sent {
  /** Which message the request is about, read out of the prompt the engine actually built. */
  id: string;
  /** The slug the engine asked for first — `models[0]` on the wire. */
  model: string;
}

/**
 * Reads the request rather than inferring from call order. Keying the fake provider off the real body is
 * what lets a test say "this message got no call" instead of "there were eleven calls and I assume
 * which", and it means the chain walk is asserted on what went out rather than on what we logged.
 */
function sentIn(init: RequestInit | undefined): Sent {
  const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : 'null');
  if (!isRecord(body)) throw new Error('the request body is not an object');

  const messages = body['messages'];
  if (!isUnknownArray(messages)) throw new Error('the request body has no messages array');
  const user = messages[1];
  if (!isRecord(user) || typeof user['content'] !== 'string') {
    throw new Error('the second message is not a user turn with string content');
  }
  const found = /^id: (\S+)$/m.exec(user['content']);
  if (found?.[1] === undefined) {
    throw new Error(`no message id in the user prompt:\n${user['content']}`);
  }

  const models = body['models'];
  if (!isUnknownArray(models) || typeof models[0] !== 'string') {
    throw new Error('the request body has no models array');
  }

  return { id: found[1], model: models[0] };
}

interface Harness {
  fetchImpl: typeof fetch;
  /** One entry per model call, in the order the requests went out. */
  calls: Sent[];
}

function harness(reply: (sent: Sent) => Response): Harness {
  const calls: Sent[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const sent = sentIn(init);
    calls.push(sent);
    return reply(sent);
  };
  return { fetchImpl, calls };
}

function verdict(over: Record<string, unknown> = {}): unknown {
  return {
    summary: 'The sender is asking the firm to do something with their account.',
    evidence: '"let me know the next step"',
    category: 'unknown',
    priority: 'low',
    next_action: 'Reply and ask what they need.',
    confidence: 0.75,
    ...over,
  };
}

/** `model` echoes the slug that was asked for, which is what a provider reports when it honours it. */
function answered(sent: Sent, content: unknown): Response {
  return new Response(
    JSON.stringify({
      model: sent.model,
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 700, completion_tokens: 120 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function refused(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

/** A 200 carrying prose. The schema never constrained it, so only validation catches this. */
function prose(sent: Sent): Response {
  return new Response(
    JSON.stringify({
      model: sent.model,
      choices: [
        { message: { content: 'Sure! This one looks like a prospect to me.' }, finish_reason: 'stop' },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeEngine(inboundPath: string, fetchImpl: typeof fetch, concurrency = 4): TriageEngine {
  return createTriageEngine({
    store,
    inboundPath,
    apiKey: KEY,
    fetchImpl,
    notifier,
    concurrency,
    // A fixed clock: attempt timestamps and `updated_at` are then assertable, and nothing depends on
    // how long the suite took to run.
    now: () => FIXED_NOW,
  });
}

function writeFixture(messages: readonly InboundMessage[]): string {
  fixtureSeq += 1;
  const path = join(dir, `inbound-${fixtureSeq}.json`);
  writeFileSync(path, JSON.stringify(messages, null, 2), 'utf8');
  return path;
}

function message(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'tmp-001',
    received_at: '2026-07-20T09:14:00-04:00',
    channel: 'email',
    from_name: 'Gregory Palmer',
    from_org: '(individual)',
    subject: 'Wealth planning after a liquidity event',
    body: 'I recently sold my business and am looking for help with tax-efficient planning. Who should I speak with?',
    ...over,
  };
}

function tally(rows: readonly TriageResult[]): Record<TriageStatus, number> {
  const counts: Record<TriageStatus, number> = { triaged: 0, pending_retry: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

async function rowFor(id: string): Promise<TriageResult> {
  const row = await store.getResult(id);
  if (row === null) throw new Error(`no row was written for ${id}`);
  return row;
}

/** Every id in the supplied file, read the way the engine reads them. */
function fixtureIds(): string[] {
  return loadInbound(REAL_FIXTURE).messages.map((m) => m.id);
}

function assertSummaryMatchesRows(summary: RunSummary, rows: readonly TriageResult[]): void {
  expect(summary.counts).toEqual(tally(rows));
}

describe('a run where the model fails on some items', () => {
  const FAILING: Readonly<Record<string, number>> = { 'inb-003': 500, 'inb-009': 503 };

  async function run(): Promise<{ summary: RunSummary; calls: Sent[] }> {
    const spy = harness((sent) => {
      const status = FAILING[sent.id];
      return status === undefined
        ? answered(sent, verdict())
        : refused(status, 'upstream is having a moment');
    });
    const summary = await makeEngine(REAL_FIXTURE, spy.fetchImpl).triageAll();
    return { summary, calls: spy.calls };
  }

  it('finishes and writes a row for every message', async () => {
    const ids = fixtureIds();
    expect(ids).toHaveLength(13);

    const { summary } = await run();
    const rows = await store.listResults();

    expect(rows.map((row) => row.message_id).sort()).toEqual([...ids].sort());
    expect(summary.counts).toEqual({ triaged: 11, pending_retry: 2 });
    // The file itself is one of the edge cases; a run that did not repair it never got this far.
    expect(summary.parseNote).toContain('not valid JSON');
    // A bulkhead that fired would mean our own code threw, not that a message was hard.
    expect(summary.internalErrors).toEqual([]);
  });

  it('spends no model call on a message with nothing checkable in it', async () => {
    const { calls } = await run();
    const asked = calls.map((sent) => sent.id);

    // Spending a call on "." is waste, and the answer is already known.
    for (const id of UNREADABLE_IDS) expect(asked).not.toContain(id);
    expect(distinct(asked)).toHaveLength(11);

    for (const id of UNREADABLE_IDS) {
      const row = await rowFor(id);
      expect(row.status, id).toBe('triaged');
      expect(row.category, id).toBe('unreadable');
      expect(row.source, id).toBe('rules');
      expect(row.attempts, id).toEqual([]);
      expect(row.summary, id).not.toBeNull();
      expect(row.next_action, id).not.toBeNull();
    }
    // The two are different kinds of nothing, and the row says which.
    expect((await rowFor('inb-010')).reason).toBe('below-threshold');
    expect((await rowFor('inb-011')).reason).toBe('garbled');
  });

  it('retries a provider failure once a later call proves the provider is answering', async () => {
    const { summary, calls } = await run();
    const asked = calls.map((sent) => sent.id);

    // Eleven first-pass calls, then the two queued rows are drained inside the same run because
    // something else succeeded. They fail again here, so they stay queued.
    expect(asked).toHaveLength(13);
    expect(asked.filter((id) => id === 'inb-003')).toHaveLength(2);
    expect(asked.filter((id) => id === 'inb-009')).toHaveLength(2);
    expect(summary.calls).toBe(13);
    expect(summary.failures.server_error).toBe(4);
    expect(summary.drained).toBe(0);

    const queued = await store.listPendingRetry();
    expect(queued.map((row) => row.message_id)).toEqual(['inb-003', 'inb-009']);
    expect(queued.every((row) => row.attempts.length === 2)).toBe(true);

    // A queued row is work pending, not an outcome needing a person. Notifying on each one would emit
    // thirteen alerts for one provider blip.
    expect(notifications.filter((event) => event.kind === 'triage_failed')).toEqual([]);

    // A 5xx is not the model's fault, so it must not spend a chain slot: the retry belongs on the same
    // model. Getting this wrong permanently demotes the primary because of one bad minute.
    expect(distinct(calls.map((sent) => sent.model))).toEqual([TRIAGE_CHAIN[0]]);
  });

  it('reports counts that match the rows it actually wrote', async () => {
    const { summary } = await run();
    assertSummaryMatchesRows(summary, await store.listResults());
    expect(summary.skipped).toBe(0);
  });
});

describe('a failed call', () => {
  it('writes pending_retry with category and priority both null', async () => {
    const spy = harness(() => refused(500, 'internal error'));
    const summary = await makeEngine(REAL_FIXTURE, spy.fetchImpl).triageAll();

    expect(summary.counts).toEqual({ triaged: 2, pending_retry: 11 });
    // Nothing succeeded, so there is no evidence the provider recovered and nothing to drain: one
    // attempt per readable message, not one per chain member.
    expect(summary.calls).toBe(11);
    expect(summary.drained).toBe(0);

    // inb-002 is the interesting row: it says "I'm an existing client" and names a Friday deadline, so
    // the rule floor has a full verdict for it. D-011b says the row still asserts nothing.
    const row = await rowFor('inb-002');
    expect(row.status).toBe('pending_retry');
    expect(row.category).toBeNull();
    expect(row.priority).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.next_action).toBeNull();
    expect(row.confidence).toBeNull();
    expect(row.source).toBeNull();
    expect(row.reconciliation_note).toBeNull();

    // What it does say: what was tried, and what went wrong.
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]?.failure).toBe('server_error');
    expect(row.attempts[0]?.httpStatus).toBe(500);
    expect(row.attempts[0]?.ok).toBe(false);
    expect(row.updated_at).toBe(new Date(FIXED_NOW).toISOString());

    assertSummaryMatchesRows(summary, await store.listResults());
  });

  it('falls through the chain itself when a 200 comes back as prose', async () => {
    // OpenRouter's own `models` array falls through on provider errors only: an HTTP 200 containing
    // prose is a success to it and it will never retry. So the fallthrough has to be ours.
    const path = writeFixture([message()]);
    const spy = harness((sent) => prose(sent));
    const summary = await makeEngine(path, spy.fetchImpl, 1).triageAll();

    // Asserted on the wire: three requests, each naming the next chain member as its primary.
    expect(spy.calls.map((sent) => sent.model)).toEqual([...TRIAGE_CHAIN]);
    expect(distinct(spy.calls.map((sent) => sent.id))).toEqual(['tmp-001']);
    expect(summary.counts).toEqual({ triaged: 0, pending_retry: 1 });

    const row = await rowFor('tmp-001');
    expect(row.attempts.map((attempt) => attempt.model)).toEqual([...TRIAGE_CHAIN]);
    expect(row.attempts.every((attempt) => attempt.failure === 'unparseable')).toBe(true);
    expect(row.category).toBeNull();

    // An exhausted chain is an outcome that needs a person, so unlike a queued row it gets a surface.
    const failed = notifications.filter((event) => event.kind === 'triage_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.messageId).toBe('tmp-001');
    expect(failed[0]?.detail).toContain('3 attempts across 3 models');
  });
});

describe('a provider that reports a slug we did not ask for', () => {
  /*
   * The invariant: a reply that fails validation is re-requested against the NEXT chain member, whatever
   * name the provider put on the answer. An alias (`:free`, `:nitro`) or OpenRouter's own array falling
   * through both produce that mismatch, and run.ts's own comment anticipates it — "OpenRouter may have
   * routed past it".
   *
   * It does not hold, and this test fails deliberately rather than pinning the behaviour it found. A
   * validation failure records the ANSWERED slug on the attempt (run.ts hands `call.model` to
   * `failedAttempt`, where a transport failure hands `decision.model`), and `planNextCall` derives its
   * chain-spent set from those slugs — so every chain member still looks untried and the primary is
   * re-requested until the 5-attempt cap stops it. Five calls on one model where the design says three
   * across three, and a row that reads "5 attempts across 1 model". The cap is what keeps it bounded and
   * the row stays honest about what it tried, so this costs calls and an escalation, not a hang.
   *
   * Only reachable through a reply that PARSES and then fails validation: a non-JSON reply is caught in
   * client.ts, which reports the requested slug and escalates correctly.
   */
  it('escalates through the chain anyway', async () => {
    const path = writeFixture([message()]);
    const primary = TRIAGE_CHAIN[0];
    if (primary === undefined) throw new Error('the triage chain is empty');
    const spy = harness(
      () =>
        new Response(
          JSON.stringify({
            model: `${primary}:free`,
            choices: [
              {
                message: { content: JSON.stringify(verdict({ category: 'not-a-category' })) },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const summary = await makeEngine(path, spy.fetchImpl, 1).triageAll();

    expect(summary.counts).toEqual({ triaged: 0, pending_retry: 1 });
    expect(spy.calls.map((sent) => sent.model)).toEqual([...TRIAGE_CHAIN]);
  });
});

describe('a rejected key', () => {
  it('queues every message and drains once the operator fixes it', async () => {
    let live = false;
    const spy = harness((sent) =>
      live ? answered(sent, verdict()) : refused(401, `no auth credentials found for ${sent.id}`),
    );
    const engine = makeEngine(REAL_FIXTURE, spy.fetchImpl);

    const rejected = await engine.triageAll();

    // Terminating here is the reasoning that was tried and overruled: it discards thirteen items of
    // pending work at the moment the fix is one environment variable away.
    expect(rejected.counts).toEqual({ triaged: 2, pending_retry: 11 });
    expect(rejected.failures.key_rejected).toBe(11);
    // One attempt each. A credential failure is not about the model, so it must not walk the chain —
    // that would spend 33 calls to be rejected 33 times and demote the primary for no reason.
    expect(spy.calls).toHaveLength(11);
    assertSummaryMatchesRows(rejected, await store.listResults());

    const queued = await store.listPendingRetry();
    expect(queued).toHaveLength(11);
    for (const row of queued) {
      expect(row.attempts[0]?.failure, row.message_id).toBe('key_rejected');
      expect(row.attempts[0]?.httpStatus, row.message_id).toBe(401);
      // The row can name what to fix, which is the whole reason it is worth queueing.
      expect(fixForRow(row.attempts), row.message_id).toContain('OPENROUTER_API_KEY');
    }

    live = true;
    const drainedRun = await engine.retryPending();

    expect(drainedRun.drained).toBe(11);
    expect(drainedRun.counts).toEqual({ triaged: 11, pending_retry: 0 });
    expect(spy.calls).toHaveLength(22);
    expect(await store.listPendingRetry()).toEqual([]);
    expect(tally(await store.listResults())).toEqual({ triaged: 13, pending_retry: 0 });
  });
});

describe('re-running the queue', () => {
  it('spends nothing on unchanged messages and re-triages an edited one', async () => {
    const first = message({ id: 'tmp-001' });
    const second = message({ id: 'tmp-002', subject: 'Possible referral partnership' });
    const path = writeFixture([first, second]);

    const spy = harness((sent) => answered(sent, verdict()));
    const engine = makeEngine(path, spy.fetchImpl, 1);

    const initial = await engine.triageAll();
    expect(initial.counts).toEqual({ triaged: 2, pending_retry: 0 });
    expect(spy.calls).toHaveLength(2);
    expect(initial.skipped).toBe(0);

    const again = await engine.triageAll();
    expect(again.skipped).toBe(2);
    expect(again.calls).toBe(0);
    expect(spy.calls).toHaveLength(2);

    const hashBefore = (await rowFor('tmp-002')).content_hash;
    writeFileSync(
      path,
      JSON.stringify([first, { ...second, body: `${second.body} Adding a sentence.` }], null, 2),
      'utf8',
    );

    const afterEdit = await engine.triageAll();
    expect(afterEdit.skipped).toBe(1);
    expect(afterEdit.calls).toBe(1);
    expect(spy.calls.map((sent) => sent.id)).toEqual(['tmp-001', 'tmp-002', 'tmp-002']);
    expect((await rowFor('tmp-002')).content_hash).not.toBe(hashBefore);
  });
});
