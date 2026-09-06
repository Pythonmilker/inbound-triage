/**
 * Import-graph rules that enforce the boundaries `architecture/model.c4` declares.
 *
 * Every boundary rule below names the model.c4 line it comes from. The model is the source of
 * truth; this file is only the executable half of it. A rule set to `warn` is flagging a real
 * violation in today's code — the comment on that rule says which import, and weakening a rule
 * without recording the import it hides is not allowed.
 *
 * Taxonomy note: `src/triage/types.ts` and `src/triage/schema.ts` are NOT engine stages. model.c4
 * lines 472-492 model them as the `taxonomy` artifact — shared data rows and the output shape —
 * so both lanes may depend on them.
 */

const TAXONOMY = '^src/triage/(types|schema)\.ts$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'browser-holds-no-credential',
      comment:
        'model.c4:40 — browser "Holds no credential of any kind"; model.c4:96 the Node process is ' +
        '"The only place the API key exists". The browser lane may never reach the server module ' +
        'or the preflight that reads the key.',
      severity: 'error',
      from: { path: '^src/(ui/|main\.tsx$)' },
      to: { path: '^(src/server/|scripts/preflight\.ts$)' },
    },
    {
      name: 'browser-imports-rows-only',
      comment:
        'model.c4:520 — "apiclient -> server: rows only". The browser lane must not import store, ' +
        'engine, LLM or ingest code; it asks the local server for rows and renders them ' +
        '(model.c4:42-43). FAILURE_POLICY/attemptSummary/fixForRow moved into the taxonomy artifact ' +
        '(src/triage/types.ts, grown to name them) since they are presentation over an enum, exactly ' +
        'like CATEGORIES/PRIORITIES. RunNote/RunSummary moved out of the orchestrator into ' +
        "src/runContract.ts (model.c4's new runcontract artifact) — the wire shape the server returns, " +
        "decoded by the browser without touching the engine's internals.",
      severity: 'error',
      from: { path: '^src/(ui/|main\.tsx$)' },
      to: {
        path: '^src/(store/|llm/|ingest/|lib/|triage/)',
        pathNot: TAXONOMY,
      },
    },
    {
      name: 'engine-stages-flow-one-way',
      comment:
        'model.c4:530-540 — the pipeline runs ingest -> observations -> rules/prompt -> pool -> ' +
        'llm -> validate -> reconcile. No earlier stage may import a later one: an upstream stage ' +
        'that reaches downstream turns a pipeline into a cycle. This rule covers the ingest -> ' +
        'triage hop; the rules below cover every remaining stage as a source, including src/llm. ' +
        'src/triage/run.ts is the orchestrator, not a stage — model.c4:527 has the server drive ' +
        'the engine — so it is exempt as a source and forbidden as a target everywhere. The one ' +
        'downstream import model.c4:530 permits from ingest is observations (passes repaired messages), ' +
        'so observations is exempt as a target here.',
      severity: 'error',
      from: { path: '^src/ingest/' },
      to: { path: '^src/triage/', pathNot: [TAXONOMY, '^src/triage/observations'] },
    },
    {
      name: 'engine-prompt-never-reaches-downstream',
      comment:
        'model.c4:532-534 — prompt is fed by observations and feeds pool; nothing else. It may not ' +
        'import the rule floor, the transport, validate, retry, reconcile or the orchestrator.',
      severity: 'error',
      from: { path: '^src/triage/prompt\.ts$' },
      to: {
        path: '^src/(triage/(rules|validate|retry|reconcile|run)\.ts|llm/)',
      },
    },
    {
      name: 'engine-validate-never-reaches-back',
      comment:
        'model.c4:537 "validate -> reconcile the model verdict" and model.c4:539 "validate -> ' +
        'retry" are the ONLY legal edges out of validate, so both are omitted below. Validate may ' +
        'not import an upstream stage (ingest, observations, rules, prompt, the transport) nor ' +
        'the orchestrator.',
      severity: 'error',
      from: { path: '^src/triage/validate\.ts$' },
      to: {
        path: '^src/(triage/(observations|rules|prompt|run)\.ts|llm/|ingest/)',
      },
    },
    {
      name: 'engine-retry-never-reaches-back',
      comment:
        'model.c4:540 — "retry -> pool drains when the blocker clears" is retry\'s only outgoing ' +
        'edge. It may import no other stage: not reconcile, not validate, not an upstream stage, ' +
        'not the orchestrator.',
      severity: 'error',
      from: { path: '^src/triage/retry\.ts$' },
      to: {
        path: '^src/(triage/(observations|rules|prompt|validate|reconcile|run)\.ts|llm/|ingest/)',
      },
    },
    {
      name: 'engine-reconcile-is-terminal',
      comment:
        'model.c4:540-542 — reconcile is the last stage: it takes the model verdict and the ' +
        'deterministic verdict and writes the row and the notice. It may import no other engine ' +
        'stage and no transport — only the store, the notifier and the taxonomy.',
      severity: 'error',
      from: { path: '^src/triage/reconcile\.ts$' },
      to: {
        path: '^src/(triage/(observations|rules|prompt|validate|retry|run)\.ts|llm/|ingest/)',
      },
    },
    {
      name: 'engine-stages-never-import-the-orchestrator',
      comment:
        'model.c4:527 — the server runs the engine; the engine does not run itself. No stage may ' +
        'import src/triage/run.ts, which would invert the drive direction and close a cycle.',
      severity: 'error',
      from: { path: '^src/(triage/(observations|rules|prompt|validate|retry|reconcile)\.ts|ingest/|llm/)' },
      to: { path: '^src/triage/run\.ts$' },
    },
    {
      name: 'engine-observations-never-reaches-downstream',
      comment:
        'model.c4:531-532 — observations feeds rules and prompt and nothing else (both omitted ' +
        'below as legal targets). It may not import reconcile, validate, retry, the transport or ' +
        'the orchestrator.',
      severity: 'error',
      from: { path: '^src/triage/observations\.ts$' },
      to: {
        path: '^src/(triage/(reconcile|validate|retry|run)\.ts|llm/)',
      },
    },
    {
      name: 'engine-rules-only-reaches-reconcile',
      comment:
        'model.c4:538 "rules -> reconcile the deterministic verdict" is the rule floor\'s only ' +
        'outgoing edge, so reconcile is omitted below. Rules may not import prompt, the ' +
        'transport, validate, retry or the orchestrator.',
      severity: 'error',
      from: { path: '^src/triage/rules\.ts$' },
      to: {
        path: '^src/(triage/(prompt|validate|retry|run)\.ts|llm/)',
      },
    },
    {
      name: 'engine-transport-never-reaches-back',
      comment:
        'model.c4:536-537 — the transport is fed by pool and hands its unchecked reply to validate ' +
        '(that edge omitted below). As an engine stage it may not import an earlier stage: ' +
        'ingest, observations, rules, prompt — nor retry, reconcile or the orchestrator.',
      severity: 'error',
      from: { path: '^src/llm/' },
      to: {
        path: '^src/(triage/(observations|rules|prompt|retry|reconcile|run)\.ts|ingest/)',
        pathNot: TAXONOMY,
      },
    },
    {
      name: 'transport-never-imports-store-or-server',
      comment:
        'model.c4:535-537 — the model transport talks to OpenRouter and hands an unchecked reply ' +
        'to validate. It has no edge to the store, the API surface or the notifier: only ' +
        'reconcile writes a row (model.c4:541-542).',
      severity: 'error',
      from: { path: '^src/llm/' },
      to: { path: '^src/(store/|server/|integrations/)' },
    },
    {
      name: 'store-and-server-never-import-the-ui',
      comment:
        'model.c4:37-90 vs 93-132 — the browser and the Node process are separate containers, and ' +
        'every edge between them runs browser -> server (model.c4:473). Nothing in the Node lane ' +
        'may import a React component.',
      severity: 'error',
      from: { path: '^src/(server/|store/|triage/|llm/|ingest/|integrations/)' },
      to: { path: '^src/(ui/|main\.tsx$)' },
    },
    {
      name: 'lib-is-leaf-only',
      comment:
        'model.c4:339-352 — the bounded pool is a generic utility (no import outside src/lib); ' +
        'src/lib is a leaf and may depend on nothing but the runtime. src/lib/hash.ts moved to ' +
        "src/triage/hash.ts (model.c4:353-371, the new engine.hash component) because it was " +
        'domain-coupled to InboundMessage by construction; src/lib now holds only pool.ts, which ' +
        'makes the leaf property actually hold.',
      severity: 'error',
      from: { path: '^src/lib/' },
      to: { path: '^src/', pathNot: '^src/lib/' },
    },
    {
      name: 'no-circular',
      comment:
        'A cycle means no stage boundary holds anywhere in the loop — every module in it is both ' +
        'upstream and downstream of the others. The three type-only cycles that used to run through ' +
        'src/ui/{Grid,Row,SummaryBar}.tsx importing QueueRow from App.tsx are gone: QueueRow now lives ' +
        'in src/ui/types.ts, which nothing in the browser lane imports back from.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment:
        'A module nothing imports and that imports nothing is either dead code or a file the ' +
        'graph cannot see — both are worth knowing about.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\.[^/]+\.(js|cjs|mjs|ts|cts|mts|json)$',
          '\.d\.ts$',
          '(^|/)tsconfig\.json$',
          '(^|/)(babel|webpack|vite)\.config\.(js|cjs|mjs|ts|cts|mts|json)$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
