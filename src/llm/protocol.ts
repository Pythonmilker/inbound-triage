/**
 * The OpenRouter wire protocol for one job: triage a single inbound message.
 *
 * There is exactly one task here, so there are no tiers — one chain, escalating on capability rather
 * than on job difficulty. The primary is an 8B because at 13 messages the whole queue costs about
 * $0.0003 and cost cannot discriminate between candidates; what a fallback buys is a *different*
 * failure mode, which is why the second slot crosses vendors instead of taking a bigger Llama first.
 *
 * Two traps are guarded here and both cost real debugging time in sibling projects:
 *
 *   1. Structured-output support is a property of the ENDPOINT, not the model. The registry filter in
 *      `modelChain` stops us naming a model that cannot do the job; `provider.require_parameters` in
 *      `buildTriageRequest` stops OpenRouter routing a suitable slug to an unsuitable provider. Skip
 *      either and a call returns HTTP 200 containing prose — no error, no retry.
 *   2. A `models` array longer than three is a 400, and a 400 does not fall through. See
 *      MAX_CHAIN_MODELS.
 *
 * Prices are OpenRouter's own, per million tokens, read from the live catalogue on 2026-08-18. A
 * vendor's first-party rate card is not what this bills against.
 */

import { TRIAGE_SCHEMA, TRIAGE_SCHEMA_NAME } from '../triage/schema.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const CHAT_ENDPOINT = `${OPENROUTER_BASE}/chat/completions`;

/** What we know about a model, and the reason we are allowed to put it in a chain. */
export interface ModelFacts {
  slug: string;
  /** OpenRouter's `supported_parameters` includes "structured_outputs". */
  structuredOutputs: boolean;
  /** OpenRouter's `supported_parameters` includes "temperature". */
  temperature: boolean;
  /** USD per million prompt tokens. */
  inPerM: number;
  /** USD per million completion tokens. */
  outPerM: number;
}

export const MODEL_REGISTRY: Record<string, ModelFacts> = {
  'meta-llama/llama-3.1-8b-instruct': {
    slug: 'meta-llama/llama-3.1-8b-instruct',
    structuredOutputs: true,
    temperature: true,
    inPerM: 0.05,
    outPerM: 0.08,
  },
  'openai/gpt-4.1-nano': {
    slug: 'openai/gpt-4.1-nano',
    structuredOutputs: true,
    temperature: true,
    inPerM: 0.1,
    outPerM: 0.4,
  },
  'meta-llama/llama-3.3-70b-instruct': {
    slug: 'meta-llama/llama-3.3-70b-instruct',
    structuredOutputs: true,
    temperature: true,
    inPerM: 0.1,
    outPerM: 0.32,
  },
  /**
   * Registered but not in the default chain. At 20× the 8B's input price it is not what a 13-message
   * queue reaches for by default, and with the chain capped at three, naming it here would push out a
   * capable model that costs a fraction of it. It is reachable through `primaryOverride`, which is
   * also the model-override example the README has to show.
   */
  'anthropic/claude-haiku-4.5': {
    slug: 'anthropic/claude-haiku-4.5',
    structuredOutputs: true,
    temperature: true,
    inPerM: 1.0,
    outPerM: 5.0,
  },

  /**
   * Registered on purpose, with the flag that disqualifies it.
   *
   * `qwen/qwen3-8b` reports `response_format: true` and `structured_outputs: false`: it looks like a
   * sensible cheap fallback beside the 8B above, at a similar price, and it is not one. Without
   * `require_parameters` it answers in prose the schema never constrained; with it, OpenRouter refuses
   * to route there at all.
   *
   * It lives in the registry rather than outside it so that `modelChain`'s filter has something to
   * discriminate on. With every entry reporting `structuredOutputs: true` that filter was an allowlist
   * wearing a capability check's clothes — it rejected unknown slugs and had never once rejected a slug
   * for the reason its name gives.
   */
  'qwen/qwen3-8b': {
    slug: 'qwen/qwen3-8b',
    structuredOutputs: false,
    temperature: true,
    inPerM: 0.117,
    outPerM: 0.455,
  },
};

