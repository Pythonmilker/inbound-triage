/**
 * Where "deterministic triage" is actually enforced: the rule floor and the model meet in ordinary code.
 *
 * NOTHING HERE CALLS A MODEL, and nothing here may. There is exactly one model call per message in this
 * app and it has already happened by the time these two verdicts exist. Asking a model to settle the
 * disagreement would make the deterministic half advisory, which is the entire property being defended —
 * and it would cost a second call per message to arrive at a less predictable answer.
 *
 * Pure: no I/O, no clock, no randomness, no store, no llm import. The same two verdicts in always produce
 * the same row out.
 *
 * Only reached when both verdicts exist. A failed model call asserts no verdict at all (D-011b), so it
 * never arrives here — there is no "reconcile against nothing" case to handle.
 */

import { CONFIDENCE_THRESHOLD } from './schema.js';
import { PRIORITY_RANK } from './types.js';
import type { Category, ModelVerdict, Priority, RulesVerdict, VerdictSource } from './types.js';

/**
 * The one rule signal reconciliation reads by name. "I'm an existing client" is a fact stated in the text,
 * not a judgment call, so it outranks the model's category read.
 */
export const SELF_IDENTIFIED_CLIENT = 'self_identified_client';

/**
 * A signal the rule floor matched. `RulesVerdict` in types.ts carries no signal list and types.ts is
 * fixed, so the list rides in as an optional property on the verdict the rule floor hands over. Two
 * encodings are accepted because rules.ts owns the encoding: a bare id, or the symmetric observation row,
 * which lists absent signals too and therefore has to carry its own matched flag.
 */
export type RuleSignal = string | { readonly id: string; readonly matched?: boolean };

export interface ReconcileInput {
  rules: RulesVerdict & { readonly signals?: readonly RuleSignal[] };
  model: ModelVerdict;
}

export interface ReconciledVerdict {
  category: Category;
  priority: Priority;
  confidence: number;
  source: VerdictSource;
  /**
   * Non-null whenever anything about this verdict needs explaining — which includes a category
   * disagreement the MODEL won, not only the ones the rules won. Written for a person scanning a queue,
   * not for a log.
   */
  note: string | null;
}

export function reconcile({ rules, model }: ReconcileInput): ReconciledVerdict {
  const matched = matchedSignalIds(rules.signals);
  const selfIdentified = matched.includes(SELF_IDENTIFIED_CLIENT);
  const belowThreshold = model.confidence < CONFIDENCE_THRESHOLD;
  const categoryFromRules = selfIdentified || belowThreshold;

  const category = categoryFromRules ? rules.category : model.category;

  /*
   * The asymmetry is deliberate and load-bearing: taking the maximum means a rule can raise urgency and
   * can never lower it. A model that under-reads an angry client with a Friday deadline is the expensive
   * failure — real money, missed window. A false high costs one human glance at the top of the queue.
   */
  const priority = higherPriority(rules.priority, model.priority);
  const priorityRaised = PRIORITY_RANK[rules.priority] > PRIORITY_RANK[model.priority];
  const modelMoreUrgent = PRIORITY_RANK[model.priority] > PRIORITY_RANK[rules.priority];

  const clauses: string[] = [];

  if (selfIdentified) {
    clauses.push(
      category === model.category
        ? `category ${category} comes from the sender saying so outright, not from the model's read`
        : `category set to ${category} over the model's ${model.category}: the sender states they are an existing client`,
    );
  } else if (belowThreshold) {
    const scored = `model confidence ${model.confidence.toFixed(2)} is under ${CONFIDENCE_THRESHOLD}`;
    clauses.push(
      category === model.category
        ? `${scored}, so the rule floor's ${category} stands — it happened to agree`
        : `${scored}, so the rule floor's ${category} stands instead of the model's ${model.category}`,
    );
  } else if (rules.category !== model.category && rules.confidence > 0) {
    /*
     * The model's category won over a rule floor that read the message differently. This used to produce
     * NO note at all, which made it the one path through this function that resolved a disagreement in
     * silence — and a silent override is the failure mode the whole design is built to avoid.
     *
     * It is not hypothetical. On a real run against the supplied queue the floor read a vendor pitch as
     * `junk` at 0.83 from explicit selling language, the model called it a `prospect` at 0.80, the model
     * won because 0.80 clears the threshold, and the row came out looking unanimous. The model was wrong.
     *
     * Recording it does not change who wins — whether a more-confident floor SHOULD win is a separate
     * decision. It changes whether anyone can tell.
     */
    clauses.push(
      `model's ${model.category} at ${model.confidence.toFixed(2)} kept over the rule floor's ` +
        `${rules.category} at ${rules.confidence.toFixed(2)} — the two layers disagreed on the category`,
    );
  }

  if (priorityRaised) {
    const evidence = matched.filter((id) => id !== SELF_IDENTIFIED_CLIENT).map(readable);
    const why =
      evidence.length > 0
        ? `: the rules matched ${evidence.join(', ')}`
        : ' because the rule floor read more urgency in the message than the model did';
    clauses.push(`priority raised to ${priority} from the model's ${model.priority}${why}`);
  }

  return {
    category,
    // Confidence describes the category, so it follows whichever layer supplied the category.
    confidence: categoryFromRules ? rules.confidence : model.confidence,
    priority,
    source: verdictSource(categoryFromRules, priorityRaised, modelMoreUrgent),
    note: clauses.length === 0 ? null : sentence(clauses),
  };
}

/**
 * `rules` when the whole verdict is the floor's, `reconciled` when the two were combined — the model's
 * category kept while the floor raised priority, or the floor's category kept while the model's higher
 * priority survived the maximum.
 */
function verdictSource(
  categoryFromRules: boolean,
  priorityRaised: boolean,
  modelMoreUrgent: boolean,
): VerdictSource {
  if (categoryFromRules) return modelMoreUrgent ? 'reconciled' : 'rules';
  return priorityRaised ? 'reconciled' : 'model';
}

function higherPriority(a: Priority, b: Priority): Priority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}

/** An object row without a `matched` flag counts as matched; the symmetric list marks absence explicitly. */
function matchedSignalIds(signals: readonly RuleSignal[] | undefined): readonly string[] {
  if (!signals) return [];
  const ids: string[] = [];
  for (const signal of signals) {
    if (typeof signal === 'string') ids.push(signal);
    else if (signal.matched !== false) ids.push(signal.id);
  }
  return ids;
}

function readable(signalId: string): string {
  return signalId.replace(/_/g, ' ');
}

function sentence(clauses: readonly string[]): string {
  const joined = clauses.join('; ');
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}
