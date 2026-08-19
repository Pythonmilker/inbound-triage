/**
 * The wire protocol, asserted on the body that would actually be sent.
 *
 * Every claim here is about a value inside the request body rather than about the options object that
 * produced it. A transport can be correct in its options type and wrong at the call site, and that
 * mistake is invisible to a test that only inspects what it handed in — which is why the last test here
 * goes through `callTriage` and reads the body off the recorded request.
 */

import { describe, expect, it } from 'vitest';

import { callTriage } from '../src/llm/client.js';
import {
  MAX_CHAIN_MODELS,
  MODEL_REGISTRY,
  TRIAGE_CHAIN,
  buildTriageRequest,
  estimateCostUsd,
  modelChain,
  type TriageRequestSpec,
} from '../src/llm/protocol.js';
import { TRIAGE_SCHEMA, TRIAGE_SCHEMA_NAME } from '../src/triage/schema.js';

const SPEC: TriageRequestSpec = { system: 'system prompt', user: 'user prompt', maxTokens: 600 };

const PRIMARY = 'meta-llama/llama-3.1-8b-instruct';

/** Registered and disqualified by its own capability flag — see MODEL_REGISTRY's note on it. */
const UNCAPABLE = 'qwen/qwen3-8b';

/** Registered, capable, and deliberately absent from the default chain: the override example. */
const OFF_CHAIN = 'anthropic/claude-haiku-4.5';

