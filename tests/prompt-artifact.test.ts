/**
 * The committed prompt artifact must be the prompt the code actually sends.
 *
 * `prompts/system.md` is a deliverable: it is what a reader inspects to see how the model is instructed.
 * It was hand-copied, and it drifted — the committed copy still listed `vendor`, `partner_referral` and
 * `noise` three taxonomy generations after those labels stopped existing. A reviewer reading it would have
 * been reading a description of a tool that no longer ran, which is worse than shipping no artifact at all.
 *
 * Regenerate with `pnpm prompts:dump`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from '../src/triage/prompt.js';

describe('the committed prompt artifact', () => {
  it('is exactly what buildSystemPrompt() produces', () => {
    const committed = readFileSync(fileURLToPath(new URL('../prompts/system.md', import.meta.url)), 'utf8');

    // Trailing-whitespace and line-ending differences are an editor's business, not a drift in the prompt.
    const normalise = (text: string) =>
      text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .trim();

    expect(normalise(committed), 'run `pnpm prompts:dump` — the artifact and the builder disagree').toBe(
      normalise(buildSystemPrompt()),
    );
  });
});
