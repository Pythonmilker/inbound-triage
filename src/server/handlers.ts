/**
 * The `/api` surface, and the only place in the app that reads the key.
 *
 * The browser talks to these five endpoints and never holds a credential (R8). The key is read from the
 * environment HERE, handed to the engine as configuration, and never returned in a response — not in
 * full, not masked, not as a prefix or a length. `/api/health` reports whether a key is *present*,
 * because that is the one thing an operator needs to know, and nothing else about it.
 *
 * Reads are GET so they can be opened in a browser tab while debugging; anything that can spend a model
 * call is a POST.
 *
 * The engine and the store are built PER REQUEST from the environment. That is what `createTriageEngine`
 * being a factory buys (DESIGN §2.3): a changed model or database path takes effect on the next request
 * rather than on a restart, two requests cannot share mutable state, and this module keeps none — which
 * matters because Vite re-evaluates it through `ssrLoadModule` on every edit, and a cached database
 * handle would be left open by that reload with nothing holding a reference to close it.
 */

import { resolve } from 'node:path';

import { loadInbound } from '../ingest/load.js';
import { modelChain } from '../llm/protocol.js';
import { createSqliteStore } from '../store/sqlite.js';
import type { Store } from '../store/types.js';
import { createTriageEngine, type RunSummary, type TriageEngine } from '../triage/run.js';
import type { InboundMessage, TriageResult } from '../triage/types.js';

/** The queue's source of truth. Re-read on every request, so an edited message re-triages. */
const DEFAULT_INBOUND = 'raw/inbound.json';

/** Created on first use, and gitignored — a fresh clone starts with no database and no rows. */
const DEFAULT_DB = 'data/triage.db';

/**
 * An error that carries its HTTP status. The Vite middleware duck-types `status` off whatever is thrown,
 * because this module is loaded through `ssrLoadModule` and `instanceof` across that boundary is
 * unreliable; anything without a status stays a 500.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type ApiMethod = 'GET' | 'POST';

/**
 * Kept in step with the wording in `scripts/preflight.ts`, which is what normally catches this: reaching
 * it here means the key was removed from the environment after the server had already started. Refusing
 * is the whole of D-014 — the alternative is spending thirteen calls that all fail the same way and
 * writing thirteen rows whose one real cause is a missing variable.
 */
const NO_KEY = [
  'OPENROUTER_API_KEY is not set in the server process.',
  'Add it to .env (copy .env.example), then restart `pnpm dev`.',
  'This tool calls an LLM per message; there is no offline mode by design.',
].join(' ');

export interface MessagesResponse {
  messages: InboundMessage[];
  /** From the loader — set when `inbound.json` had to be repaired before it would parse. */
  parseNote: string | null;
}

export interface QueueSnapshot extends MessagesResponse {
  results: TriageResult[];
}

export interface Health {
  /**
   * `no_key` is a diagnosis, not a mode of operation: the POST endpoints refuse rather than degrade
   * (D-014). It says a key is absent and never anything about a key that is present.
   */
  mode: 'live' | 'no_key';
  /** The slug the next call asks for first. */
  model: string | null;
  /** The whole fallthrough chain, after the capability filter dropped anything unusable. */
  chain: string[];
  /** Null when `TRIAGE_CONCURRENCY` is unset or unusable, in which case the engine's default applies. */
  concurrency: number | null;
  pending: number;
  db: string;
  inbound: string;
  /** Set when a configured `TRIAGE_MODEL` was dropped, so an ignored override is visible not assumed. */
  detail: string | null;
}

/**
 * One shape per route, and a POST answers with the run's own summary rather than with a summary wrapped
 * beside a refreshed queue. The grid re-reads `/api/results` after a run anyway, so folding the rows into
 * the POST reply would have made the response two things at once for no saved round trip.
 */
export type ApiResponse = MessagesResponse | QueueSnapshot | Health | RunSummary;

interface Paths {
  inbound: string;
  db: string;
}

function resolvePaths(env: Record<string, string>): Paths {
  // TRIAGE_INBOUND is a test seam rather than a documented setting — .env.example names TRIAGE_DB,
  // TRIAGE_MODEL and TRIAGE_CONCURRENCY, which are the three anyone would realistically set.
  const inbound = env['TRIAGE_INBOUND']?.trim() || DEFAULT_INBOUND;
  const db = env['TRIAGE_DB']?.trim() || DEFAULT_DB;
  return { inbound: resolve(process.cwd(), inbound), db: resolve(process.cwd(), db) };
}

function apiKeyOf(env: Record<string, string>): string {
  return (env['OPENROUTER_API_KEY'] ?? '').trim();
}

function modelOverrideOf(env: Record<string, string>): string | undefined {
  const configured = env['TRIAGE_MODEL']?.trim();
  return configured === undefined || configured === '' ? undefined : configured;
}

/**
 * A typo must not stop the queue from running, so an unusable value falls through to the engine's own
 * default. `/api/health` reports null for both unset and unusable rather than the number that was applied:
 * it tells an operator "nothing you set is in effect", which is the part they can act on.
 */