const NOT_REGISTERED = 'nobody/never-heard-of-it';

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is ${JSON.stringify(value)}, not an object`);
  }
  return value as Record<string, unknown>;
}

/** Reads `models` without casting the body: an assertion about a body has to survive `unknown`. */
function models(body: Record<string, unknown>): string[] {
  const value = body['models'];
  if (!isUnknownArray(value)) throw new Error(`models is ${JSON.stringify(value)}, not an array`);
  return value.map((slug, index) => {
    if (typeof slug !== 'string') {
      throw new Error(`models[${index}] is ${JSON.stringify(slug)}, not a slug`);
    }
    return slug;
  });
}

function bodyFor(primary: string | undefined): Record<string, unknown> {
  return buildTriageRequest(primary === undefined ? SPEC : { ...SPEC, primaryOverride: primary });
}

/** Every path into the builder: the default chain, plus each registry slug as the primary override. */
const EVERY_PRIMARY: readonly (string | undefined)[] = [
  undefined,
  ...Object.keys(MODEL_REGISTRY),
  NOT_REGISTERED,
];

function vendorOf(slug: string): string {
  const vendor = slug.split('/')[0];
  if (vendor === undefined || vendor === '') throw new Error(`${slug} has no vendor prefix`);
  return vendor;
}

describe('the models array', () => {
  it('is an array on every path, and no scalar model field is ever sent', () => {
    for (const primary of EVERY_PRIMARY) {
      const body = bodyFor(primary);
      const keys = Object.keys(body);
      expect(keys, `primary ${String(primary)}`).toContain('models');
      // A scalar `model` beside `models` is what OpenRouter reads instead of the chain, so the
      // fallthrough would silently stop existing while every other assertion still passed.
      expect(keys, `primary ${String(primary)}`).not.toContain('model');
      expect(models(body).length, `primary ${String(primary)}`).toBeGreaterThan(0);
    }
  });

  it('never exceeds the three-model cap, on every path', () => {
    expect(MAX_CHAIN_MODELS).toBe(3);
    for (const primary of EVERY_PRIMARY) {
      expect(models(bodyFor(primary)).length, `primary ${String(primary)}`).toBeLessThanOrEqual(
        MAX_CHAIN_MODELS,
      );
    }
  });

  it('truncates a four-model chain instead of sending one', () => {
    // The construction that produces four: an override that is not already in the chain. A naive
    // concat sends [override, ...three], OpenRouter answers 400, and a 400 does not fall through —
    // so the call is dead rather than degraded.
    expect(TRIAGE_CHAIN).not.toContain(OFF_CHAIN);
    expect(MODEL_REGISTRY[OFF_CHAIN]?.structuredOutputs).toBe(true);
    expect([OFF_CHAIN, ...TRIAGE_CHAIN]).toHaveLength(4);

    const sent = models(bodyFor(OFF_CHAIN));
    expect(sent).toHaveLength(MAX_CHAIN_MODELS);
    expect(sent).toEqual([OFF_CHAIN, ...TRIAGE_CHAIN.slice(0, MAX_CHAIN_MODELS - 1)]);
    expect(sent).not.toContain(TRIAGE_CHAIN[MAX_CHAIN_MODELS - 1]);
  });

  it('moves an override that is already in the chain to the front without lengthening it', () => {
    const last = TRIAGE_CHAIN[TRIAGE_CHAIN.length - 1];
    if (last === undefined) throw new Error('the triage chain is empty');

    const sent = models(bodyFor(last));
    expect(sent[0]).toBe(last);
    expect(sent).toHaveLength(TRIAGE_CHAIN.length);
    expect([...sent].sort()).toEqual([...TRIAGE_CHAIN].sort());
  });

  it('drops an unregistered override rather than naming a slug nothing is known about', () => {
    expect(MODEL_REGISTRY[NOT_REGISTERED]).toBeUndefined();
    expect(models(bodyFor(NOT_REGISTERED))).toEqual([...TRIAGE_CHAIN]);
  });

  it('crosses vendors at the second slot', () => {
    const first = TRIAGE_CHAIN[0];
    const second = TRIAGE_CHAIN[1];
    if (first === undefined || second === undefined) {
      throw new Error('the chain needs a second member for the fallthrough to buy anything');
    }
    // A second model from the same family is likelier to reproduce the first one's mistake than to
    // correct it, so a same-vendor slot 2 buys no new failure mode (DESIGN §6).
    expect(vendorOf(second)).not.toBe(vendorOf(first));
  });

  it('rejects a REGISTERED model on the structuredOutputs flag', () => {
    // The point of this test: a capability filter that has never rejected anything for the reason its
    // name gives is an allowlist in disguise. `qwen/qwen3-8b` is in the registry precisely so the
    // filter has something to discriminate on — it reports response_format true and
    // structured_outputs false, so without this it answers prose with an HTTP 200.
    const facts = MODEL_REGISTRY[UNCAPABLE];
    expect(facts, `${UNCAPABLE} must stay registered for this filter to be tested at all`).toBeDefined();
    expect(facts?.structuredOutputs).toBe(false);

    expect(modelChain(UNCAPABLE)).not.toContain(UNCAPABLE);
    expect(models(bodyFor(UNCAPABLE))).toEqual([...TRIAGE_CHAIN]);

    const rejected = Object.values(MODEL_REGISTRY)
      .filter((entry) => !entry.structuredOutputs)
      .map((entry) => entry.slug);
    expect(rejected).toContain(UNCAPABLE);

    for (const slug of TRIAGE_CHAIN) {
      expect(MODEL_REGISTRY[slug]?.structuredOutputs, slug).toBe(true);
    }
  });
});

describe('the rest of the body', () => {
  it('requires the provider to accept every parameter, on every path', () => {
    for (const primary of EVERY_PRIMARY) {
      // Half of the endpoint trap: structured-output support belongs to the endpoint, not the model.
      // Without this, a capable slug can be routed to a provider that ignores response_format.
      expect(bodyFor(primary), `primary ${String(primary)}`).toMatchObject({
        provider: { require_parameters: true },
      });
    }
  });

  it('asks for the triage schema in strict json_schema mode', () => {
    for (const primary of EVERY_PRIMARY) {
      expect(bodyFor(primary)['response_format'], `primary ${String(primary)}`).toEqual({
        type: 'json_schema',
        json_schema: { name: TRIAGE_SCHEMA_NAME, strict: true, schema: TRIAGE_SCHEMA },
      });
    }
  });

  it('carries the two messages and the token cap it was given', () => {
    const body = bodyFor(undefined);
    expect(body['messages']).toEqual([
      { role: 'system', content: SPEC.system },
      { role: 'user', content: SPEC.user },
    ]);
    expect(body['max_tokens']).toBe(SPEC.maxTokens);
    expect(body['temperature']).toBe(0);
  });

  it('prices a registered slug and returns null for one it never priced', () => {
    expect(TRIAGE_CHAIN[0]).toBe(PRIMARY);
    expect(estimateCostUsd(PRIMARY, 1_000_000, 1_000_000)).toBeCloseTo(0.13, 10);
    // Null rather than 0: a zero disappears into a total and reads as free.
    expect(estimateCostUsd(NOT_REGISTERED, 1_000_000, 1_000_000)).toBeNull();
  });
});

describe('the body that actually goes out', () => {
  it('puts the caller override in models on the wire, not in a scalar field', async () => {
    const sent: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : 'null'));
      return new Response('{}', { status: 500 });
    };

    // The 500 is incidental — the subject is the request, and a failed response still recorded one.
    await callTriage(SPEC, { apiKey: 'unit-test-key', fetchImpl, model: OFF_CHAIN });

    expect(sent).toHaveLength(1);
    const body = asRecord(sent[0], 'the recorded body');
    expect(Object.keys(body)).not.toContain('model');
    expect(models(body)).toEqual([OFF_CHAIN, ...TRIAGE_CHAIN.slice(0, MAX_CHAIN_MODELS - 1)]);
    expect(body).toMatchObject({ provider: { require_parameters: true } });
  });

  it('refuses to send an empty models array', () => {
    // Temporarily disqualifying the whole chain is the only way to reach the empty case, and the
    // guard matters: `models: []` is another 400, and a 400 kills the call rather than falling
    // through. Restored in `finally` so the mutation cannot leak into another test.
    const saved = TRIAGE_CHAIN.map((slug) => MODEL_REGISTRY[slug]);
    try {
      for (const slug of TRIAGE_CHAIN) {
        const facts = MODEL_REGISTRY[slug];
        if (facts === undefined) throw new Error(`${slug} is in the chain but not in the registry`);
        MODEL_REGISTRY[slug] = { ...facts, structuredOutputs: false };
      }
      expect(modelChain()).toEqual([]);
      expect(() => buildTriageRequest(SPEC)).toThrow(/no structured-output-capable model/);
    } finally {
      TRIAGE_CHAIN.forEach((slug, index) => {
        const facts = saved[index];
        if (facts !== undefined) MODEL_REGISTRY[slug] = facts;
      });
    }
  });
});
