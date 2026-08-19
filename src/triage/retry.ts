/**
 * The queue, which is DEFERRED WORK and not outage recovery (D-013b).
 *
 * That distinction decides the whole module. A retry queue is a record of work we could not do YET, and it
 * drains whenever the blocking condition clears — whether the provider recovered or **the operator fixed
 * something**. The narrow reading, where a queue only waits out a provider outage, makes a rejected key
 * terminal and throws away thirteen items of pending work at the exact moment the fix is one environment
 * variable away. So `key_rejected` and `unfunded` queue like everything else; what differs is what has to
 * change before another call is worth spending.
 *
 * Nothing is silently abandoned. Attempts are capped, the count lives on the row, and a capped row still
 * answers a person's question — "3 attempts across 2 models, last failure: the reply did not match the
 * schema" — and stays retryable by hand.
 *
 * Pure policy plus one driver. No clock, no store, no transport: `planNextCall` is a decision over the
 * attempts already on the row, and `drainPendingRetries` calls back into whatever can re-run a message.
 */

import type { Attempt, FailureKind, TriageResult } from './types.js';

/**
 * What has changed since the last attempt — which is the only thing that makes another call worth
 * spending money on.
 *
 * - `nothing` is the in-message loop: only a failure that a different model or a bigger token cap could
 *   fix gets another call immediately.
 * - `provider` is a later call in the same run having succeeded. The provider is answering, so anything
 *   waiting on the provider is now worth retrying. The attempt cap still applies.
 * - `operator` is a fresh run or an explicit "Retry pending": a person may have changed the key, funded
 *   the account, or edited the config, so every blocked row gets another look and the cap is lifted for
 *   one attempt. A cap that also blocked the manual retry would make the button a lie.
 */
export type Cleared = 'nothing' | 'provider' | 'operator';

/** A drain always has a trigger; `nothing` is not one of them. */
export type DrainTrigger = Exclude<Cleared, 'nothing'>;

interface FailurePolicy {
  /** Words for a person reading the row. The UI shows this, not the enum member. */
  phrase: string;
  /**
   * What the operator has to change, or null when nothing they can do helps and only time or a different
   * model will. A non-null fix is also what makes this failure operator-blocked rather than transient.
   */
  fix: string | null;
  /**
   * True only for a failure that is about THIS model's answer. A credential, a 429, a timeout, a 5xx or a
   * dropped connection happened to the request rather than to the model, so it must not spend a chain
   * slot: once the blocking condition clears the retry belongs on the same model, not on the next one
   * down. Getting this wrong permanently demotes the primary model because of one 429.
   */
  consumesChainSlot: boolean;
}

/**
 * Exhaustive by construction: a new `FailureKind` in types.ts fails to compile here until its behaviour is
 * declared, so the taxonomy cannot grow a failure the queue silently drops on the floor.
 */
export const FAILURE_POLICY: Record<FailureKind, FailurePolicy> = {
  no_key: {
    phrase: 'no API key was configured',
    fix: 'Set OPENROUTER_API_KEY in .env and run again - see the README quick start.',
    consumesChainSlot: false,
  },
  key_rejected: {
    phrase: 'the provider rejected the API key',
    fix: 'Replace OPENROUTER_API_KEY in .env with a valid key, then run again.',
    consumesChainSlot: false,
  },
  unfunded: {
    phrase: 'the API key is out of credit',
    fix: 'Add credit to the OpenRouter account this key belongs to, then run again.',
    consumesChainSlot: false,
  },
  rate_limited: { phrase: 'the provider rate-limited the request', fix: null, consumesChainSlot: false },
  timeout: { phrase: 'no reply arrived before the timeout', fix: null, consumesChainSlot: false },
  server_error: { phrase: 'the provider returned an error', fix: null, consumesChainSlot: false },
  network: { phrase: 'the request never reached the provider', fix: null, consumesChainSlot: false },
  // The two that are about the answer. `unparseable` is why our own fallthrough exists at all (D-013c):
  // OpenRouter's `models` array falls through on provider errors only, and an HTTP 200 containing prose is
  // a success to it, so it will never retry. `truncated` is handled a step earlier — it raises the cap on
  // the same model — and only consumes a slot once the token ceiling is reached.
  unparseable: { phrase: 'the reply did not match the schema', fix: null, consumesChainSlot: true },
  truncated: { phrase: 'the reply was cut off at the token limit', fix: null, consumesChainSlot: true },
};

