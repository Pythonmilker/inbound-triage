/**
 * The taxonomy, as data.
 *
 * SIX CATEGORIES, and the shape of them is a product decision rather than a modelling one. This tool
 * exists to catch leads and to rank the clients the firm already has, so the taxonomy is cut where that
 * purpose cuts: everything on the path of a new or an existing client gets its own label, everything off
 * that path is `junk`.
 *
 * `vendor`, `automated` and `unreadable` used to be three separate labels. They were collapsed because the
 * distinctions between them, real as they are, do not change what anyone does — all three get deleted — and
 * a taxonomy that splits hairs the user does not care about costs discrimination on the labels that matter.
 * What was worth keeping from the old `unreadable` is not its label but its `reason`, which survives on the
 * row: "the body is transport damage" tells an operator the intake path may be broken, and that is
 * actionable in a way that a separate category never was.
 *
 * `partner_referral` folded into `prospect` for the same reason: a peer proposing mutual referrals is on the
 * path of new business, and whether they arrive as a lead or as a channel does not change that someone in
 * business development has to answer them. The *routing* line still names the difference, and the model's
 * per-message `next_action` says it concretely — which is where a distinction belongs once it stops
 * deciding anything structural.
 *
 * `unknown` deliberately did NOT collapse into `junk`. Junk means we know it is off the path; unknown means
 * we cannot tell, and a vague message from a real person may well be the lead. Binning it would defeat the
 * purpose the rest of the taxonomy is cut for.
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
      'Anyone not yet a client who could bring business to the firm: asking about becoming a client, describing a need the firm could serve, or a peer proposing a referral arrangement.',
    routing:
      'Route to the advisory team for qualification — or to whoever owns partnerships if they are proposing an arrangement rather than asking for advice.',
  },
  {
    id: 'existing_client',
    label: 'Existing client',
    definition:
      'Someone who states or clearly implies they are already a client, asking for service on their own account.',
    routing: 'Route to the servicing advisor who owns the relationship.',
  },
  {
    id: 'fraud_risk',
    label: 'Fraud risk',
    definition:
      'A request to change where money goes — new wire instructions, a changed bank account, a payment redirect — whether or not the sender appears legitimate.',
    routing: 'Do not act on the instruction. Verify by phone on a number already on file.',
  },
  {
    id: 'compliance',
    label: 'Compliance',
    definition:
      'Correspondence from a regulator, auditor, or custodian carrying an obligation on the firm: an examination notice, a subpoena, an audit confirmation.',
    routing: 'Route to the chief compliance officer. These carry statutory clocks.',
  },
  {
    id: 'unknown',
    label: 'Unknown',
    definition:
      'A genuine message from a real person whose intent cannot be determined from what they wrote — for example a follow-up to a conversation the inbox has no record of.',
    routing: 'Reply and ask what they need. This may be a client or a prospect — that is exactly what is unknown.',
  },
  {
    id: 'junk',
    label: 'Junk',
    definition:
      'Nothing in the path of a new or an existing client: someone selling to the firm, a recruiter, machine-sent mail nobody needs to answer, or a body with nothing readable in it.',
    routing: 'No action needed — delete or filter it. If the body was unreadable, check whether the intake path is broken.',
  },
] as const;

export type Category = (typeof CATEGORIES)[number]['id'];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as readonly Category[];

/**
 * Every category is model-selectable again, so there is no narrowed set any more.
 *
 * There was one. `unreadable` was excluded from the model's menu because a model picking it produced a
 * self-contradictory row: it asserted there was nothing checkable in a message that had already been found
 * readable, with no `reason` to explain it. Collapsing the label into `junk` dissolved that: "this is junk"
 * is a complete statement whether or not a reason accompanies it, so the exclusion had nothing left to
 * protect and a filter that filters nothing is worse than no filter.
 */

/**
 * Priority is defined by deadline and money at risk — never by tone. An angry message about a small fee is
 * not automatically urgent; a calm message with a Friday deadline is.
 */
export const PRIORITIES = [
  {
    id: 'high',
    label: 'High',
    definition:
      'A stated deadline inside about a week, an account or fee dispute from an existing client, money at risk right now, or anything a regulator or a redirected payment puts a clock on.',
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

/**
 * The weight at which the floor's evidence is CHARACTERISTIC rather than merely suggestive, and therefore
 * outranks the model's category read (reconcile.ts).
 *
 * Four, because that is where the weight scale in rules.ts stops describing things anyone might say. A 1 or
 * a 2 is a question a competitor could ask; a 3 is solid but shared; a 4 is an idiom that would be odd from
 * anyone other than the category it belongs to — "we sell", a recruiter's opener, an unsubscribe link — and
 * a 5 is a fact the sender volunteered about themselves.
 */
export const STRONG_EVIDENCE = 4;

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

/**
 * Why a `junk` row had nothing readable in it. Recorded so the row can say which, not merely that.
 *
 * This is the part of the old `unreadable` category that was worth keeping. "The body is transport damage"
 * points at the intake path; "the body is empty" points at the form. A category could not say either.
 */
export type UnreadableReason = 'empty-body' | 'garbled' | 'no-id' | 'below-threshold';

/**
 * `category` says what the message IS. `status` says whether we FINISHED processing it. Keeping them apart
 * is what removed the parking bucket from an earlier design: a failed call never has to masquerade as a
 * category, and a message with nothing readable in it is still `triaged` because we did finish — the answer
 * is "there is nothing here".
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
  /**
   * Summed weight of the evidence behind `category`. Reported separately from `confidence` because they
   * answer different questions: confidence is how sure the floor is *relative to the runner-up*, weight is
   * how characteristic the evidence itself was. Reconciliation needs the second one — see STRONG_EVIDENCE
   * in reconcile.ts.
   */
  evidenceWeight: number;
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
