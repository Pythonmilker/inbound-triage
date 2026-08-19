/**
 * The last line before an unrecoverable mistake: a provider key committed to a public repo is scraped
 * and drained within minutes, and `git rm` does not take it back out of history.
 *
 * So this scans every file git can see — tracked and untracked-but-not-ignored, which is exactly the set
 * a `git add -A` would commit — for key-shaped strings, and checks that `.env` is ignored in fact and not
 * only by intention.
 *
 * Two properties make the difference between a scanner and a decoration:
 *
 *   1. It is proved to detect a planted key. A pattern that has never matched anything is not evidence of
 *      anything, and the failure mode of a broken regex here is a silent pass.
 *   2. Its own patterns are assembled from fragments rather than written out, so scanning this file does
 *      not match this file. A scanner that flags itself is one nobody can leave switched on.
 *
 * Deleting this file is the one edit in the repository that has no safe version.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Assembled, never spelled out — see the header. These are the prefixes on the keys this project can
 * plausibly hold: OpenRouter's, and Anthropic's for anyone who points it at Claude directly.
 */
const PROVIDER_PREFIXES: readonly string[] = [
  ['sk', 'or', ''].join('-'),
  ['sk', 'ant', ''].join('-'),
];

/**
 * The entropy rule is a heuristic, so it is not pointed at machine-written files: a lockfile is a wall of
 * package digests and a generated bundle is minified code and data URIs, and neither is where a human
 * pastes a credential. The prefix rule still covers them, because it has no false positives to trade.
 */
const MACHINE_WRITTEN = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

/** A run of base64 characters this long, mixing cases and digits, is not a word or a path. */
const SECRET_RUN_MIN = 32;

/** A raw hex secret has no uppercase to mix, so it gets its own, longer, threshold. */
const HEX_RUN_MIN = 40;

interface Finding {
  path: string;
  kind: string;
  /** Length only. A failure message must locate the key without reprinting it. */
  extent: string;
}

interface ScannedFile {
  path: string;
  text: string;
}

