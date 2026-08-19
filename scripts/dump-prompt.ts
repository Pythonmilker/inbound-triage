/**
 * Write the live system prompt to `prompts/system.md`.
 *
 * The brief asks for "your LLM prompt(s)" as an artifact, and a hand-copied snapshot of a prompt that is
 * assembled in code drifts the moment the code changes. It had: the committed copy still listed `vendor`,
 * `partner_referral` and `noise` three taxonomy generations after they stopped existing, so the artifact a
 * reviewer would read described a tool that no longer ran.
 *
 * `tests/prompt-artifact.test.ts` fails when the file and the builder disagree, which is what makes this
 * script something you have to run rather than something you have to remember.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemPrompt } from '../src/triage/prompt.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'prompts', 'system.md');

writeFileSync(OUT, `${buildSystemPrompt()}\n`, 'utf8');
console.log(`wrote prompts/system.md from buildSystemPrompt()`);
