/**
 * The import rules forbid what their comments say they forbid.
 *
 * `pnpm lint:deps` proves that today's imports break no rule. It cannot prove that a rule would fire: a
 * pattern that matches nothing passes as quietly as one that is obeyed. Two defects sat behind a green lint
 * that way. Every `\.` had lost its backslash before dependency-cruiser saw it, and no rule forbade an import
 * that runs the way a model arrow does. So this suite loads `.dependency-cruiser.cjs` and applies its patterns
 * to the paths of the real files.
 *
 * What it deliberately does not check: that dependency-cruiser reads a pattern the way `forbiddenBy` below
 * does, or anything about `no-circular` and `no-orphans` beyond the orphan exclusions. Those two are
 * properties of the whole graph, and `pnpm lint:deps` is what covers them.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Patterns = string | string[];

interface Side {
  path?: Patterns;
  pathNot?: Patterns;
  orphan?: boolean;
  circular?: boolean;
}

interface Rule {
  name: string;
  from: Side;
  to: Side;
}

interface Config {
  forbidden: Rule[];
  options: { doNotFollow: { path: Patterns } };
}

const config = createRequire(import.meta.url)('../.dependency-cruiser.cjs') as Config;

/** Rules about one import. The other two, cycles and orphans, are about the whole graph. */
const pathRules = config.forbidden.filter((rule) => rule.from.orphan !== true && rule.to.circular !== true);

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    return statSync(join(ROOT, path)).isDirectory() ? walk(path) : [path];
  });
}

/** Every file a rule can name: the source tree, plus `scripts/`, where the preflight that reads the key lives. */
const FILES = [...walk('src'), ...walk('scripts')];

const list = (patterns: Patterns | undefined): string[] =>
  patterns === undefined ? [] : Array.isArray(patterns) ? patterns : [patterns];

const matchesAny = (patterns: Patterns | undefined, path: string): boolean =>
  list(patterns).some((pattern) => new RegExp(pattern).test(path));

/** One side of a rule applies to a path when `path` matches, or is absent, and `pathNot` does not match. */
function applies(side: Side, path: string): boolean {
  if (side.path !== undefined && !matchesAny(side.path, path)) return false;
  return !matchesAny(side.pathNot, path);
}

/** The names of the rules that forbid `from` importing `to`. */
function forbiddenBy(from: string, to: string): string[] {
  return pathRules.filter((rule) => applies(rule.from, from) && applies(rule.to, to)).map((rule) => rule.name);
}

function allPatterns(): { where: string; pattern: string }[] {
  const inRules = config.forbidden.flatMap((rule) =>
    (['from', 'to'] as const).flatMap((side) =>
      (['path', 'pathNot'] as const).flatMap((field) =>
        list(rule[side][field]).map((pattern) => ({ where: `${rule.name} ${side}.${field}`, pattern })),
      ),
    ),
  );
  const inOptions = list(config.options.doNotFollow.path).map((pattern) => ({
    where: 'options.doNotFollow.path',
    pattern,
  }));
  return [...inRules, ...inOptions];
}

