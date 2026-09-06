import type { InboundMessage, TriageResult } from '../triage/types.js';

export interface QueueRow {
  message: InboundMessage;
  /** Null before the first run, and after a run whose pipeline threw on this message. */
  result: TriageResult | null;
}
