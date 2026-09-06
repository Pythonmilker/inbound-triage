/**
 * Runs before `vite` in `pnpm dev`, and is the whole enforcement of two decisions.
 *
 * D-010 — one store, no fallback. The runtime requirement is stated, not cushioned: below Node 22.13.0
 * there is no `node:sqlite` (and on 22 it truncates stored strings at a NUL, so the floor is 24), and the failure that would otherwise reach the operator is a raw
 * `ERR_UNKNOWN_BUILTIN_MODULE` from deep inside a module they did not write. Converting that into a
 * sentence naming the version they have and the version the repo pins is the entire job.
 *
 * D-014 — no keyless mode. A missing key is fatal here rather than a degraded run: this tool calls an LLM
 * per message by design, so "it started and produced rule-based output" is a
 * worse outcome than not starting.
 *
 * Two rules for anything added below. It never prints the key, or any prefix, suffix or length of it —
 * a diagnostic that echoes a credential ends up in a terminal recording. And it prints NOTHING on
 * success: a preflight that chatters on every `pnpm dev` trains people to scroll past the one run where
 * it had something to say.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_NODE: readonly number[] = [24, 0, 0]; // raised from 22.13.0 on 2026-09-05: Node 22 node:sqlite cuts strings at NUL

const KEY = 'OPENROUTER_API_KEY';

/**
 * The files Vite's `loadEnv` reads for the dev server. Checking only `.env` would refuse to start on a
 * machine that is correctly configured through `.env.local` — a false refusal, which is worse than the
 * failure this script exists to prevent.
 */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'] as const;

const root = process.cwd();

function block(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** The version the repo pins, read rather than restated so the message cannot drift from the file. */
function pinnedNode(): string | null {
  const path = join(root, '.nvmrc');
  if (!existsSync(path)) return null;
  const pinned = readFileSync(path, 'utf8').trim();
  return pinned === '' ? null : pinned;
}

function nvmrcPointer(): string {
  const pinned = pinnedNode();
  return pinned === null
    ? 'This repo pins its version in .nvmrc.'
    : `This repo pins ${pinned} in .nvmrc — \`nvm use\` switches to it.`;
}

function isBelow(actual: readonly number[], required: readonly number[]): boolean {
  for (let i = 0; i < required.length; i += 1) {
    const a = actual[i] ?? 0;
    const r = required[i] ?? 0;
    if (a !== r) return a < r;
  }
  return false;
}

function checkNodeVersion(): string | null {
  const running = process.versions.node;
  const parts = running.split('.').map((part) => Number.parseInt(part, 10) || 0);
  if (!isBelow(parts, REQUIRED_NODE)) return null;

  return block([
    `✗ inbound-triage needs Node >=${REQUIRED_NODE.join('.')}, you are on ${running}.`,
    '',
    '  node:sqlite is the store and there is no fallback by design — it does not exist below',
    `  ${REQUIRED_NODE.join('.')}, so this would fail later as ERR_UNKNOWN_BUILTIN_MODULE.`,
    `  ${nvmrcPointer()}`,
  ]);
}

/**
 * A version high enough is not the same as a runtime that has it: a build with SQLite compiled out
 * satisfies the check above and still cannot open the store. The try/catch is here to turn that import
 * error into the same legible refusal, not to carry on without it.
 *
 * Below Node 24.15.0 this import prints an ExperimentalWarning of Node's own. That is Node talking, not
 * this script — the dev server would emit it on the first query anyway.
 */
async function checkSqlite(): Promise<string | null> {
  let problem: string | null = null;
  try {
    const sqlite = await import('node:sqlite');
    if (typeof sqlite.DatabaseSync !== 'function') {
      problem = 'it loaded with no DatabaseSync export';
    }
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  if (problem === null) return null;

  return block([
    `✗ Node ${process.versions.node} cannot load node:sqlite: ${problem}`,
    '',
    '  That module is the store, and D-010 gives it no fallback: a second code path nothing',
    '  exercises would quietly remove the property SQLite was chosen for.',
    `  ${nvmrcPointer()}`,
  ]);
}

/**
 * Whether a name has a non-empty value in a `.env`-style file. It returns a boolean and never the value,
 * so there is no path by which a caller can print the key even by accident.
 */
function definesValue(text: string, name: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    if (trimmed.slice(0, separator).replace(/^export\s+/, '').trim() !== name) continue;
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
      .trim();
    if (value !== '') return true;
  }
  return false;
}

function keyIsConfigured(): boolean {
  if ((process.env[KEY] ?? '').trim() !== '') return true;
  return ENV_FILES.some((name) => {
    const path = join(root, name);
    return existsSync(path) && definesValue(readFileSync(path, 'utf8'), KEY);
  });
}

function checkKey(): string | null {
  if (keyIsConfigured()) return null;

  return block([
    `✗ ${KEY} is not set.`,
    '',
    '  1. cp .env.example .env',
    `  2. put your key on the ${KEY}= line — get one at https://openrouter.ai/keys`,
    '',
    '  This tool calls an LLM per message; there is no offline mode by design.',
    '  Changing the key later is the same one-line edit; see README "Quick start".',
  ]);
}

const failure = checkNodeVersion() ?? (await checkSqlite()) ?? checkKey();

if (failure !== null) {
  process.stderr.write(failure);
  // `process.exitCode` rather than `process.exit()`: the exit code is what stops `&& vite` in the dev
  // script, and exiting outright is what turns an open handle into a libuv crash dump on Windows.
  process.exitCode = 1;
}