describe('import rules: the patterns', () => {
  it('finds rules and files to check', () => {
    // Without this every check below passes vacuously if the config changes shape or the tree moves.
    expect(pathRules.length).toBeGreaterThan(0);
    expect(allPatterns().length).toBeGreaterThan(0);
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('hands dependency-cruiser no pattern with a bare dot in it', () => {
    // A bare `.` matches any character, and no pattern here wants one. A dot that is neither escaped nor
    // inside a character class is a `\.` whose backslash an ordinary quoted string dropped.
    const bare = allPatterns().filter(({ pattern }) => pattern.replace(/\\.|\[[^\]]*\]/g, '').includes('.'));
    expect(bare).toEqual([]);
  });

  it('points both sides of every rule at files that exist', () => {
    // A rule whose source or target matches no file forbids nothing, and lint stays green all the same.
    const pointless = pathRules.flatMap((rule) =>
      (['from', 'to'] as const)
        .filter((side) => rule[side].path !== undefined && !FILES.some((file) => applies(rule[side], file)))
        .map((side) => `${rule.name} ${side}`),
    );
    expect(pointless).toEqual([]);
  });

  const orphanExclusions = config.forbidden.find((rule) => rule.from.orphan === true)?.from.pathNot;

  it('lets the orphan rule look at every source file', () => {
    expect(list(orphanExclusions).length).toBeGreaterThan(0);
    const excluded = FILES.filter((file) => matchesAny(orphanExclusions, file));
    expect(excluded.filter((file) => !file.endsWith('.d.ts'))).toEqual([]);
  });

  it('keeps dotfiles, declaration files and tool configs out of the orphan rule', () => {
    const meantToBeExcluded = ['src/.hidden.ts', 'src/vite-env.d.ts', 'tsconfig.json', 'vite.config.ts'];
    expect(meantToBeExcluded.filter((file) => !matchesAny(orphanExclusions, file))).toEqual([]);
  });
});

/**
 * The pipeline in the order the model draws it. Stages on one row sit side by side: neither feeds the other.
 * The pool is a row because the model draws it as a stage, between the prompt and the transport.
 */
const PIPELINE: readonly (readonly string[])[] = [
  ['src/ingest/load.ts'],
  ['src/triage/observations.ts'],
  ['src/triage/rules.ts', 'src/triage/prompt.ts'],
  ['src/lib/pool.ts'],
  ['src/llm/client.ts', 'src/llm/protocol.ts'],
  ['src/triage/validate.ts'],
  ['src/triage/retry.ts', 'src/triage/reconcile.ts'],
];

const STAGES = PIPELINE.flat();
const ORCHESTRATOR = 'src/triage/run.ts';
const TAXONOMY = ['src/triage/types.ts', 'src/triage/schema.ts'];
const POOL = 'src/lib/pool.ts';

/** The only imports between two stage files that the rules leave open. */
const LEGAL_BETWEEN_STAGES: readonly (readonly [from: string, to: string, why: string])[] = [
  ['src/triage/observations.ts', 'src/ingest/load.ts', 'against the data'],
  ['src/triage/rules.ts', 'src/ingest/load.ts', 'against the data'],
  ['src/triage/rules.ts', 'src/triage/observations.ts', 'against the data, and in use today'],
  ['src/triage/prompt.ts', 'src/ingest/load.ts', 'against the data'],
  ['src/triage/prompt.ts', 'src/triage/observations.ts', 'against the data, and in use today'],
  ['src/llm/client.ts', POOL, 'the pool, from a stage after it'],
  ['src/llm/protocol.ts', POOL, 'the pool, from a stage after it'],
  ['src/triage/validate.ts', POOL, 'the pool, from a stage after it'],
  ['src/triage/reconcile.ts', POOL, 'the pool, from a stage after it'],
  ['src/llm/client.ts', 'src/llm/protocol.ts', 'inside one stage'],
  ['src/llm/protocol.ts', 'src/llm/client.ts', 'inside one stage'],
];

describe('import rules: the engine pipeline', () => {
  it('names stage files that exist', () => {
    // A stage renamed without its rule would leave the rule, and this suite, checking a file that is gone.
    const named = [...STAGES, ORCHESTRATOR, ...TAXONOMY];
    expect(named.filter((file) => !existsSync(join(ROOT, file)))).toEqual([]);
  });

  it('forbids every import that runs the way the data does', () => {
    const open: string[] = [];
    PIPELINE.forEach((earlier, row) => {
      for (const later of PIPELINE.slice(row + 1).flat()) {
        for (const from of earlier) {
          if (forbiddenBy(from, later).length === 0) open.push(`${from} -> ${later}`);
        }
      }
    });
    // The one arrow that points back up the order: the retry queue feeds the pool.
    if (forbiddenBy('src/triage/retry.ts', POOL).length === 0) open.push(`src/triage/retry.ts -> ${POOL}`);

    expect(open).toEqual([]);
  });

  it('leaves open, between stages, exactly the imports listed above', () => {
    const open = STAGES.flatMap((from) =>
      STAGES.filter((to) => to !== from && forbiddenBy(from, to).length === 0).map((to) => `${from} -> ${to}`),
    );
    expect(open.sort()).toEqual(LEGAL_BETWEEN_STAGES.map(([from, to]) => `${from} -> ${to}`).sort());
  });

  it('keeps the orchestrator out of reach of every stage, and every stage within its reach', () => {
    expect(STAGES.filter((stage) => forbiddenBy(stage, ORCHESTRATOR).length === 0)).toEqual([]);
    expect(STAGES.filter((stage) => forbiddenBy(ORCHESTRATOR, stage).length > 0)).toEqual([]);
    expect(forbiddenBy('src/server/handlers.ts', ORCHESTRATOR)).toEqual([]);
  });

  it('opens the taxonomy to every stage but the pool, which may import nothing', () => {
    const readers = STAGES.filter((stage) => stage !== POOL);
    const shut = readers.flatMap((stage) =>
      TAXONOMY.filter((file) => forbiddenBy(stage, file).length > 0).map((file) => `${stage} -> ${file}`),
    );
    expect(shut).toEqual([]);
    expect(TAXONOMY.map((file) => forbiddenBy(POOL, file))).toEqual([['lib-is-leaf-only'], ['lib-is-leaf-only']]);
  });
});

describe('import rules: the two lanes', () => {
  const BROWSER = FILES.filter((file) => /^src\/(ui\/.*|main)\.tsx?$/.test(file));
  const NODE_ONLY = [
    'src/server/handlers.ts',
    'scripts/preflight.ts',
    'src/store/sqlite.ts',
    'src/llm/client.ts',
    'src/ingest/load.ts',
    'src/lib/pool.ts',
    'src/triage/run.ts',
    'src/triage/retry.ts',
  ];

  it('finds the browser lane', () => {
    expect(BROWSER).toContain('src/main.tsx');
    expect(BROWSER).toContain('src/ui/api.ts');
    expect(NODE_ONLY.filter((file) => !existsSync(join(ROOT, file)))).toEqual([]);
  });

  it('keeps the browser lane away from the server, the key and the engine', () => {
    const open = BROWSER.flatMap((from) =>
      NODE_ONLY.filter((to) => forbiddenBy(from, to).length === 0).map((to) => `${from} -> ${to}`),
    );
    expect(open).toEqual([]);
  });

  it('gives the browser lane the taxonomy and the run contract', () => {
    const shared = [...TAXONOMY, 'src/runContract.ts'];
    const shut = BROWSER.flatMap((from) =>
      shared.filter((to) => forbiddenBy(from, to).length > 0).map((to) => `${from} -> ${to}`),
    );
    expect(shut).toEqual([]);
  });

  it('keeps React out of the Node lane', () => {
    const nodeLane = FILES.filter((file) => /^src\/(server|store|triage|llm|ingest|integrations)\//.test(file));
    expect(nodeLane.length).toBeGreaterThan(0);
    expect(nodeLane.filter((from) => forbiddenBy(from, 'src/ui/App.tsx').length === 0)).toEqual([]);
  });
});
