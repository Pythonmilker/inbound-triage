/**
 * The only file in the UI that names a URL, and the only one that speaks to the server.
 *
 * Nothing here reads `import.meta.env`, holds a token, or stores one. The key is read from the
 * environment by the Node process and used to build the provider request there (R8, DESIGN §5); the
 * browser's whole view of triage is these three routes.
 *
 * The three routes used, out of the five `src/server/handlers.ts` serves:
 *
 *   GET  /api/results      -> { messages, parseNote, results }
 *   POST /api/triage/run   -> RunSummary   (the engine's triageAll)
 *   POST /api/triage/retry -> RunSummary   (the engine's retryPending)
 *
 * `/api/results` carries the messages as well as the verdicts, so one read is the whole screen — and it
 * reads the queue from the FILE, which is what lets the grid render against a database that has never
 * been written to. `/api/health` and `/api/messages` are not used here: health reports server facts a
 * grid cannot act on, and messages is the same read minus the verdicts.
 *
 * A run summary is decoded field by field because every field of it is rendered. A result row is
 * checked only where the UI BRANCHES on it — `status` and the attempt log — and passed through
 * otherwise: those fields were validated in Node by validate.ts before they were stored, and
 * re-deriving the taxonomy here would put it in two places and let the two drift.
 */

import { FAILURE_POLICY } from '../triage/retry.js';
import type { RunNote, RunSummary } from '../triage/run.js';
import type { FailureKind, InboundMessage, TriageResult } from '../triage/types.js';

export const ROUTES = {
  queue: '/api/results',
  run: '/api/triage/run',
  retry: '/api/triage/retry',
} as const;

export interface QueueSnapshot {
  messages: InboundMessage[];
  /** Every stored row, including ones written by an earlier session — the store outlives the tab. */
  results: TriageResult[];
  /** From the loader: set when `inbound.json` had to be repaired before it would parse. */
  parseNote: string | null;
}

export class ApiError extends Error {
  /** Null when no response arrived at all: a dead dev server rather than one that refused. */
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const NO_SERVER =
  'The Node dev server did not answer. It is what holds the API key — the browser never does — so triage needs it running: `pnpm dev`.';

export async function fetchQueue(): Promise<QueueSnapshot> {
  return readQueue(await request(ROUTES.queue), ROUTES.queue);
}

export async function runTriage(): Promise<RunSummary> {
  return readRunSummary(await request(ROUTES.run, { method: 'POST' }), ROUTES.run);
}

export async function retryPending(): Promise<RunSummary> {
  return readRunSummary(await request(ROUTES.retry, { method: 'POST' }), ROUTES.retry);
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new ApiError(`${url} could not be reached (${errorText(cause)}). ${NO_SERVER}`, null);
  }

  if (!response.ok) {
    const detail = await bodyText(response);
    throw new ApiError(
      `${url} returned HTTP ${response.status}${detail === '' ? '.' : `: ${detail}`}`,
      response.status,
    );
  }

  try {
    return (await response.json()) as unknown;
  } catch (cause) {
    throw new ApiError(`${url} did not return JSON (${errorText(cause)}).`, response.status);
  }
}

/** The middleware answers a failure as `{ error }`, so the sentence it wrote is what a person reads. */
async function bodyText(response: Response): Promise<string> {
  let body: string;
  try {
    body = (await response.text()).trim();
  } catch {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed['error'] === 'string') body = parsed['error'];
  } catch {
    // Not JSON. The raw text is still the most useful thing available.
  }
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

function readQueue(payload: unknown, url: string): QueueSnapshot {
  const envelope = expectRecord(payload, url);
  return {
    messages: expectRecords(envelope['messages'], 'messages', url).map((r) => readMessage(r, url)),
    results: expectRecords(envelope['results'], 'results', url).map((r) => readResult(r, url)),
    parseNote: stringOrNull(envelope['parseNote']),
  };
}

function readMessage(record: Record<string, unknown>, url: string): InboundMessage {
  return {
    id: stringAt(record, 'id', url),
    received_at: stringAt(record, 'received_at', url),
    channel: stringAt(record, 'channel', url),
    from_name: stringAt(record, 'from_name', url),
    from_org: stringAt(record, 'from_org', url),
    subject: stringAt(record, 'subject', url),
    body: stringAt(record, 'body', url),
  };
}

function readResult(record: Record<string, unknown>, url: string): TriageResult {
  const status = record['status'];
  if (status !== 'triaged' && status !== 'pending_retry') {
    throw new ApiError(`${url} returned a row with status ${JSON.stringify(status)}.`, null);
  }
  if (!Array.isArray(record['attempts'])) {
    throw new ApiError(`${url} returned a row with no attempts array.`, null);
  }
  // Both fields the grid branches on are now known. The rest is rendered as data, so a field that
  // somehow arrived wrong shows as itself instead of taking the row down.
  return record as unknown as TriageResult;
}

function readRunSummary(payload: unknown, url: string): RunSummary {
  const envelope = expectRecord(payload, url);
  const counts = envelope['counts'];
  if (!isRecord(counts)) {
    throw new ApiError(`${url} returned no counts on the run summary.`, null);
  }
  return {
    counts: {
      triaged: numberAt(counts, 'triaged', url),
      pending_retry: numberAt(counts, 'pending_retry', url),
    },
    skipped: numberAt(envelope, 'skipped', url),
    failures: readFailures(envelope['failures']),
    calls: numberAt(envelope, 'calls', url),
    costUsd: numberAt(envelope, 'costUsd', url),
    unpricedCalls: numberAt(envelope, 'unpricedCalls', url),
    elapsedMs: numberAt(envelope, 'elapsedMs', url),
    parseNote: stringOrNull(envelope['parseNote']),
    drained: numberAt(envelope, 'drained', url),
    internalErrors: readNotes(envelope['internalErrors']),
  };
}

/** An absent `failures` is a clean run, not a malformed reply — no failures is a legitimate answer. */
function readFailures(value: unknown): Partial<Record<FailureKind, number>> {
  const failures: Partial<Record<FailureKind, number>> = {};
  if (!isRecord(value)) return failures;
  for (const kind of Object.keys(FAILURE_POLICY) as FailureKind[]) {
    const count = value[kind];
    if (typeof count === 'number') failures[kind] = count;
  }
  return failures;
}

function readNotes(value: unknown): RunNote[] {
  if (!Array.isArray(value)) return [];
  const items: unknown[] = value;
  return items.filter(isRecord).map((note) => ({
    messageId: stringOrNull(note['messageId']) ?? '-',
    detail: stringOrNull(note['detail']) ?? 'no detail recorded',
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(payload: unknown, url: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new ApiError(`${url} returned ${payload === null ? 'null' : typeof payload}, not an object.`, null);
  }
  return payload;
}

function expectRecords(value: unknown, key: string, url: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new ApiError(`${url} returned no \`${key}\` array.`, null);
  }
  const items: unknown[] = value;
  if (!items.every(isRecord)) {
    throw new ApiError(`${url} returned a \`${key}\` entry that is not an object.`, null);
  }
  return items;
}

function stringAt(record: Record<string, unknown>, key: string, url: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new ApiError(`${url} returned a record with no string \`${key}\`.`, null);
  }
  return value;
}

function numberAt(record: Record<string, unknown>, key: string, url: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(`${url} returned no finite \`${key}\` on the run summary.`, null);
  }
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