function git(args: readonly string[], input?: string): string {
  return execFileSync('git', [...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

/**
 * Tracked plus untracked-not-ignored. This throws rather than returning nothing when git is unavailable:
 * a scan that cannot list files must fail loudly, because silently passing is the outcome that lets a key
 * through.
 */
function visibleFiles(): string[] {
  return git(['ls-files', '-co', '--exclude-standard'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function generatedFiles(files: readonly string[]): Set<string> {
  const marked = new Set<string>();
  if (files.length === 0) return marked;
  const report = git(['check-attr', 'linguist-generated', '--stdin'], files.join('\n'));
  for (const line of report.split('\n')) {
    const parsed = /^(.*): linguist-generated: (.*)$/.exec(line.trim());
    const path = parsed?.[1];
    const value = parsed?.[2];
    if (path === undefined || value === undefined) continue;
    if (value !== 'unspecified' && value !== 'false') marked.add(path);
  }
  return marked;
}

function gitIgnores(path: string): boolean {
  try {
    git(['check-ignore', '--quiet', path]);
    return true;
  } catch {
    return false;
  }
}

/** Reads what can be read as text. A NUL byte means binary, and a key is not pasted into a binary. */
function readable(paths: readonly string[]): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(ROOT, path));
    } catch {
      // Listed and then removed, or a directory entry from a submodule. Nothing to scan either way.
      continue;
    }
    if (bytes.includes(0)) continue;
    files.push({ path, text: bytes.toString('utf8') });
  }
  return files;
}

function mixesCasesAndDigits(run: string): boolean {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);
}

/**
 * A provider prefix followed by credential characters. The trailing length requirement is what separates
 * a key from prose naming the prefix, which the design documents legitimately do.
 */
function prefixFindings(file: ScannedFile): Finding[] {
  const findings: Finding[] = [];
  for (const prefix of PROVIDER_PREFIXES) {
    for (let at = file.text.indexOf(prefix); at !== -1; at = file.text.indexOf(prefix, at + 1)) {
      const value = /^[A-Za-z0-9_-]{12,}/.exec(file.text.slice(at + prefix.length));
      if (value === null) continue;
      findings.push({
        path: file.path,
        kind: `a ${prefix}… provider key`,
        extent: `${prefix.length + value[0].length} characters`,
      });
    }
  }
  return findings;
}

/**
 * High-entropy literals. Both patterns are built here rather than at module level: a `g` flag carries a
 * `lastIndex`, and a shared one would make each file's result depend on the file scanned before it.
 */
function entropyFindings(file: ScannedFile): Finding[] {
  const findings: Finding[] = [];

  for (const run of file.text.match(new RegExp(`[A-Za-z0-9+/]{${SECRET_RUN_MIN},}={0,2}`, 'g')) ?? []) {
    if (mixesCasesAndDigits(run)) {
      findings.push({ path: file.path, kind: 'a base64-shaped literal', extent: `${run.length} characters` });
    }
  }

  for (const run of file.text.match(new RegExp(`\\b[0-9a-fA-F]{${HEX_RUN_MIN},}\\b`, 'g')) ?? []) {
    findings.push({ path: file.path, kind: 'a long hex literal', extent: `${run.length} characters` });
  }

  return findings;
}

function describeFindings(findings: readonly Finding[]): string[] {
  return findings.map((finding) => `${finding.path}: ${finding.kind} (${finding.extent})`);
}

describe('the scan itself', () => {
  it('can see the repository it is meant to be scanning', () => {
    const files = visibleFiles();
    // Anti-vacuity: run from the wrong directory, or against a tree git cannot read, and every other
    // assertion in this file passes by scanning nothing.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('package.json');
    expect(files).toContain('tests/no-secrets.test.ts');
  });

  it('finds a planted key', () => {
    const openrouter = PROVIDER_PREFIXES[0];
    const anthropic = PROVIDER_PREFIXES[1];
    if (openrouter === undefined || anthropic === undefined) {
      throw new Error('both provider prefixes have to be scanned for');
    }

    // Assembled at runtime so the plant never sits in this file as a literal.
    expect(
      prefixFindings({ path: 'planted', text: `OPENROUTER_API_KEY=${openrouter}v1-${'9f4c'.repeat(16)}` }),
    ).toHaveLength(1);
    expect(
      prefixFindings({ path: 'planted', text: `ANTHROPIC_API_KEY=${anthropic}api03-${'Ab3d'.repeat(20)}` }),
    ).toHaveLength(1);
    // 'Xz9' rather than 'Ab3': the latter is also valid hex, so it would trip both rules at once and
    // the count would stop saying which one fired.
    expect(entropyFindings({ path: 'planted', text: `const token = '${'Xz9'.repeat(14)}';` })).toEqual([
      { path: 'planted', kind: 'a base64-shaped literal', extent: '42 characters' },
    ]);
    expect(entropyFindings({ path: 'planted', text: `secret=${'a1b2c3d4'.repeat(6)}` })).toEqual([
      { path: 'planted', kind: 'a long hex literal', extent: '48 characters' },
    ]);
  });

  it('does not flag prose that names a prefix, or an ordinary identifier', () => {
    const openrouter = PROVIDER_PREFIXES[0];
    if (openrouter === undefined) throw new Error('no prefix to test with');

    expect(prefixFindings({ path: 'prose', text: `keys start with ${openrouter}, so grep for that` })).toEqual(
      [],
    );
    expect(entropyFindings({ path: 'code', text: 'const noUncheckedIndexedAccessIsALongIdentifier = 1;' })).toEqual(
      [],
    );
  });
});

describe('the working tree', () => {
  it('ignores .env, in fact and not only in .gitignore', () => {
    const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim());
    expect(lines).toContain('.env');
    expect(lines).toContain('.env.local');

    // The listing is the intention; check-ignore is what git will actually do.
    expect(gitIgnores('.env')).toBe(true);
    expect(gitIgnores('.env.local')).toBe(true);
    expect(gitIgnores('.env.example')).toBe(false);
  });

  it('exposes no .env file to a commit', () => {
    const exposed = visibleFiles().filter((path) => {
      const name = basename(path);
      return name === '.env' || (name.startsWith('.env.') && name !== '.env.example');
    });
    expect(exposed).toEqual([]);
  });

  it('ships .env.example with no value for the key', () => {
    // Which is why the exemption below costs nothing: the one file allowed to name a key does not.
    const lines = readFileSync(join(ROOT, '.env.example'), 'utf8')
      .split('\n')
      .map((line) => line.trim());
    expect(lines).toContain('OPENROUTER_API_KEY=');
  });
});

describe('every file git can see', () => {
  it('contains no provider key', () => {
    const files = readable(visibleFiles()).filter((file) => file.path !== '.env.example');
    const findings = files.flatMap(prefixFindings);
    expect(describeFindings(findings)).toEqual([]);
  });

  it('contains no credential-shaped literal', () => {
    const paths = visibleFiles();
    const generated = generatedFiles(paths);
    const files = readable(paths).filter(
      (file) => !generated.has(file.path) && !MACHINE_WRITTEN.has(basename(file.path)),
    );

    // The scan has to have seen the source, not just the leftovers of the skip list.
    expect(files.map((file) => file.path)).toContain('src/llm/client.ts');
    expect(files.map((file) => file.path)).toContain('.env.example');

    const findings = files.flatMap(entropyFindings);
    expect(describeFindings(findings)).toEqual([]);
  });
});
