/**
 * The orchestrator: load, observe, rule, call once, validate, reconcile, save.
 *
 * A FACTORY WITH NO MODULE-LEVEL STATE. `createTriageEngine(config)` returns an instance and every
 * dependency — the store, the key, the transport, the clock, the notifier — arrives in `config` rather than
 * being imported. That is the whole of the "instantiable, N of them in one process" property (DESIGN §2.3),
 * and it costs nothing to have because it is an ABSENCE of singletons rather than an added subsystem: no
 * pool manager, no registry, no lifecycle. Two engines pointed at two databases cannot interfere, and
 * neither can a test and the app in the same process.
 *
 * Two behaviours are load-bearing and easy to lose in a refactor:
 *
 *   1. An unreadable message never reaches the model. Spending a call on `"."` is waste, and the answer is
 *      already known — there is nothing checkable in it.
 *   2. A failed call writes a row and THE RUN CONTINUES. One dead call must not abort the other twelve, and
 *      the row it writes asserts no verdict at all (D-011b): no category, no priority, not even the rule
 *      floor's, which is sitting right there. Only the attempt log and what has to change.
 */

import { loadInbound } from '../ingest/load.js';
import { ConsoleNotifier, type Notifier, type NotifyEvent } from '../integrations/notify.js';
import { contentHash } from '../lib/hash.js';
import { mapWithConcurrency } from '../lib/pool.js';
import { callTriage } from '../llm/client.js';
import { modelChain } from '../llm/protocol.js';
import type { Store } from '../store/types.js';
import { observe, type Signal } from './observations.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { reconcile } from './reconcile.js';
import {
  attemptSummary,
  drainPendingRetries,
  planNextCall,
  type Cleared,
  type DrainTrigger,
} from './retry.js';
import { applyRules, unreadableReason } from './rules.js';
import { validateVerdict } from './validate.js';
import {
  CATEGORIES,
  type Attempt,
  type Category,
  type FailureKind,
  type InboundMessage,
  type TriageResult,
  type TriageStatus,
  type UnreadableReason,
} from './types.js';

/** Serial is slow and unbounded gets rate-limited; four is the middle on a 13-item queue (DESIGN §2.3). */
const DEFAULT_CONCURRENCY = 4;

/** Six fields, three of them length-capped prose: ~250 tokens of answer with room for JSON overhead. */
const DEFAULT_MAX_TOKENS = 600;

export interface EngineConfig {
  store: Store;
  /** The queue's source of truth, re-read on every entry point so an edited message re-triages. */
  inboundPath: string;
  /**
   * Read from the environment by the Node process and injected here. Never imported by this module, never
   * prefixed `VITE_`, never sent to the browser (R8).
   */
  apiKey: string;
  concurrency?: number;
  maxTokens?: number;
  /** Overrides the chain's primary model — the README's model-override example. */
  model?: string;
  timeoutMs?: number;
  /** Injectable so a test can assert the request that was actually sent. */
  fetchImpl?: typeof fetch;
  notifier?: Notifier;
  /** Injectable so attempt timestamps and elapsed time are assertable. */
  now?: () => number;
}

export interface RunNote {
  messageId: string;
  detail: string;
}

export interface RunSummary {
  /** One entry per message the run touched, counted by the status now on its row. */
  counts: Record<TriageStatus, number>;
  /** Rows left alone because a stored verdict already covers this exact content. */
  skipped: number;
  /** Every failure kind seen this run, and how many attempts hit it. */
  failures: Partial<Record<FailureKind, number>>;
  /** Model calls spent, successful or not — a 200 containing prose is billed like any other. */
  calls: number;
  costUsd: number;
  /**
   * Answered calls whose price is unknown: a slug outside the registry, or a provider that reported no
   * usage. Counted rather than folded into `costUsd`, where a zero would read as free.
   */
  unpricedCalls: number;
  elapsedMs: number;
  /** From the loader — set when `inbound.json` needed repair before it would parse. */
  parseNote: string | null;
  /** Rows retried and triaged after a later call proved the provider was answering (DESIGN §4.2c). */
  drained: number;
  /** A message whose pipeline threw. Expected empty; if it is not, the run still finished. */
  internalErrors: RunNote[];
}