/**
 * The cap on automatic attempts for one message: three chain members plus two raised-cap retries. It is a
 * spend ceiling, not a verdict — an operator-requested retry passes it, and the row says what was tried.
 */
export const MAX_ATTEMPTS = 5;

/** Each truncation doubles the cap. Two doublings from a 600-token default sit inside the ceiling. */
const TOKEN_GROWTH = 2;

/** No raise goes past this. Past it, a reply that still does not fit is the model's problem, not the cap's. */
export const TOKEN_CEILING = 4096;

export type RetryDecision =
  | { action: 'call'; model: string; maxTokens: number; why: string }
  | {
      action: 'wait';
      /** Which blocking condition has to clear. `operator` rows also carry `fix`. */
      clearsWhen: 'provider' | 'operator';
      why: string;
      fix: string | null;
    }
  | { action: 'stop'; why: string };

export interface RetryPlanInput {
  /** The ordered, capability-filtered chain from `modelChain()`. */
  chain: readonly string[];
  /** Every attempt already on the row, oldest first. Accumulates across runs. */
  attempts: readonly Attempt[];
  /** The configured `max_tokens`, before any truncation raise. */
  baseMaxTokens: number;
  cleared: Cleared;
}

/**
 * The whole policy, as one decision over the attempts already recorded. Deriving it from the attempt log
 * rather than from a counter on the side means the row and the decision can never disagree — what a person
 * reads in the attempt detail is exactly what the next call was planned from.
 */
export function planNextCall(input: RetryPlanInput): RetryDecision {
  const { chain, attempts, baseMaxTokens, cleared } = input;

  const primary = chain[0];
  if (primary === undefined) {
    return { action: 'stop', why: 'no structured-output-capable model is configured for triage' };
  }

  const last = attempts[attempts.length - 1];
  if (last === undefined) {
    return {
      action: 'call',
      model: primary,
      maxTokens: baseMaxTokens,
      why: `first attempt, on ${primary}`,
    };
  }
  if (last.ok) {
    return { action: 'stop', why: 'the last attempt succeeded, so there is nothing to retry' };
  }

  const policy = last.failure === undefined ? undefined : FAILURE_POLICY[last.failure];

  // A failure the chain cannot fix waits for its blocking condition instead of walking the chain. This is
  // the branch that keeps a 429 from spending three models to be rate-limited three times.
  if (policy !== undefined && !policy.consumesChainSlot) {
    const clearsWhen = policy.fix === null ? 'provider' : 'operator';
    const satisfied = cleared === 'operator' || (cleared === 'provider' && clearsWhen === 'provider');
    if (!satisfied) {
      return {
        action: 'wait',
        clearsWhen,
        why: `${attemptSummary(attempts)} - waiting because ${policy.phrase}`,
        fix: policy.fix,
      };
    }
  }

  if (cleared !== 'operator' && attempts.length >= MAX_ATTEMPTS) {
    return {
      action: 'stop',
      why: `${attemptSummary(attempts)} - the ${MAX_ATTEMPTS}-attempt cap is spent`,
    };
  }

  // A reply cut off at the ceiling is not a model-quality problem, so it raises the cap and retries the
  // SAME model. Burning a chain slot here would spend a better model on a defect a bigger number fixes.
  if (last.failure === 'truncated') {
    const raised = raisedCap(baseMaxTokens, truncationsOn(attempts, last.model));
    if (raised !== null) {
      return {
        action: 'call',
        model: last.model,
        maxTokens: raised,
        why: `${last.model} was cut off at the token limit; retrying it with max_tokens ${raised}`,
      };
    }
  }

  const spent = new Set(
    attempts
      .filter((a) => a.failure !== undefined && FAILURE_POLICY[a.failure].consumesChainSlot)
      .map((a) => a.model),
  );
  const untried = chain.find((slug) => !spent.has(slug));
  // An operator asking again after the chain is spent gets the primary a second time rather than a dead
  // button. Bounded: the attempt log grows, so the next automatic plan stops on the cap.
  const next = untried ?? (cleared === 'operator' ? primary : undefined);
  if (next === undefined) {
    return { action: 'stop', why: `${attemptSummary(attempts)} - the model chain is exhausted` };
  }

  return {
    action: 'call',
    model: next,
    maxTokens: baseMaxTokens,
    why:
      untried === undefined
        ? `retrying ${next} because a person asked for it`
        : `${policy?.phrase ?? 'the previous attempt failed'}; falling through to ${next}`,
  };
}