/**
 * OpenRouter rejects a `models` array longer than this with HTTP 400:
 *   "'models' array must have 3 items or fewer."
 *
 * A 400 is a malformed request, so it does NOT fall through to the next model — it kills the call.
 * This shipped once as a four-model chain that 400'd on every request while a deterministic path
 * answered and the offline suite stayed green, so the model layer was dead for days. `modelChain`
 * truncates rather than trusting the caller to count.
 */
export const MAX_CHAIN_MODELS = 3;

/**
 * Cheap primary, then a different vendor, then a much larger model of the first family.
 *
 * The order is escalation for our own fallthrough (DESIGN §4.2b): OpenRouter's `models` array only
 * falls through on provider errors, so a reply that fails validation is re-requested against the next
 * slug by us. Slot 2 crosses vendors deliberately — a second Llama is likelier to reproduce the first
 * one's mistake than to correct it.
 */
export const TRIAGE_CHAIN: readonly string[] = [
  'meta-llama/llama-3.1-8b-instruct',
  'openai/gpt-4.1-nano',
  'meta-llama/llama-3.3-70b-instruct',
];

/**
 * The ordered chain for a triage call.
 *
 * An override that is unregistered or not structured-output-capable is dropped here rather than
 * throwing: the caller records which slug actually answered (see `client.ts`), so an ignored override
 * is visible on the row instead of being taken on trust.
 */
export function modelChain(primaryOverride?: string): string[] {
  const configured = primaryOverride
    ? [primaryOverride, ...TRIAGE_CHAIN.filter((slug) => slug !== primaryOverride)]
    : [...TRIAGE_CHAIN];

  const usable = configured.filter((slug) => MODEL_REGISTRY[slug]?.structuredOutputs === true);
  return usable.slice(0, MAX_CHAIN_MODELS);
}

/**
 * Temperature is one top-level parameter applied to whichever chain member runs, so it has to suit all
 * of them. It matters more than it looks: with `require_parameters: true` set, every parameter in the
 * body becomes a routing constraint, so sending `temperature` to a member that does not accept it
 * narrows the eligible endpoints instead of being quietly ignored. Nothing in the registry currently
 * reports `temperature: false`, so this check has nothing to reject today — unlike the
 * structured-output filter, which does.
 */
function chainAcceptsTemperature(chain: readonly string[]): boolean {
  return chain.every((slug) => MODEL_REGISTRY[slug]?.temperature === true);
}

export interface TriageRequestSpec {
  system: string;
  user: string;
  maxTokens: number;
  primaryOverride?: string;
}

/**
 * The one place a triage request body is built, so the app, the eval script and any future caller
 * cannot drift into sending different requests.
 *
 * `temperature: 0` is sent to remove one source of variation. It is NOT a determinism guarantee —
 * identical input can still differ across batching and provider routing — and nothing here or
 * downstream may claim otherwise. Determinism lives in the envelope: closed enums, re-validation, the
 * rule floor and reconciliation.
 */
export function buildTriageRequest(spec: TriageRequestSpec): Record<string, unknown> {
  const models = modelChain(spec.primaryOverride);
  if (models.length === 0) {
    throw new Error('no structured-output-capable model configured for triage');
  }

  return {
    models,
    max_tokens: spec.maxTokens,
    ...(chainAcceptsTemperature(models) ? { temperature: 0 } : {}),
    messages: [
      { role: 'system', content: spec.system },
      { role: 'user', content: spec.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: TRIAGE_SCHEMA_NAME, strict: true, schema: TRIAGE_SCHEMA },
    },
    // Mandatory, and the second half of trap (1) in the header: structured-output support belongs to
    // the ENDPOINT, not the model. Without this OpenRouter may route a capable slug to a provider that
    // ignores response_format and returns prose with an HTTP 200 — no error, no retry, just
    // unstructured text where a schema was promised.
    provider: { require_parameters: true },
  };
}

/**
 * Rough cost of one call, for the cost line the UI shows.
 *
 * `null` rather than 0 for a slug we never priced: a zero disappears into a total and reads as free.
 */
export function estimateCostUsd(slug: string, inTokens: number, outTokens: number): number | null {
  const facts = MODEL_REGISTRY[slug];
  if (!facts || facts.inPerM < 0) return null;
  return (inTokens / 1e6) * facts.inPerM + (outTokens / 1e6) * facts.outPerM;
}
