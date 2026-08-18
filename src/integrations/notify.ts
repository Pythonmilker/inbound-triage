/**
 * The integration seam, exercised (D-007). One interface, one working implementation, one documented stub.
 *
 * The distinction that keeps it honest: an interface with zero implementations is a guess about a shape
 * nobody has had to fit. `ConsoleNotifier` is real and wired, so the interface has been proved against at
 * least one caller before a second one is claimed.
 */

export interface NotifyEvent {
  kind: 'high_priority' | 'triage_failed';
  messageId: string;
  detail: string;
}

export interface Notifier {
  notify(event: NotifyEvent): Promise<void>;
}

/**
 * Writes to stderr, not stdout: stdout belongs to the dev server's own output, and a notification is an
 * operational line rather than data. The line stays ASCII so it survives a Windows console codepage.
 */
export class ConsoleNotifier implements Notifier {
  readonly #write: (line: string) => void;

  /** The sink is injectable so a test can assert what was notified without capturing process stderr. */
  constructor(write?: (line: string) => void) {
    this.#write = write ?? ((line) => void process.stderr.write(line));
  }

  async notify(event: NotifyEvent): Promise<void> {
    this.#write(`[notify] ${event.kind} ${event.messageId}: ${event.detail}\n`);
  }
}

/**
 * A seam, by choice — not an unfinished feature.
 *
 * The trigger -> action pair it stands for: a `high` priority verdict is written -> post that row to a
 * channel. That pair is also the n8n/Zapier automation the README describes, which is why the shape is
 * worth naming and a Slack client is not worth building into a single-user local tool (DESIGN §4.5).
 *
 * It throws synchronously rather than returning a rejected promise, so an unawaited call fails loudly at
 * the call site instead of surfacing later as an unhandled rejection. Nothing wires this up.
 */
export class SlackNotifier implements Notifier {
  notify(_event: NotifyEvent): Promise<void> {
    throw new Error(
      'SlackNotifier is not implemented - this is a deliberate seam, see the README and DESIGN 4.5. ' +
        'Trigger to action: a high-priority verdict is written -> post it to a channel.',
    );
  }
}