/**
 * The sentence a row has to be able to say for itself. Terminal in effect is fine; terminal and mute is
 * not — a capped row that cannot name what was tried is indistinguishable from a bug.
 */
export function attemptSummary(attempts: readonly Attempt[]): string {
  const last = attempts[attempts.length - 1];
  if (last === undefined) return 'no attempts yet';
  const models = new Set(attempts.map((a) => a.model)).size;
  const tail =
    last.failure !== undefined
      ? `, last failure: ${FAILURE_POLICY[last.failure].phrase}`
      : last.ok
        ? ', last attempt succeeded'
        : '';
  return `${plural(attempts.length, 'attempt')} across ${plural(models, 'model')}${tail}`;
}

/** The operator-facing fix for a row, or null when only time or a different model will help. */
export function fixForRow(attempts: readonly Attempt[]): string | null {
  const last = attempts[attempts.length - 1];
  if (last === undefined || last.failure === undefined) return null;
  return FAILURE_POLICY[last.failure].fix;
}

export interface DrainDeps {
  /**
   * Rows whose model call has not succeeded yet. The store is the authority rather than the current run's
   * own failures, so a row queued by an EARLIER run drains as soon as this run proves the provider answers.
   */
  pending: () => Promise<readonly TriageResult[]>;
  chain: readonly string[];
  baseMaxTokens: number;
  trigger: DrainTrigger;
  /** Re-runs the whole pipeline for one message and returns the row it wrote. */
  retry: (messageId: string, cleared: DrainTrigger) => Promise<TriageResult>;
}

export interface DrainReport {
  triaged: string[];
  stillPending: string[];
  /** Rows the drain deliberately did not spend a call on, each with the reason a person can read. */
  skipped: { messageId: string; why: string }[];
}

/**
 * One pass over the queue, and exactly one. A drain that re-drained its own output would be an unbounded
 * loop wearing robustness as a costume; whatever is still pending waits for the next trigger.
 *
 * Serial on purpose, unlike the run itself. A provider-triggered drain fires the moment a blip ends, and
 * the pool's width aimed at a fresh queue is the wrong amount of pressure to put on a service that just
 * came back.
 */
export async function drainPendingRetries(deps: DrainDeps): Promise<DrainReport> {
  const rows = await deps.pending();
  const report: DrainReport = { triaged: [], stillPending: [], skipped: [] };

  for (const row of rows) {
    const decision = planNextCall({
      chain: deps.chain,
      attempts: row.attempts,
      baseMaxTokens: deps.baseMaxTokens,
      cleared: deps.trigger,
    });
    if (decision.action !== 'call') {
      report.skipped.push({ messageId: row.message_id, why: decision.why });
      continue;
    }
    const written = await deps.retry(row.message_id, deps.trigger);
    if (written.status === 'triaged') report.triaged.push(row.message_id);
    else report.stillPending.push(row.message_id);
  }

  return report;
}

function raisedCap(base: number, truncations: number): number | null {
  const raised = base * TOKEN_GROWTH ** Math.max(1, truncations);
  return raised <= TOKEN_CEILING ? raised : null;
}

function truncationsOn(attempts: readonly Attempt[], model: string): number {
  return attempts.filter((a) => a.model === model && a.failure === 'truncated').length;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