export interface TriageEngine {
  /** The whole queue, bounded-concurrent, idempotent. */
  triageAll(): Promise<RunSummary>;
  /**
   * One message, re-triaged unconditionally. This is the row-level retry control, so a person asked for it:
   * it does not consult the content hash and it passes the attempt cap once. A button that silently
   * declines because a counter is spent is worse than the call it saves.
   */
  triageOne(id: string): Promise<TriageResult>;
  /** The explicit "Retry N pending" control — the drain for everything the operator may have just fixed. */
  retryPending(): Promise<RunSummary>;
}

/** The taxonomy's own routing line, so a deterministic row does not invent prose for itself. */
function routingFor(id: Category): string {
  const row = CATEGORIES.find((c) => c.id === id);
  if (!row) throw new Error(`unknown category: ${id}`);
  return row.routing;
}

/**
 * What an unreadable row says instead of a model-authored summary. Attributed `source: 'rules'`, so the UI
 * never presents these as the model's words.
 */
const UNREADABLE_SUMMARY: Record<UnreadableReason, string> = {
  'empty-body': 'The message has no body.',
  garbled: 'The body is transport damage — nothing the sender wrote survives in it.',
  // The loader stops on a record with no usable id, so this reason cannot reach a row. It stays declared
  // because the record is exhaustive and a reason that exists must have words.
  'no-id': 'The record arrived without an id.',
  'below-threshold': 'The body is too short to contain anything checkable.',
};

/**
 * `reconcile` treats a signal row with no `matched` flag as matched, and ours carry `present` instead.
 * Passed through unmapped, every ABSENT signal would report as a hit and reconciliation would cite evidence
 * the message does not contain.
 */
