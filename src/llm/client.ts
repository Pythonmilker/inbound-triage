/**
 * The chat transport. One call, one message, one typed outcome.
 *
 * Every failure is typed and none are swallowed, because the fix differs per kind and the UI names the
 * fix: a rejected key wants a new key, an unfunded key wants money, a 429 wants time. Collapsing them
 * is how a dead credential hides behind a banner that says "rate limited" and the operator waits for
 * nothing. The sibling repo folds 402 into 429; that is the imprecision corrected here.
 *
 * What this file does NOT do is decide whether the model's answer is any good. It returns the parsed
 * reply as `unknown`; `src/triage/validate.ts` checks every field. A cast to `ModelVerdict` here would
 * hand downstream code a typed object nobody verified, which is exactly the defect this split exists to
 * prevent.
 */

import type { FailureKind } from '../triage/types.js';
import {
  buildTriageRequest,
  CHAT_ENDPOINT,
  estimateCostUsd,
  modelChain,
  type TriageRequestSpec,
} from './protocol.js';

/** Per-message triage, not long extraction — the sibling's 45s ceiling is far too patient for this. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Enough of a response body to name the cause, short enough to sit on a row in the UI. */
const DETAIL_LIMIT = 400;

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** null when the slug that answered is not in the registry, so its price is unknown. */
  costUsd: number | null;
}

export interface LlmCallOptions {
  apiKey: string;
  /**
   * Injectable so tests can assert the real request body and headers rather than the options object.
   * Defaults to global fetch.
   */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Overrides the chain's primary model. Wins over `spec.primaryOverride` when both are set. */
  model?: string;
}

export type LlmResult =
  | { ok: true; raw: unknown; model: string; usage?: LlmUsage }
  | { ok: false; failure: FailureKind; httpStatus?: number; detail?: string };

interface ChatCompletionEnvelope {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** OpenRouter can report an upstream refusal in the body of an HTTP 200. */
  error?: { message?: string };
}

/**
 * Status → kind. The granularity is the design decision: each kind maps to a different sentence in the
 * UI and a different thing for a human to go do.
 *
 * 402 is NOT rate limiting. "Out of credit — fund the key" and "slow down" are different jobs, and both
 * queue rather than terminate (D-013): the retry queue is a record of work we could not do yet, and it
 * drains when the operator fixes something just as readily as when the provider recovers.
 *
 * Everything unenumerated, including a 400, lands on `server_error`. The taxonomy in types.ts has no
 * `bad_request` kind and this module does not get to add one; `httpStatus` plus the response body carry
 * the precision that the coarse kind loses.
 */
function kindForStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return 'key_rejected';
  if (status === 402) return 'unfunded';
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'timeout';
  return 'server_error';
}

/**
 * A bare "HTTP 400" is unactionable — the body is where OpenRouter says which parameter it disliked,
 * and that is the difference between a five-minute fix and a week of "the model path seems flaky".
 */
async function failureFromResponse(response: Response): Promise<LlmResult> {
  const detail = await response
    .text()
    .then((body) => body.slice(0, DETAIL_LIMIT))
    .catch(() => '');
  const failure = kindForStatus(response.status);
  return detail
    ? { ok: false, failure, httpStatus: response.status, detail }
    : { ok: false, failure, httpStatus: response.status };
}

function usageFrom(payload: ChatCompletionEnvelope, slug: string): LlmUsage | undefined {
  const reported = payload.usage;
  if (typeof reported?.prompt_tokens !== 'number' || typeof reported.completion_tokens !== 'number') {
    return undefined;
  }
  return {
    promptTokens: reported.prompt_tokens,
    completionTokens: reported.completion_tokens,
    costUsd: estimateCostUsd(slug, reported.prompt_tokens, reported.completion_tokens),
  };
}

export async function callTriage(spec: TriageRequestSpec, opts: LlmCallOptions): Promise<LlmResult> {
  // The app refuses to start without a key (D-014), so this is a label rather than a mode: if an empty
  // key ever reaches here, `Bearer ` earns a 401 and the row would read "key rejected" — which sends
  // the operator to rotate a credential that was never set.
  if (!opts.apiKey) return { ok: false, failure: 'no_key' };

  const override = opts.model ?? spec.primaryOverride;
  const chain = modelChain(override);
  const body = buildTriageRequest(override ? { ...spec, primaryOverride: override } : spec);

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
        // OpenRouter attributes traffic with these two, which keeps its dashboard readable.
        'HTTP-Referer': 'https://github.com/Pythonmilker/inbound-triage',
        'X-Title': 'Inbound Triage Assistant',
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) return await failureFromResponse(response);

    const text = await response.text();
    let payload: ChatCompletionEnvelope;
    try {
      payload = JSON.parse(text) as ChatCompletionEnvelope;
    } catch {
      return {
        ok: false,
        failure: 'unparseable',
        httpStatus: response.status,
        detail: `200 with a non-JSON body: ${text.slice(0, DETAIL_LIMIT)}`,
      };
    }

    const choice = payload.choices?.[0];
    const answered = payload.model ?? chain[0] ?? 'unknown';

    // `truncated` is separated from `unparseable` because the remedy differs and only the envelope can
    // tell them apart: a reply cut at the ceiling is a max_tokens problem, so it raises the cap and
    // retries the SAME model instead of spending a chain slot on a model that did nothing wrong. Once
    // the text is all we have, a truncated body is indistinguishable from an incompetent one.
    if (choice?.finish_reason === 'length') {
      return {
        ok: false,
        failure: 'truncated',
        detail: `${answered} stopped at max_tokens (${spec.maxTokens})`,
      };
    }

    const content = choice?.message?.content;
    if (!content) {
      return {
        ok: false,
        failure: 'unparseable',
        detail: payload.error?.message ?? 'empty completion',
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      // Reaching here means a provider ignored response_format, which is the one failure
      // `provider.require_parameters` exists to prevent. Worth naming rather than guessing.
      return {
        ok: false,
        failure: 'unparseable',
        detail: `${answered} returned prose, not JSON — check provider.require_parameters`,
      };
    }

    const usage = usageFrom(payload, answered);
    return usage ? { ok: true, raw, model: answered, usage } : { ok: true, raw, model: answered };
  } catch (err) {
    // Checking the signal rather than only the error type: an injected fetch may reject with a plain
    // Error named AbortError, or with something else entirely once the controller has fired.
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return { ok: false, failure: 'timeout', detail: `no response within ${timeoutMs}ms` };
    }
    return {
      ok: false,
      failure: 'network',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