function concurrencyOf(env: Record<string, string>): number | null {
  const raw = env['TRIAGE_CONCURRENCY']?.trim();
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function droppedOverride(override: string | undefined, chain: readonly string[]): string | null {
  if (override === undefined || chain[0] === override) return null;
  return `TRIAGE_MODEL=${override} was not used: it is not registered as structured-output capable, so the chain starts at ${chain[0] ?? 'nothing'} (src/llm/protocol.ts).`;
}

/**
 * Neither POST takes options: both act on the whole queue. A body carrying fields means the caller
 * expected something this route does not do, so it is named instead of dropped — a silently ignored
 * `{"messageId": "inb-003"}` is a debugging session with nothing to look at.
 */
function rejectOptions(path: string, body: unknown): void {
  if (body === null || body === undefined) return;
  const fields = typeof body === 'object' ? Object.keys(body) : ['a non-object body'];
  if (fields.length === 0) return;
  throw new HttpError(`${path} takes no options, but the request body carried ${fields.join(', ')}.`, 400);
}

async function withStore<T>(dbPath: string, use: (store: Store) => Promise<T>): Promise<T> {
  const store = createSqliteStore(dbPath);
  try {
    return await use(store);
  } finally {
    await store.close();
  }
}

function engineFor(store: Store, env: Record<string, string>, paths: Paths): TriageEngine {
  const apiKey = apiKeyOf(env);
  if (apiKey === '') throw new HttpError(NO_KEY, 503);
  const model = modelOverrideOf(env);
  const concurrency = concurrencyOf(env);
  return createTriageEngine({
    store,
    inboundPath: paths.inbound,
    apiKey,
    ...(model === undefined ? {} : { model }),
    ...(concurrency === null ? {} : { concurrency }),
  });
}

/**
 * Everything the grid needs in one answer: the queue as the FILE has it, the verdicts as the store has
 * them.
 *
 * Messages come from the file and not from the `messages` table because the file is the source of truth,
 * and because the queue has to render before the first run — against a fresh database the store holds
 * nothing at all.
 */
async function snapshot(store: Store, inboundPath: string): Promise<QueueSnapshot> {
  const { messages, parseNote } = loadInbound(inboundPath);
  const results = await store.listResults();
  // No pending count here on purpose. It used to ship one, computed by a second store query on every read
  // of this route, and nothing consumed it: the client's decoder never declared the field and the summary
  // bar derives the count from the rows it already has. `/api/health` reports pending for an operator, which
  // is a different question asked by a different caller.
  return { messages, parseNote, results };
}

async function health(store: Store, env: Record<string, string>, paths: Paths): Promise<Health> {
  const override = modelOverrideOf(env);
  const chain = modelChain(override);
  const pending = await store.listPendingRetry();
  return {
    mode: apiKeyOf(env) === '' ? 'no_key' : 'live',
    model: chain[0] ?? null,
    chain,
    concurrency: concurrencyOf(env),
    pending: pending.length,
    db: paths.db,
    inbound: paths.inbound,
    detail: droppedOverride(override, chain),
  };
}

export async function handle(
  path: string,
  method: ApiMethod,
  body: unknown,
  env: Record<string, string>,
): Promise<ApiResponse> {
  const expect = (want: ApiMethod): void => {
    if (method !== want) throw new HttpError(`${path} answers ${want}, not ${method}`, 405);
  };
  const paths = resolvePaths(env);

  switch (path) {
    case '/api/messages': {
      expect('GET');
      const { messages, parseNote } = loadInbound(paths.inbound);
      return { messages, parseNote };
    }

    case '/api/results': {
      expect('GET');
      return await withStore(paths.db, (store) => snapshot(store, paths.inbound));
    }

    case '/api/health': {
      expect('GET');
      return await withStore(paths.db, (store) => health(store, env, paths));
    }

    /**
     * The whole queue. Idempotent: a row whose stored verdict already covers this exact content is
     * skipped rather than re-rolled, and the summary counts it as skipped.
     *
     * `engine.triageOne` — the unconditional single-row retry — is deliberately not exposed. The error
     * surface this serves (DESIGN §4.2d) is a run summary, a pending filter chip and per-row attempt
     * detail; none of them is a per-row retry button, and a second body-keyed shape on this route would
     * be a worse contract than the route it saves.
     */
    case '/api/triage/run': {
      expect('POST');
      rejectOptions(path, body);
      return await withStore(paths.db, (store) => engineFor(store, env, paths).triageAll());
    }

    /** The explicit "Retry N pending" control — the drain for whatever the operator has just fixed. */
    case '/api/triage/retry': {
      expect('POST');
      rejectOptions(path, body);
      return await withStore(paths.db, (store) => engineFor(store, env, paths).retryPending());
    }

    default:
      throw new HttpError(`unknown endpoint: ${path}`, 404);
  }
}
