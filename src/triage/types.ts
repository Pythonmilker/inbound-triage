/**
 * The taxonomy, as data.
 *
 * Categories and priority rules are rows, not `if` branches. That is deliberate: doubling the taxonomy
 * from seven categories to fourteen means adding rows and one enum entry, with no new branch, no new
 * table, and no migration beyond an insert. What actually strains at double is not capacity but
 * discrimination between neighbouring labels — which is why UNKNOWN and the confidence threshold matter
 * more as the taxonomy grows, not less.
 *
 * The schema's enum is generated from these rows (see schema.ts), so a category cannot exist here and be
 * un-selectable by the model, or vice versa. tests/taxonomy.test.ts pins that.
 */

export const CATEGORIES = [
  {
    id: 'prospect',
    label: 'Prospect',
    definition:
      'Someone who is not yet a client and is asking about becoming one, or describing a need the firm could serve.',
    routing: 'Route to the advisory team for qualification.',
  },
  {
    id: 'existing_client',
    label: 'Existing client',
    definition:
      'Someone who states or clearly implies they are already a client, asking for service on their own account.',
    routing: 'Route to the servicing advisor who owns the relationship.',
  },
  {
    id: 'vendor',
    label: 'Vendor',
    definition:
      'Someone selling a product or service to the firm, including unsolicited demos and recruiter outreach.',
    routing: 'Route to operations, or decline.',
  },
  {
    id: 'partner_referral',
    label: 'Partner / referral',
    definition:
      'A peer firm or professional proposing a referral or partnership arrangement, rather than buying or selling a product.',
    routing: 'Route to partnerships — this is neither a prospect nor a vendor.',
  },
  {
    id: 'noise',
    label: 'Noise',
    definition:
      'Automated or bulk correspondence addressed to nobody in particular: newsletters, digests, mailing-list traffic.',
    routing: 'No action. Consider filtering at the inbox.',
  },
  {
    id: 'unknown',
    label: 'Unknown',
    definition:
      'A genuine message from a real person whose intent cannot be determined from what they wrote — for example a follow-up to a conversation the inbox has no record of.',
    routing: 'Reply and ask what they need.',
  },
  {
    id: 'unreadable',
    label: 'Unreadable',
    definition:
      'There is nothing checkable in the message at all: an empty body, a single punctuation mark, or corrupted transport data.',
    routing: 'Discard, or check whether the intake form is broken.',
  },
] as const;

export type Category = (typeof CATEGORIES)[number]['id'];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as readonly Category[];

/**
 * Priority is defined by deadline and money at risk — never by tone. An angry message about a small fee is
 * not automatically urgent; a calm message with a Friday deadline is.
 */
export const PRIORITIES = [
  {
    id: 'high',
    label: 'High',
    definition:
      'A stated deadline inside about a week, an account or fee dispute from an existing client, or money at risk right now.',
  },
  {
    id: 'medium',
    label: 'Medium',
    definition: 'Real work that needs a human, with no deadline pressing on it.',
  },
  {
    id: 'low',
    label: 'Low',
    definition: 'No deadline and no immediate stake — or nothing actionable at all.',
  },
] as const;

export type Priority = (typeof PRIORITIES)[number]['id'];

export const PRIORITY_IDS = PRIORITIES.map((p) => p.id) as readonly Priority[];

/** Ranked worst-to-best so reconciliation can take a maximum without a lookup table. */
export const PRIORITY_RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2 };

/** One inbound message, after loading. Fields may be empty strings — that is the source data's shape. */
export interface InboundMessage {
  id: string;
  received_at: string;
  channel: string;
  from_name: string;
  from_org: string;
  subject: string;
  body: string;
}

/**
 * Sentinels that appear in `from_org` and are NOT organisation names. A
 * naive prompt treats them as real firms anyway — so they are stripped before the model ever sees them.
 */
export const ORG_SENTINELS = ['(individual)', '(unknown)', ''] as const;

/** Why a message was ruled unreadable. Recorded so the row can say which, not merely that. */
export type UnreadableReason = 'empty-body' | 'garbled' | 'no-id' | 'below-threshold';

/**
 * `category` says what the message IS. `status` says whether we FINISHED processing it. Keeping them apart
 * is what removed the parking bucket from an earlier design: a failed call never has to masquerade as a
 * category, and an unreadable message is still `triaged` because we did finish — the answer is "there is
 * nothing here".
 */
export type TriageStatus = 'triaged' | 'pending_retry';

/** Which layer produced the verdict. Always displayed — a verdict never hides where it came from. */
export type VerdictSource = 'model' | 'rules' | 'reconciled';

/** Typed model-call failures. The kind decides the behaviour; see DESIGN §4.2b. */
export type FailureKind =
  | 'no_key'
  | 'key_rejected'
  | 'unfunded'
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'network'
  | 'unparseable'
  | 'truncated';

/** What the model is asked to return. Field order matters — see schema.ts. */
export interface ModelVerdict {
  summary: string;
  evidence: string;
  category: Category;
  priority: Priority;
  next_action: string;
  confidence: number;
}

/** What the deterministic layer concludes on its own, with no model involved. */
export interface RulesVerdict {
  category: Category;
  priority: Priority;
  confidence: number;
}

/** One attempt at a model call, kept so a failure is diagnosable rather than merely visible. */
export interface Attempt {
  model: string;
  at: string;
  ok: boolean;
  failure?: FailureKind;
  httpStatus?: number;
  detail?: string;
}

/** A row in the queue. One per message, always — there is no second surface. */
export interface TriageResult {
  message_id: string;
  content_hash: string;
  status: TriageStatus;
  /** Null only while `status` is `pending_retry`: a failed call asserts no verdict at all (D-011b). */
  category: Category | null;
  priority: Priority | null;
  summary: string | null;
  next_action: string | null;
  confidence: number | null;
  source: VerdictSource | null;
  /** Set when the category is `unreadable`, naming which kind of nothing it was. */
  reason: UnreadableReason | null;
  /** Populated when reconciliation moved something, so the row can say why. */
  reconciliation_note: string | null;
  attempts: Attempt[];
  updated_at: string;
}

export function categoryDefinition(id: Category): string {
  const row = CATEGORIES.find((c) => c.id === id);
  if (!row) throw new Error(`unknown category: ${id}`);
  return row.definition;
}

export function isOrgSentinel(org: string): boolean {
  return (ORG_SENTINELS as readonly string[]).includes(org.trim());
}
