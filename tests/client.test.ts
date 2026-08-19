/**
 * The transport, through a recording fetch: URL, headers and the real request body.
 *
 * Two properties are load-bearing enough to be worth the whole file. The status map has to stay
 * granular — 402 is "fund the key" and 429 is "wait", and a repo that folds them together sends the
 * operator to wait for something that will never happen. And the client must return the reply as
 * `unknown`: the moment it casts, downstream code holds a typed object nobody checked, which is the
 * defect the client/validate split exists to prevent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { callTriage, type LlmResult } from '../src/llm/client.js';
import { CHAT_ENDPOINT, MODEL_REGISTRY, TRIAGE_CHAIN, type TriageRequestSpec } from '../src/llm/protocol.js';
import type { FailureKind } from '../src/triage/types.js';

const SPEC: TriageRequestSpec = { system: 'system prompt', user: 'user prompt', maxTokens: 600 };

/** Distinctive so a leak is findable, and shaped so nothing mistakes it for a credential. */
const KEY = 'unit-test-key-do-not-ship';

const ANSWERING_MODEL = 'meta-llama/llama-3.1-8b-instruct';

interface Recorded {
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

interface Harness {
  fetchImpl: typeof fetch;
  calls: Recorded[];
}

function recording(reply: (index: number) => Response): Harness {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    calls.push({
      url: String(input),
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : 'null'),
    });
    return reply(calls.length - 1);
  };
  return { fetchImpl, calls };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function completion(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    model: ANSWERING_MODEL,
    choices: [{ message: { content }, finish_reason: 'stop', ...extra }],
    usage: { prompt_tokens: 700, completion_tokens: 120 },
  };
}

const VALID_VERDICT = {
  summary: 'Wants an updated portfolio statement by Friday.',
  evidence: '"by this Friday"',
  category: 'existing_client',
  priority: 'high',
  next_action: 'Send the statement today.',
  confidence: 0.82,
};

/** A fetch that fails the test if it is called at all. */
const neverCalled: typeof fetch = async () => {
  throw new Error('the client sent a request it should not have sent');
};

/** Hangs until the client's own timer aborts it, the way a stalled provider does. */
const hanging: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) {
      reject(new Error('the client passed no abort signal, so nothing can ever time this out'));
      return;
    }
    signal.addEventListener('abort', () => {
      // A plain Error named AbortError, not a DOMException: an injected fetch may reject with either,
      // and the client is not allowed to depend on which.
      const error = new Error('the injected fetch was aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

const refusing: typeof fetch = async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:443');
};

async function callWith(reply: (index: number) => Response): Promise<LlmResult> {
  return callTriage(SPEC, { apiKey: KEY, fetchImpl: recording(reply).fetchImpl });
}

async function callStatus(status: number, body = '{"error":{"message":"nope"}}'): Promise<LlmResult> {
  return callWith(() => new Response(body, { status }));
}

/**
 * One scenario per failure kind, as a Record so the union cannot grow a member with no test: adding a
 * `FailureKind` in types.ts fails to compile here until its behaviour is pinned.
 */
const KIND_SCENARIOS: Record<FailureKind, () => Promise<LlmResult>> = {
  no_key: () => callTriage(SPEC, { apiKey: '', fetchImpl: neverCalled }),
  key_rejected: () => callStatus(401),
  unfunded: () => callStatus(402),
  rate_limited: () => callStatus(429),
  timeout: () => callTriage(SPEC, { apiKey: KEY, fetchImpl: hanging, timeoutMs: 5 }),
  server_error: () => callStatus(500),
  network: () => callTriage(SPEC, { apiKey: KEY, fetchImpl: refusing }),
  unparseable: () => callWith(() => json(completion('Sure! This looks like a prospect to me.'))),
  truncated: () =>
    callWith(() => json(completion('{"summary":"a partial', { finish_reason: 'length' }))),
};

function failure(result: LlmResult): { failure: FailureKind; httpStatus?: number; detail?: string } {
  if (result.ok) throw new Error(`expected a failure, got ok with model ${result.model}`);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the request', () => {
  it('posts to the OpenRouter chat endpoint with the key in the Authorization header', async () => {
    const harness = recording(() => json(completion(JSON.stringify(VALID_VERDICT))));
    const result = await callTriage(SPEC, { apiKey: KEY, fetchImpl: harness.fetchImpl });

    expect(result.ok).toBe(true);
    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0];
    if (call === undefined) throw new Error('no request was recorded');

    expect(call.url).toBe(CHAT_ENDPOINT);
    expect(call.url.startsWith('https://')).toBe(true);
    expect(call.authorization).toBe(`Bearer ${KEY}`);
    expect(call.contentType).toBe('application/json');

    // A bearer secret belongs in a header and nowhere else: a URL lands in logs and proxies, and a
    // body is echoed back by more services than you would guess.
    expect(call.url).not.toContain(KEY);
    expect(JSON.stringify(call.body)).not.toContain(KEY);
  });

  it('sends no request at all when there is no key', async () => {
    const result = await KIND_SCENARIOS.no_key();
    expect(failure(result).failure).toBe('no_key');
    // `Bearer ` with nothing after it earns a 401, and the row would then read "key rejected" — which
    // sends the operator to rotate a credential that was never set.
    expect(failure(result).httpStatus).toBeUndefined();
  });
});