function asRuleSignals(signals: readonly Signal[]): { id: string; matched: boolean }[] {
  return signals.map((s) => ({ id: s.id, matched: s.present }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PassSpend {
  skipped: boolean;
  calls: number;
  costUsd: number;
  unpricedCalls: number;
  failures: FailureKind[];
  /** A model call produced a usable verdict — what makes the queue's provider-blocked rows worth draining. */
  succeeded: boolean;
  notes: RunNote[];
}

interface Pass {
  row: TriageResult;
  spend: PassSpend;
}

/** `row` is null only when the pipeline itself threw, which is recorded rather than raised. */
interface GuardedPass {
  row: TriageResult | null;
  spend: PassSpend;
}

function noSpend(overrides: Partial<PassSpend> = {}): PassSpend {
  return {
    skipped: false,
    calls: 0,
    costUsd: 0,
    unpricedCalls: 0,
    failures: [],
    succeeded: false,
    notes: [],
    ...overrides,
  };
}

export function createTriageEngine(config: EngineConfig): TriageEngine {
  const {
    store,
    inboundPath,
    apiKey,
    concurrency = DEFAULT_CONCURRENCY,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs,
    fetchImpl,
    notifier = new ConsoleNotifier(),
    now = Date.now,
  } = config;

  const chain = modelChain(config.model);
  const system = buildSystemPrompt();

  const timestamp = (): string => new Date(now()).toISOString();

  /** On a failure we know only the slug we asked for first: OpenRouter may have routed past it. */
  const failedAttempt = (
    model: string,
    failure: FailureKind,
    httpStatus?: number,
    detail?: string,
  ): Attempt => {
    const attempt: Attempt = { model, at: timestamp(), ok: false, failure };
    if (httpStatus !== undefined) attempt.httpStatus = httpStatus;
    if (detail !== undefined && detail !== '') attempt.detail = detail;
    return attempt;
  };

  /**
   * A queued row is work pending; a spent chain is an outcome that needs a person (DESIGN §4.2d). Only the
   * second one is worth interrupting anybody for, which is also what keeps a provider blip from emitting
   * thirteen notifications.
   */
  const notifyEventFor = (row: TriageResult, chainSpent: boolean): NotifyEvent | null => {
    if (row.status === 'triaged' && row.priority === 'high') {
      return {
        kind: 'high_priority',
        messageId: row.message_id,
        detail: row.summary ?? row.next_action ?? 'high priority',
      };
    }
    if (chainSpent && row.status === 'pending_retry') {
      return {
        kind: 'triage_failed',
        messageId: row.message_id,
        detail: attemptSummary(row.attempts),
      };
    }
    return null;
  };

  const persist = async (row: TriageResult, chainSpent: boolean): Promise<RunNote[]> => {
    await store.saveResult(row);
    const event = notifyEventFor(row, chainSpent);
    if (event === null) return [];
    try {
      await notifier.notify(event);
    } catch (error) {
      // A notification is an operational courtesy. Losing one must not lose the verdict that caused it.
      return [{ messageId: row.message_id, detail: `notify failed: ${describeError(error)}` }];
    }
    return [];
  };

  const triageMessage = async (m: InboundMessage, cleared: Cleared): Promise<Pass> => {
    const hash = contentHash(m);
    const stored = await store.getResult(m.id);

    if (
      cleared === 'nothing' &&
      stored !== null &&
      stored.status === 'triaged' &&
      stored.content_hash === hash
    ) {
      return { row: stored, spend: noSpend({ skipped: true }) };
    }

    const signals = observe(m);
    const rules = applyRules(m, signals);
    const reason = unreadableReason(m, signals);

    if (reason !== null) {
      const row: TriageResult = {
        message_id: m.id,
        content_hash: hash,
        status: 'triaged',
        category: rules.category,
        priority: rules.priority,
        summary: UNREADABLE_SUMMARY[reason],
        next_action: routingFor(rules.category),
        confidence: rules.confidence,
        source: 'rules',
        reason,
        reconciliation_note: null,
        attempts: [],
        updated_at: timestamp(),
      };
      // `status: 'triaged'` with no model call is not a shortcut: we did finish, and the answer is that
      // there is nothing checkable in here (DESIGN §4.1).
      return { row, spend: noSpend({ notes: await persist(row, false) }) };
    }

    const sameContent = stored !== null && stored.content_hash === hash;

    /*
     * A verdict we already hold for this exact content. It matters on the failure exit: a retry that fails
     * must not blank a row that had an answer. D-011b says a failed call asserts no verdict — it does not
     * say a failed call erases one, and overwriting a good row with an empty `pending_retry` would lose
     * work rather than record it.
     */
    const priorVerdict = sameContent && stored.status === 'triaged' ? stored : null;

    // The attempt log is the record of work still UNFINISHED on this content, so only a pending row carries
    // one forward. An edited message starts fresh too: its stored attempts were made against different
    // text, and carrying them would cap a retry on failures that no longer describe this message.
    const attempts: Attempt[] =
      sameContent && stored.status === 'pending_retry' ? [...stored.attempts] : [];

    const user = buildUserPrompt(m, signals);
    const spend = noSpend();
    let decision = planNextCall({ chain, attempts, baseMaxTokens: maxTokens, cleared });

    while (decision.action === 'call') {
      const call = await callTriage(
        { system, user, maxTokens: decision.maxTokens },
        { apiKey, model: decision.model, fetchImpl, timeoutMs },
      );
      spend.calls += 1;

      if (!call.ok) {
        spend.failures.push(call.failure);
        attempts.push(failedAttempt(decision.model, call.failure, call.httpStatus, call.detail));
      } else {
        const cost = call.usage?.costUsd;
        if (typeof cost === 'number') spend.costUsd += cost;
        else spend.unpricedCalls += 1;

        const validated = validateVerdict(call.raw);
        if (validated.ok) {
          attempts.push({ model: call.model, at: timestamp(), ok: true });
          const merged = reconcile({
            rules: { ...rules, signals: asRuleSignals(signals) },
            model: validated.value,
          });
          const row: TriageResult = {
            message_id: m.id,
            content_hash: hash,
            status: 'triaged',
            category: merged.category,
            priority: merged.priority,
            summary: validated.value.summary,
            next_action: validated.value.next_action,
            confidence: merged.confidence,
            source: merged.source,
            reason: null,
            reconciliation_note: merged.note,
            attempts,
            updated_at: timestamp(),
          };
          spend.succeeded = true;
          spend.notes.push(...(await persist(row, false)));
          return { row, spend };
        }

        spend.failures.push(validated.failure);
        /*
         * Record the slug we REQUESTED, not the one the provider answered with. `planNextCall` derives
         * "which chain members have I tried" from these attempt slugs, and a provider may answer under a
         * different name than it was asked for — an alias like `:free`, or its own array falling through.
         * Recording the answered name leaves every chain member looking untried, so the primary is
         * re-requested until the attempt cap stops it: five calls on one model where the design says three
         * across three. The transport-failure path above already uses `decision.model` for this reason.
         *
         * The answered name is still worth keeping when it differs, so it rides in the detail — that is
         * the difference between a diagnosable row and a mysterious one.
         */
        const answeredElsewhere = call.model !== decision.model ? ` (provider answered as ${call.model})` : '';
        attempts.push(
          failedAttempt(
            decision.model,
            validated.failure,
            undefined,
            `${validated.problems.join('; ')}${answeredElsewhere}`,
          ),
        );
      }

      // Whatever had cleared has now been spent on this call, so the next plan gets no credit for it.
      // Without this the loop would ignore the attempt cap for as long as an operator-requested retry ran.
      decision = planNextCall({ chain, attempts, baseMaxTokens: maxTokens, cleared: 'nothing' });
    }

    const row: TriageResult =
      priorVerdict !== null
        ? {
            ...priorVerdict,
            attempts: [...priorVerdict.attempts, ...attempts],
            updated_at: timestamp(),
          }
        : {
            message_id: m.id,
            content_hash: hash,
            status: 'pending_retry',
            category: null,
            priority: null,
            summary: null,
            next_action: null,
            confidence: null,
            source: null,
            reason: null,
            reconciliation_note: null,
            attempts,
            updated_at: timestamp(),
          };
    spend.notes.push(...(await persist(row, decision.action === 'stop')));
    return { row, spend };
  };

  const guardedTriage = async (m: InboundMessage, cleared: Cleared): Promise<GuardedPass> => {
    try {
      return await triageMessage(m, cleared);
    } catch (error) {
      // A bulkhead, not a blanket catch. One message's pipeline throwing is recorded on the summary and
      // the other twelve still land; no row is written, because a fault in our own code is not a verdict
      // about the message and there is no status that would honestly say so.
      return {
        row: null,
        spend: noSpend({
          notes: [{ messageId: m.id, detail: `triage threw: ${describeError(error)}` }],
        }),
      };
    }
  };

  const drain = async (
    trigger: DrainTrigger,
    byId: ReadonlyMap<string, InboundMessage>,
  ): Promise<GuardedPass[]> => {
    const passes: GuardedPass[] = [];
    try {
      await drainPendingRetries({
        // A pending row whose message has left the file cannot be retried and is not invented: it stays
        // pending rather than being dropped from the queue.
        pending: async () =>
          (await store.listPendingRetry()).filter((row) => byId.has(row.message_id)),
        chain,
        baseMaxTokens: maxTokens,
        trigger,
        retry: async (messageId, cleared) => {
          const message = byId.get(messageId);
          if (message === undefined) {
            throw new Error(`${messageId} passed the pending filter but is not in the loaded queue`);
          }
          const pass = await triageMessage(message, cleared);
          passes.push(pass);
          return pass.row;
        },
      });
    } catch (error) {
      // The remaining rows keep their `pending_retry` status, so the next trigger picks them up.
      passes.push({
        row: null,
        spend: noSpend({ notes: [{ messageId: '-', detail: `drain stopped: ${describeError(error)}` }] }),
      });
    }
    return passes;
  };

  const summarize = (input: {
    passes: readonly GuardedPass[];
    drained: readonly GuardedPass[];
    parseNote: string | null;
    startedAt: number;
  }): RunSummary => {
    const all = [...input.passes, ...input.drained];

    // Keyed by message id, last write wins: a row that failed in the first pass and was drained in the
    // second must be counted once, under the status it ended on.
    const finalRows = new Map<string, TriageResult>();
    for (const pass of all) {
      if (pass.row !== null) finalRows.set(pass.row.message_id, pass.row);
    }

    const counts: Record<TriageStatus, number> = { triaged: 0, pending_retry: 0 };
    for (const row of finalRows.values()) counts[row.status] += 1;

    const failures: Partial<Record<FailureKind, number>> = {};
    for (const pass of all) {
      for (const kind of pass.spend.failures) failures[kind] = (failures[kind] ?? 0) + 1;
    }

    let calls = 0;
    let costUsd = 0;
    let unpricedCalls = 0;
    let skipped = 0;
    const internalErrors: RunNote[] = [];
    for (const pass of all) {
      calls += pass.spend.calls;
      costUsd += pass.spend.costUsd;
      unpricedCalls += pass.spend.unpricedCalls;
      if (pass.spend.skipped) skipped += 1;
      internalErrors.push(...pass.spend.notes);
    }

    return {
      counts,
      skipped,
      failures,
      calls,
      // Rounded so a float sum of per-call costs does not render as 0.00030000000000000003.
      costUsd: Math.round(costUsd * 1e8) / 1e8,
      unpricedCalls,
      elapsedMs: now() - input.startedAt,
      parseNote: input.parseNote,
      drained: input.drained.filter((pass) => pass.row?.status === 'triaged').length,
      internalErrors,
    };
  };

  const ingest = async (): Promise<{
    messages: InboundMessage[];
    byId: Map<string, InboundMessage>;
    parseNote: string | null;
  }> => {
    const { messages, parseNote } = loadInbound(inboundPath);
    await store.saveMessages(messages);
    return { messages, byId: new Map(messages.map((m) => [m.id, m])), parseNote };
  };

  return {
    async triageAll() {
      const startedAt = now();
      const { messages, byId, parseNote } = await ingest();

      const passes = await mapWithConcurrency(messages, concurrency, (m) =>
        guardedTriage(m, 'nothing'),
      );

      // The queue drains on a success within the same run, which is what makes it automatic in the common
      // case: the API blips, four items fail, the fifth answers, and those four are retried before the run
      // reports done. With no success there is nothing to prove the provider recovered, so they wait for
      // the next run or for `retryPending`.
      const drained = passes.some((pass) => pass.spend.succeeded)
        ? await drain('provider', byId)
        : [];

      return summarize({ passes, drained, parseNote, startedAt });
    },

    async triageOne(id) {
      const { messages } = await ingest();
      const message = messages.find((m) => m.id === id);
      if (message === undefined) {
        throw new Error(`No message with id ${JSON.stringify(id)} in ${inboundPath}.`);
      }
      const pass = await triageMessage(message, 'operator');
      return pass.row;
    },

    async retryPending() {
      const startedAt = now();
      const { byId, parseNote } = await ingest();
      const drained = await drain('operator', byId);
      return summarize({ passes: [], drained, parseNote, startedAt });
    },
  };
}
