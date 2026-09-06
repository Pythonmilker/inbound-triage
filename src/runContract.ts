import type { FailureKind, TriageStatus } from './triage/types.js';

export interface RunNote {
  messageId: string;
  detail: string;
}

export interface RunSummary {
  /** One entry per message the run touched, counted by the status now on its row. */
  counts: Record<TriageStatus, number>;
  /** Rows left alone because a stored verdict already covers this exact content. */
  skipped: number;
  /** Every failure kind seen this run, and how many attempts hit it. */
  failures: Partial<Record<FailureKind, number>>;
  /** Model calls spent, successful or not — a 200 containing prose is billed like any other. */
  calls: number;
  costUsd: number;
  /**
   * Answered calls whose price is unknown: a slug outside the registry, or a provider that reported no
   * usage. Counted rather than folded into `costUsd`, where a zero would read as free.
   */
  unpricedCalls: number;
  elapsedMs: number;
  /** From the loader — set when `inbound.json` needed repair before it would parse. */
  parseNote: string | null;
  /** Rows retried and triaged after a later call proved the provider was answering (DESIGN §4.2c). */
  drained: number;
  /** A message whose pipeline threw. Expected empty; if it is not, the run still finished. */
  internalErrors: RunNote[];
}