describe('status to failure kind', () => {
  const MAP: readonly [number, FailureKind][] = [
    [400, 'server_error'],
    [401, 'key_rejected'],
    [402, 'unfunded'],
    [403, 'key_rejected'],
    [404, 'server_error'],
    [408, 'timeout'],
    [418, 'server_error'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [502, 'server_error'],
    [503, 'server_error'],
  ];

  it.each(MAP)('maps HTTP %i to %s', async (status, kind) => {
    const result = await callStatus(status);
    expect(failure(result).failure).toBe(kind);
    expect(failure(result).httpStatus).toBe(status);
  });

  it('maps 402 to unfunded and NOT to rate_limited', async () => {
    // The two need different fixes — fund the key versus wait — and both queue rather than terminate.
    // Folding 402 into 429 is the sibling repo's imprecision; it makes the banner tell the operator to
    // wait for a credit balance that will never refill itself.
    const result = await callStatus(402);
    expect(failure(result).failure).toBe('unfunded');
    expect(failure(result).failure).not.toBe('rate_limited');
    expect(failure(result).failure).not.toBe('key_rejected');
  });

  it('never reads an unenumerated status as a credential problem', async () => {
    for (const [status, kind] of MAP) {
      if (status === 401 || status === 403) continue;
      const result = await callStatus(status);
      expect(failure(result).failure, `HTTP ${status}`).not.toBe('key_rejected');
      expect(failure(result).failure, `HTTP ${status}`).toBe(kind);
    }
  });

  it("puts a 400's response body in detail", async () => {
    // A bare "HTTP 400" is unactionable: the body is where OpenRouter names the parameter it disliked,
    // and that is the difference between a five-minute fix and a week of "the model path seems flaky".
    const body = '{"error":{"message":"minimum is not a supported schema keyword"}}';
    const result = await callStatus(400, body);
    expect(failure(result).detail).toContain('minimum is not a supported schema keyword');
    expect(failure(result).httpStatus).toBe(400);
  });

  it('aborts and reports a timeout when no reply arrives', async () => {
    const result = await callTriage(SPEC, { apiKey: KEY, fetchImpl: hanging, timeoutMs: 5 });
    expect(failure(result).failure).toBe('timeout');
    expect(failure(result).detail).toContain('5ms');
  });

  it('reports a refused connection as network, not as a server error', async () => {
    const result = await KIND_SCENARIOS.network();
    expect(failure(result).failure).toBe('network');
    expect(failure(result).detail).toContain('ECONNREFUSED');
  });

  it('covers every failure kind in the taxonomy', async () => {
    for (const [kind, run] of Object.entries(KIND_SCENARIOS)) {
      const result = await run();
      expect(failure(result).failure, kind).toBe(kind);
    }
  });
});

describe('a 200 that is not a verdict', () => {
  it('separates a reply cut off at max_tokens from one that never matched the schema', async () => {
    const cut = await KIND_SCENARIOS.truncated();
    expect(failure(cut).failure).toBe('truncated');
    expect(failure(cut).detail).toContain('max_tokens');

    // Only the envelope can tell these apart: once the text is all there is, a truncated reply is
    // indistinguishable from an incompetent one, and they are fixed differently.
    const prose = await KIND_SCENARIOS.unparseable();
    expect(failure(prose).failure).toBe('unparseable');
    expect(failure(prose).detail).toContain('require_parameters');
  });

  it('names a non-JSON body and an empty completion without guessing', async () => {
    const notJson = await callWith(() => new Response('<html>gateway</html>', { status: 200 }));
    expect(failure(notJson).failure).toBe('unparseable');
    expect(failure(notJson).detail).toContain('non-JSON body');

    const empty = await callWith(() =>
      json({ model: ANSWERING_MODEL, choices: [], error: { message: 'upstream refused' } }),
    );
    expect(failure(empty).failure).toBe('unparseable');
    expect(failure(empty).detail).toContain('upstream refused');
  });
});

describe('what comes back on success', () => {
  it('returns the parsed reply as unknown and validates nothing', async () => {
    // A schema-violating payload: wrong category, wrong type on confidence, three fields absent. The
    // client must hand it back untouched — deciding whether it is any good is validate.ts's job, and a
    // cast here would hand a caller a typed object nobody checked.
    const nonsense = { category: 'not-a-category', confidence: 'high', summary: 42 };
    const result = await callWith(() => json(completion(JSON.stringify(nonsense))));

    if (!result.ok) throw new Error(`expected ok, got ${result.failure}`);
    expect(result.raw).toEqual(nonsense);
    expect(result.model).toBe(ANSWERING_MODEL);

    type Success = Extract<LlmResult, { ok: true }>;
    // `unknown` is assignable only to `unknown`, so narrowing `raw` to a verdict type turns this
    // annotation into `false` and the assignment stops compiling.
    type UnknownIsAssignableTo<T> = [unknown] extends [T] ? true : false;
    const rawStaysUnknown: UnknownIsAssignableTo<Success['raw']> = true;
    expect(rawStaysUnknown).toBe(true);
  });

  it('reports the slug that answered, falling back to the one we asked for first', async () => {
    const named = await callWith(() => json(completion(JSON.stringify(VALID_VERDICT))));
    if (!named.ok) throw new Error(`expected ok, got ${named.failure}`);
    expect(named.model).toBe(ANSWERING_MODEL);

    const anonymous = await callWith(() =>
      json({ choices: [{ message: { content: JSON.stringify(VALID_VERDICT) } }] }),
    );
    if (!anonymous.ok) throw new Error(`expected ok, got ${anonymous.failure}`);
    expect(anonymous.model).toBe(TRIAGE_CHAIN[0]);
    expect(anonymous.usage).toBeUndefined();
  });

  it('prices the call from the slug that answered, and leaves an unknown slug unpriced', async () => {
    const priced = await callWith(() => json(completion(JSON.stringify(VALID_VERDICT))));
    if (!priced.ok) throw new Error(`expected ok, got ${priced.failure}`);
    const facts = MODEL_REGISTRY[ANSWERING_MODEL];
    if (facts === undefined) throw new Error(`${ANSWERING_MODEL} is not in the registry`);
    expect(priced.usage?.costUsd).toBeCloseTo(
      (700 / 1e6) * facts.inPerM + (120 / 1e6) * facts.outPerM,
      12,
    );

    const unknownSlug = await callWith(() =>
      json({
        model: 'nobody/never-heard-of-it',
        choices: [{ message: { content: JSON.stringify(VALID_VERDICT) } }],
        usage: { prompt_tokens: 700, completion_tokens: 120 },
      }),
    );
    if (!unknownSlug.ok) throw new Error(`expected ok, got ${unknownSlug.failure}`);
    expect(unknownSlug.usage?.costUsd).toBeNull();
  });
});

describe('the key', () => {
  it('never appears in any message the client produces, on any path', async () => {
    for (const [kind, run] of Object.entries(KIND_SCENARIOS)) {
      const result = await run();
      // Covers `detail`, which is the only free-text field the client writes, plus everything else it
      // returns. A provider body is quoted verbatim into `detail`, so the key must never be in one.
      expect(JSON.stringify(result), kind).not.toContain(KEY);
    }

    const success = await callWith(() => json(completion(JSON.stringify(VALID_VERDICT))));
    expect(JSON.stringify(success)).not.toContain(KEY);
  });

  it('never reaches the console, because the client logs nothing at all', async () => {
    const sinks = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );

    for (const run of Object.values(KIND_SCENARIOS)) await run();
    await callWith(() => json(completion(JSON.stringify(VALID_VERDICT))));

    for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
  });
});
