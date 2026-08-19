/**
 * The code cannot cite a design decision nobody can read.
 *
 * Comments across `src/` carry `D-NNN` references, and each one is a promise that an explanation exists.
 * A citation that resolves nowhere is worse than no citation: it tells the reader there is a reason and
 * then does not supply one. `docs/DESIGN.md` §9 is the single place those ids are declared, so this test
 * fails the build when a reference and its declaration part company.
 *
 * The failure this prevents already happened once. Three ids were cited in code with nothing declaring
 * them, and it surfaced only because someone went looking. A mechanism catches it; an intention does not.
 *
 * What it deliberately does not check: that a decision exists for every change. No test can know what was
 * decided in a conversation. The guarantee is narrower and still worth having.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where a reference may appear. `eval/` is generated output and is deliberately not searched. */
const SEARCHED = ['src', 'tests', 'scripts', 'prompts', 'architecture', 'docs'];
const SEARCHED_EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.c4', '.css', '.json']);

const DECLARING_FILE = 'docs/DESIGN.md';

/** A citation anywhere. The optional letter covers sub-decisions like `D-011b`, which resolve to `D-011`. */
const REFERENCE = /\bD-(\d{3})[a-z]?\b/g;

/**
 * A row of the §9 table, which is the only thing that declares an id. One row can settle two ids at once
 * (`| D-006/D-009 |`) where a single call answered both, so the cell is split rather than matched whole.
 */
const DECLARATION = /^\|[ \t]*(D-\d{3}(?:\/D-\d{3})*)[ \t]*\|/gm;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return SEARCHED_EXTENSIONS.has(extname(entry)) ? [full] : [];
  });
}

function references(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of SEARCHED) {
    for (const file of walk(join(ROOT, dir))) {
      for (const match of readFileSync(file, 'utf8').matchAll(REFERENCE)) {
        const id = `D-${match[1]}`;
        const where = found.get(id) ?? [];
        // One entry per file rather than per occurrence: a failure wants to name files, not count hits.
        const shown = file.slice(ROOT.length).split('\\').join('/');
        if (!where.includes(shown)) where.push(shown);
        found.set(id, where);
      }
    }
  }
  return found;
}

function declarations(): string[] {
  const text = readFileSync(join(ROOT, DECLARING_FILE), 'utf8');
  return [...text.matchAll(DECLARATION)].flatMap((match) => (match[1] ?? '').split('/'));
}

describe('design decision references', () => {
  it('finds the table that declares them', () => {
    // Without this the suite passes vacuously if the table is reformatted: no declarations parsed and no
    // references either would look identical to agreement.
    expect(declarations().length).toBeGreaterThan(0);
  });

  it('declares every decision the code refers to', () => {
    const declared = new Set(declarations());
    const dangling = [...references().entries()]
      .filter(([id]) => !declared.has(id))
      .map(([id, files]) => `${id} -> ${files.join(', ')}`)
      .sort();

    expect(dangling, `decision references that resolve nowhere in ${DECLARING_FILE}`).toEqual([]);
  });

  it('declares each id exactly once', () => {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const id of declarations()) {
      if (seen.has(id)) duplicated.add(id);
      seen.add(id);
    }

    // Two rows for one id means one is being read and the other ignored, with nothing saying which.
    expect([...duplicated].sort()).toEqual([]);
  });
});
