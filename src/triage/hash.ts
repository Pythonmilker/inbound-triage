/**
 * The content hash that makes a re-run idempotent.
 *
 * Results are keyed `{message_id, content_hash}`, so this digest decides whether a message is the same work
 * we already did or new work. Two properties it has to keep: it never depends on the object's key order
 * (JSON.stringify does), and it is identical across processes and runs — no salt, no clock, no randomness.
 *
 * 16 hex characters is a cache key, not a security boundary.
 */

import { createHash } from 'node:crypto';
import type { InboundMessage } from './types.js';

/**
 * The fields whose change changes the meaning. The ORDER is part of the hash: reordering this list
 * invalidates every stored result, which is why it is written out rather than derived from Object.keys.
 */
const HASHED_FIELDS = [
  'id',
  'subject',
  'body',
  'from_name',
  'from_org',
  'channel',
  'received_at',
] as const satisfies readonly (keyof InboundMessage)[];

export function contentHash(m: InboundMessage): string {
  const digest = createHash('sha256');
  for (const field of HASHED_FIELDS) {
    const value = m[field];
    // Length-prefixed so no value can impersonate the separator: `subject: "a\nbody: b"` and
    // `subject: "a"`+`body: "b"` would otherwise hash identically.
    digest.update(`${field}:${value.length}:${value}\n`, 'utf8');
  }
  return digest.digest('hex').slice(0, 16);
}
