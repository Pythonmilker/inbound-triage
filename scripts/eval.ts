/**
 * Three prompt arms over the same queue, measured. This is the evidence behind D-006 (which model ships)
 * and D-009 (which prompt architecture ships) — two decisions that would otherwise be settled by argument.
 *
 * ONE FILE, NO FRAMEWORK, and it has to stay that way (DESIGN §7). If this grows a runner, a fixture
 * directory, or a second module, it has stopped being the right size for the question it answers.
 *
 * It decides nothing. It prints numbers, and the one sentence those numbers support. D-006 and D-009 are
 * Joel's calls: arm 3 measuring well would be a finding to take to him, never a licence for a script to
 * reverse a locked decision.
 *
 * Two invariants worth naming because both are easy to lose:
 *   1. LABELS ARE NEVER WRITTEN HERE. The script emits a stub with null labels and says why in the stub
 *      itself. A label written by the thing being graded proves nothing.
 *   2. The key is read, handed to the transport, and never printed — not to the terminal, not into the
 *      committed report. Provider `detail` strings are redacted on the way in, because a report is a file
 *      that gets committed and a provider that echoes a request must not put a credential in it.
 *
 * The report is deliberately ASCII, for the same reason the prompt layer is: it is read in a terminal at
 * least as often as in a browser, and two runs should diff on their numbers rather than on their encoding.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadInbound } from '../src/ingest/load.js';
import { mapWithConcurrency } from '../src/lib/pool.js';
import { callTriage } from '../src/llm/client.js';
import { MODEL_REGISTRY, TRIAGE_CHAIN, estimateCostUsd } from '../src/llm/protocol.js';
import { observe, renderObservations, type Signal } from '../src/triage/observations.js';
import { buildSystemPrompt, buildUserPrompt, renderMessageBlock } from '../src/triage/prompt.js';
import { applyRules, unreadableReason } from '../src/triage/rules.js';
import { validateVerdict } from '../src/triage/validate.js';
import { CATEGORY_IDS, PRIORITY_IDS } from '../src/triage/types.js';
import type {
  Category,
  FailureKind,
  InboundMessage,
  Priority,
  RulesVerdict,
  UnreadableReason,
} from '../src/triage/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const INBOUND_PATH = join(ROOT, 'raw', 'inbound.json');
const LABELS_PATH = join(ROOT, 'eval', 'labels.json');
const DEFAULT_OUT_PATH = join(ROOT, 'eval', 'report.md');
const ENV_PATH = join(ROOT, '.env');

/** The same ceiling run.ts uses. A different cap would measure a different thing. */
const EVAL_MAX_TOKENS = 600;

/** Matches the app's default. Raise it and the provider's rate limit becomes part of the measurement. */
const DEFAULT_CONCURRENCY = 4;

/** Below this many messages a percentage is a count wearing a percent sign. The report says so rather than
 * pretending otherwise; nothing is enforced. */
const SMALL_SAMPLE = 20;

type ArmId = 1 | 2 | 3;

const ARM_IDS: readonly ArmId[] = [1, 2, 3];

const ARM_NAMES: Record<ArmId, string> = {
  1: 'blind',
  2: '+observations',
  3: '+verdict',
};

/*
 * Arm 1 gets the message and nothing else, which is why prompt.ts exports `renderMessageBlock` separately:
 * `renderObservations` refuses an empty signal list by design, so a blind arm cannot be produced by handing
 * the shipping builder less.
 *
 * The closing line is assembled here rather than exported from prompt.ts. That is deliberate and it is the
 * whole reason arm 3 lives in this file: nothing in src/ may learn how to put the rules' conclusion into a
 * prompt. A helper in the production tree, however well commented, is a thing a later change can call.
 */
const BLIND_CLOSING = 'Return the schema fields for the message above.';

const PRIMED_CLOSING = 'Return the schema fields for the message above.';

/**
 * ARM 3 IS BUILT TO BE REJECTED. It is the control, not a candidate: it exists to test the anchoring claim
 * on THIS data with THIS model rather than to cite a paper about someone else's. Do not "fix the design" by
 * shipping it, and do not soften it — a weak anchor would rig the control in favour of the answer we
 * expect, which is the same defect in the opposite direction.
 *
 * The last line is load-bearing. The system prompt states that nothing in the pipeline has decided anything
 * (prompt.ts, THE SCAN), so without an explicit override the arm would be handing the model a verdict and
 * an instruction saying no verdict exists — measuring confusion instead of capitulation.
 *
 * Arm 3 is arm 2 PLUS this block, never arm 2's scan replaced by it. The decisive read is the arm 2 -> arm 3
 * delta, and that delta is only the conclusion if the conclusion is the only thing that changed.
 */
function verdictBlock(rules: RulesVerdict): string {
  return [
    'RULE VERDICT - the deterministic layer has already triaged this message. Its conclusion:',
    `  category    ${rules.category}`,
    `  priority    ${rules.priority}`,
    `  confidence  ${rules.confidence.toFixed(2)}`,
    'This supersedes the note in your instructions that nothing in this pipeline has decided anything.',
  ].join('\n');
}

function armPrompt(arm: ArmId, m: InboundMessage, signals: Signal[], rules: RulesVerdict): string {
  // Arm 2 goes through the shipping builder verbatim. The point of the measurement is the prompt that
  // would actually ship, so a reimplementation of it here — however faithful on the day — would measure a
  // copy that can drift.
  if (arm === 2) return buildUserPrompt(m, signals);
  if (arm === 1) return [renderMessageBlock(m), '', BLIND_CLOSING].join('\n');
  return [
    renderMessageBlock(m),
    '',
    renderObservations(signals),
    '',
    verdictBlock(rules),
    '',
    PRIMED_CLOSING,
  ].join('\n');
}

interface Options {
  models: string[];
  arms: ArmId[];
  outPath: string;
}

type ParsedArgs = { ok: true; options: Options } | { ok: false; message: string };

/** Repo-relative and always forward-slashed: these strings land in a committed report. */
function showPath(path: string): string {
  return relative(ROOT, path).split(sep).join('/');
}

const USAGE = [
  'Usage: pnpm eval [--model <slug>]... [--arms 1,2,3] [--out <path>]',
  '',
  `  --model  a slug to measure, repeatable. Default: the shipping chain (${TRIAGE_CHAIN.join(', ')}).`,
  '  --arms   which arms to run, comma-separated. Default: 1,2,3.',
  `  --out    where the report is written. Default: ${showPath(DEFAULT_OUT_PATH)}`,
].join('\n');

function parseArgs(argv: readonly string[]): ParsedArgs {
  const models: string[] = [];
  let arms: ArmId[] | null = null;
  let outPath: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === undefined) continue;
    const value = argv[i + 1];

    if (flag === '--model') {
      if (value === undefined) return { ok: false, message: '--model needs a model slug.' };
      // Repeated slugs collapse rather than being measured twice: two identical columns would read as
      // agreement between independent runs.
      if (!models.includes(value)) models.push(value);
      i += 1;
      continue;
    }

    if (flag === '--arms') {
      if (value === undefined) return { ok: false, message: '--arms needs a list, e.g. --arms 1,2,3.' };
      const wanted = new Set<ArmId>();
      for (const token of value.split(',')) {
        const trimmed = token.trim();
        const arm = ARM_IDS.find((id) => String(id) === trimmed);
        if (arm === undefined) {
          return { ok: false, message: `--arms does not know ${JSON.stringify(trimmed)}; arms are 1, 2, 3.` };
        }
        wanted.add(arm);
      }
      arms = ARM_IDS.filter((id) => wanted.has(id));
      i += 1;
      continue;
    }

    if (flag === '--out') {
      if (value === undefined) return { ok: false, message: '--out needs a path.' };
      outPath = resolve(process.cwd(), value);
      i += 1;
      continue;
    }

    // An unknown flag stops the run. Ignoring `--models` as a typo and silently measuring the defaults is
    // how a report ends up describing a model nobody asked about.
    return { ok: false, message: `Unknown argument ${JSON.stringify(flag)}.` };
  }

  return {
    ok: true,
    options: {
      models: models.length > 0 ? models : [...TRIAGE_CHAIN],
      arms: arms ?? [...ARM_IDS],
      outPath: outPath ?? DEFAULT_OUT_PATH,
    },
  };
}

/** The same shape as the preflight: one refusal line, then what to do about it. */
function fail(lines: readonly string[]): void {
  const [first, ...rest] = lines;
  console.error(`✗ ${first ?? 'eval cannot run.'}`);
  for (const line of rest) console.error(`  ${line}`);
  process.exitCode = 1;
}

interface Verdict {
  category: Category;
  priority: Priority;
  confidence: number;
  summary: string;
}

interface Cell {
  model: string;
  arm: ArmId;
  messageId: string;
  verdict: Verdict | null;
  /**
   * The slug that actually answered. `buildTriageRequest` always sends the whole chain, so we can ask for a
   * model and cannot forbid the fallthrough — this is the only attribution that can be trusted.
   */
  answeredBy: string | null;
  routed: boolean;
  failure: FailureKind | null;
  detail: string;
  latencyMs: number;
  costUsd: number | null;
}

interface Task {
  model: string;
  arm: ArmId;
  messageId: string;
  user: string;
}

interface Row {
  message: InboundMessage;
  signals: Signal[];
  rules: RulesVerdict;
  unreadable: UnreadableReason | null;
}

/** OpenRouter may answer with a variant suffix (`:free`, `:nitro`). That is the same model, not a reroute. */
function baseSlug(slug: string): string {
  const colon = slug.indexOf(':');
  return colon === -1 ? slug : slug.slice(0, colon);
}

async function runCell(
  task: Task,
  ctx: { system: string; apiKey: string; onDone: (cell: Cell) => void },
): Promise<Cell> {
  const startedAt = performance.now();
  const call = await callTriage(
    { system: ctx.system, user: task.user, maxTokens: EVAL_MAX_TOKENS },
    { apiKey: ctx.apiKey, model: task.model },
  );
  const latencyMs = Math.round(performance.now() - startedAt);

  const base: Omit<Cell, 'verdict' | 'answeredBy' | 'routed' | 'failure' | 'detail' | 'costUsd'> = {
    model: task.model,
    arm: task.arm,
    messageId: task.messageId,
    latencyMs,
  };

  const redact = (text: string): string =>
    ctx.apiKey === '' ? text : text.split(ctx.apiKey).join('[key redacted]');

  let cell: Cell;
  if (!call.ok) {
    cell = {
      ...base,
      verdict: null,
      answeredBy: null,
      routed: false,
      failure: call.failure,
      detail: redact(call.detail ?? ''),
      costUsd: null,
    };
  } else {
    const usage = call.usage;
    // Priced against the slug that ANSWERED. Billing a chain fallthrough at the primary's rate is how a
    // cost column ends up flattering the model that did not do the work.
    const costUsd =
      usage === undefined
        ? null
        : estimateCostUsd(call.model, usage.promptTokens, usage.completionTokens);
    const routed = baseSlug(call.model) !== baseSlug(task.model);
    const validated = validateVerdict(call.raw);
    cell = validated.ok
      ? {
          ...base,
          verdict: {
            category: validated.value.category,
            priority: validated.value.priority,
            confidence: validated.value.confidence,
            summary: validated.value.summary,
          },
          answeredBy: call.model,
          routed,
          failure: null,
          detail: '',
          costUsd,
        }
      : {
          ...base,
          verdict: null,
          answeredBy: call.model,
          routed,
          failure: validated.failure,
          detail: redact(validated.problems.join('; ')),
          costUsd,
        };
  }

  ctx.onDone(cell);
  return cell;
}

interface Labels {
  byId: Map<string, { category: Category | null; priority: Priority | null }>;
  problems: string[];
}

function readLabels(path: string, knownIds: ReadonlySet<string>): Labels {
  const byId = new Map<string, { category: Category | null; priority: Priority | null }>();
  const problems: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${showPath(path)} could not be read: ${describeError(error)}`);
    return { byId, problems };
  }

  const labels = isRecord(parsed) ? parsed['labels'] : undefined;
  if (!isRecord(labels)) {
    problems.push(`${showPath(path)} has no "labels" object; nothing was read from it.`);
    return { byId, problems };
  }

  for (const [id, entry] of Object.entries(labels)) {
    if (!knownIds.has(id)) {
      problems.push(`label for ${id}, which is not a message in the queue`);
      continue;
    }
    if (!isRecord(entry)) {
      problems.push(`label for ${id} is not an object`);
      continue;
    }
    // A typo is reported rather than dropped. Silently treating "existing-client" as unlabelled would
    // understate accuracy and look like the model got it wrong.
    const category = entry['category'];
    const priority = entry['priority'];
    let ok = true;
    if (category !== null && category !== undefined && category !== '' && !isCategory(category)) {
      problems.push(`label for ${id} has category ${JSON.stringify(category)}, which is not in the taxonomy`);
      ok = false;
    }
    if (priority !== null && priority !== undefined && priority !== '' && !isPriority(priority)) {
      problems.push(`label for ${id} has priority ${JSON.stringify(priority)}, which is not a priority`);
      ok = false;
    }
    if (!ok) continue;
    byId.set(id, {
      category: isCategory(category) ? category : null,
      priority: isPriority(priority) ? priority : null,
    });
  }

  return { byId, problems };
}

const LABELS_STUB_NOTES = {
  what: 'Hand-written labels for the eval. Only the rows where the arms disagreed with each other, or where the rule floor disagreed with them, are listed. The brief never asked for a labelled set, so a full gold standard would be gold-plating; these are the rows where a label changes a number that matters.',
  who: 'Joel writes these. The script does not, and will not: a label written by the thing being graded proves nothing. Every category and priority below ships null and stays null until a person fills it in. A null row is counted as unlabelled, never as agreement.',
  how: `Set category to one of: ${CATEGORY_IDS.join(', ')}. Set priority to one of: ${PRIORITY_IDS.join(', ')}. "why" is for you and the live session, not for the script.`,
  absent:
    'What the arms answered is deliberately NOT in this file - it is in the report. Reading the candidates before writing the label is the same anchoring effect this eval exists to measure, applied to the labeller.',
  rerun: 'This file is read and never rewritten. Delete it to get a fresh stub.',
} as const;

interface StubRow {
  message: InboundMessage;
  because: string;
}

function writeLabelsStub(path: string, rows: readonly StubRow[]): void {
  const labels: Record<string, unknown> = {};
  for (const row of rows) {
    labels[row.message.id] = {
      in_stub_because: row.because,
      subject: row.message.subject,
      body: row.message.body,
      category: null,
      priority: null,
      why: '',
    };
  }

  const stub = {
    _what: LABELS_STUB_NOTES.what,
    _who: LABELS_STUB_NOTES.who,
    _how: LABELS_STUB_NOTES.how,
    _deliberately_absent: LABELS_STUB_NOTES.absent,
    _rerun: LABELS_STUB_NOTES.rerun,
    labels,
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(stub, null, 2)}\n`, 'utf8');
}

interface Rate {
  hits: number;
  of: number;
}

function rate(hits: number, of: number): Rate {
  return { hits, of };
}

function pct(r: Rate): string {
  return r.of === 0 ? 'n/a' : `${((r.hits / r.of) * 100).toFixed(1)}% (${r.hits}/${r.of})`;
}

function share(r: Rate): number | null {
  return r.of === 0 ? null : r.hits / r.of;
}

function points(from: number, to: number): string {
  const delta = (to - from) * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points`;
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

interface ArmStats {
  /** Every call made for this model and arm, answered or not. */
  cells: Cell[];
  /** Answered by the slug we asked for, which is all a per-model comparison may count. */
  attributable: Cell[];
  failures: Map<FailureKind, number>;
  categoryVsLabels: Rate;
  priorityVsLabels: Rate;
  categoryVsRules: Rate;
  priorityVsRules: Rate;
  costUsd: number;
  meanLatencyMs: number;
  maxLatencyMs: number;
  /** Blind-to-primed movement. Empty for arm 1, and for any arm run without arm 1 to compare against. */
  flips: Rate;
  flipsTowardRules: Rate;
  flipsRulesRight: Rate;
  flipsRulesWrong: Rate;
  flipsUnlabelled: Rate;
}

/**
 * One model, one arm, in numbers. Two rules about what counts, both of which change the answer:
 *
 * Agreement and accuracy count only ATTRIBUTABLE cells. A row the chain answered with a different slug is
 * real data about that other model and a lie about this one, so it is named in the report and left out here.
 *
 * A flip needs both ends — this arm's verdict and the blind arm's, both attributable. Missing either, the row
 * is dropped rather than counted as "no flip", which would read as stability the run never observed.
 */
function statsFor(
  model: string,
  arm: ArmId,
  cells: readonly Cell[],
  rowsById: ReadonlyMap<string, Row>,
  labels: Labels,
  blindByMessage: ReadonlyMap<string, Cell>,
): ArmStats {
  const mine = cells.filter((c) => c.model === model && c.arm === arm);
  const answered = mine.filter((c) => c.verdict !== null);
  const attributable = answered.filter((c) => !c.routed);

  const failures = new Map<FailureKind, number>();
  for (const cell of mine) {
    if (cell.failure === null) continue;
    failures.set(cell.failure, (failures.get(cell.failure) ?? 0) + 1);
  }

  let catVsLabels = rate(0, 0);
  let priVsLabels = rate(0, 0);
  let catVsRules = rate(0, 0);
  let priVsRules = rate(0, 0);
  let costUsd = 0;
  let latencyTotal = 0;
  let maxLatency = 0;

  for (const cell of mine) {
    // A null cost is left out of the total rather than added as zero — see `estimateCostUsd`. The report
    // counts those calls separately so the total cannot quietly read as free.
    if (cell.costUsd !== null) costUsd += cell.costUsd;
    latencyTotal += cell.latencyMs;
    maxLatency = Math.max(maxLatency, cell.latencyMs);
  }

  for (const cell of attributable) {
    const verdict = cell.verdict;
    const row = rowsById.get(cell.messageId);
    if (verdict === null || row === undefined) continue;

    catVsRules = rate(
      catVsRules.hits + (verdict.category === row.rules.category ? 1 : 0),
      catVsRules.of + 1,
    );
    priVsRules = rate(
      priVsRules.hits + (verdict.priority === row.rules.priority ? 1 : 0),
      priVsRules.of + 1,
    );

    const label = labels.byId.get(cell.messageId);
    if (label?.category != null) {
      catVsLabels = rate(catVsLabels.hits + (verdict.category === label.category ? 1 : 0), catVsLabels.of + 1);
    }
    if (label?.priority != null) {
      priVsLabels = rate(priVsLabels.hits + (verdict.priority === label.priority ? 1 : 0), priVsLabels.of + 1);
    }
  }

  let flips = rate(0, 0);
  let towardRules = rate(0, 0);
  let rulesRight = rate(0, 0);
  let rulesWrong = rate(0, 0);
  let unlabelled = rate(0, 0);

  if (arm !== 1) {
    for (const cell of attributable) {
      const blind = blindByMessage.get(cell.messageId);
      const row = rowsById.get(cell.messageId);
      if (blind === undefined || blind.verdict === null || blind.routed || row === undefined) continue;
      const verdict = cell.verdict;
      if (verdict === null) continue;

      const flipped = verdict.category !== blind.verdict.category;
      flips = rate(flips.hits + (flipped ? 1 : 0), flips.of + 1);

      // The anchoring signature, counted over the flips themselves rather than over every row: of the
      // answers this arm changed, how many landed on the rule floor's category.
      if (flipped) {
        const onto = verdict.category === row.rules.category;
        towardRules = rate(towardRules.hits + (onto ? 1 : 0), towardRules.of + 1);
      }

      const label = labels.byId.get(cell.messageId);
      if (label?.category == null) {
        unlabelled = rate(unlabelled.hits + (flipped ? 1 : 0), unlabelled.of + 1);
      } else if (row.rules.category === label.category) {
        rulesRight = rate(rulesRight.hits + (flipped ? 1 : 0), rulesRight.of + 1);
      } else {
        rulesWrong = rate(rulesWrong.hits + (flipped ? 1 : 0), rulesWrong.of + 1);
      }
    }
  }

  return {
    cells: mine,
    attributable,
    failures,
    categoryVsLabels: catVsLabels,
    priorityVsLabels: priVsLabels,
    categoryVsRules: catVsRules,
    priorityVsRules: priVsRules,
    costUsd,
    meanLatencyMs: mine.length === 0 ? 0 : Math.round(latencyTotal / mine.length),
    maxLatencyMs: maxLatency,
    flips,
    flipsTowardRules: towardRules,
    flipsRulesRight: rulesRight,
    flipsRulesWrong: rulesWrong,
    flipsUnlabelled: unlabelled,
  };
}

/**
 * The read, in plain words, because a reader should not have to infer it from two tables. This is the
 * sentence D-009 turns on: agreement rising from arm 2 to arm 3 while accuracy does not is capitulation.
 */
function readForModel(model: string, byArm: ReadonlyMap<ArmId, ArmStats>): string[] {
  const lines: string[] = [`### ${model}`, ''];
  const arm2 = byArm.get(2);
  const arm3 = byArm.get(3);

  if (arm2 === undefined || arm3 === undefined) {
    lines.push(
      'Arms 2 and 3 were not both run, so the comparison that decides D-009 was not made. Run `pnpm eval` with',
      '`--arms 1,2,3`.',
      '',
    );
    return lines;
  }

  const agree2 = share(arm2.categoryVsRules);
  const agree3 = share(arm3.categoryVsRules);
  const acc2 = share(arm2.categoryVsLabels);
  const acc3 = share(arm3.categoryVsLabels);

  lines.push(
    `- rule/model category agreement: arm 2 ${pct(arm2.categoryVsRules)} -> arm 3 ${pct(arm3.categoryVsRules)}`,
    `- category accuracy vs Joel's labels: arm 2 ${pct(arm2.categoryVsLabels)} -> arm 3 ${pct(arm3.categoryVsLabels)}`,
    `- arm 3 flips away from blind: ${pct(arm3.flips)}, of which onto the rules' own answer: ${pct(arm3.flipsTowardRules)}`,
    '',
  );

  if (agree2 === null || agree3 === null) {
    lines.push('Neither arm produced an attributable verdict, so there is nothing to read here yet.', '');
    return lines;
  }

  const agreementRose = agree3 > agree2;
  const agreementMoved = `Agreement with the rules ${agreementRose ? 'rose' : agree3 < agree2 ? 'fell' : 'did not move'} by ${points(agree2, agree3)}.`;

  if (acc2 === null || acc3 === null) {
    lines.push(
      `${agreementMoved} Accuracy is UNMEASURED: the labelled rows do not cover both arms yet.`,
      "Rising agreement with unmeasured accuracy is exactly what capitulation looks like from the outside, so it",
      'is not evidence for arm 3 and must not be reported as any. Fill in the label stub and re-run - that is the',
      'whole reason the stub exists.',
      '',
    );
    return lines;
  }

  if (agreementRose && acc3 <= acc2) {
    const wrongFlips = arm3.flipsRulesWrong;
    lines.push(
      'CAPITULATION, measured.',
      `${agreementMoved} Accuracy did not follow it: ${points(acc2, acc3)}.`,
      "The model moved onto the rule floor's answer without getting more answers right" +
        (wrongFlips.hits > 0
          ? `, including on ${wrongFlips.hits} of the ${wrongFlips.of} ${wrongFlips.of === 1 ? 'row' : 'rows'} where the floor itself was wrong.`
          : '.'),
      'So the higher agreement is not two layers converging on the truth - it is one layer echoing the other, on',
      'this data, with this model. That is the anchoring claim reproduced here rather than cited from a paper.',
      'Arm 3 does not ship: reconciliation is only worth having while the two halves can genuinely disagree.',
      '',
    );
    return lines;
  }

  if (agreementRose) {
    lines.push(
      `${agreementMoved} Accuracy rose with it: ${points(acc2, acc3)}.`,
      'On this data, with this model, the anchoring effect did not reproduce. Record that as measured - it is a',
      "finding for Joel, not a change this script may make: D-009 is his call and arm 3 stays rejected until he",
      'reverses it on this evidence. Note before anyone does: a queue this small can move several points on one',
      'row, and the flip columns say whether the movement was toward the rules or toward the labels.',
      '',
    );
    return lines;
  }

  lines.push(
    `${agreementMoved} The control did not fire: handing the model the conclusion did not pull it toward the`,
    'rules on this queue. That is not an argument for arm 3 either - nothing was gained, and the anchoring risk',
    'it was built to expose is unmeasured rather than absent at a larger sample. Arm 2 still has to earn its',
    'place on its own accuracy column.',
    '',
  );
  return lines;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORY_IDS as readonly string[]).includes(value);
}

function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITY_IDS as readonly string[]).includes(value);
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => ' --- ').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

function verdictCell(cell: Cell | undefined): string {
  if (cell === undefined) return 'not run';
  if (cell.verdict === null) return cell.failure === null ? 'no verdict' : `FAILED ${cell.failure}`;
  return `${cell.verdict.category} / ${cell.verdict.priority}${cell.routed ? ' *' : ''}`;
}

interface ReportInput {
  models: readonly string[];
  arms: readonly ArmId[];
  calls: number;
  runnable: readonly Row[];
  skipped: readonly Row[];
  parseNote: string | null;
  cells: readonly Cell[];
  labels: Labels;
  stubRows: readonly StubRow[];
  /** Whether the labels file was already on disk. A stub is only ever written when it was not. */
  labelsExisted: boolean;
  statsByModel: ReadonlyMap<string, ReadonlyMap<ArmId, ArmStats>>;
}

/**
 * The whole report, as one string. Section order, row order and column order are fixed here, which is what
 * makes two runs diff on their numbers rather than on their layout.
 */
function renderReport(input: ReportInput): string {
  const { models, arms, runnable, skipped, parseNote, cells, labels, stubRows, labelsExisted, statsByModel } =
    input;

  const out: string[] = [];
  out.push(
    '# Model eval - three prompt arms',
    '',
    `Generated by \`pnpm eval\` at ${new Date().toISOString()}. Latency, cost and the models themselves move`,
    'between runs; the ordering of everything below does not, so two reports diff on their numbers.',
    '',
    `Ran ${input.calls} calls: ${runnable.length} messages x ${arms.length} arm(s) (${arms
      .map((arm) => `${arm} ${ARM_NAMES[arm]}`)
      .join(', ')}) x ${models.length} model(s).`,
    '',
  );
  if (parseNote !== null) out.push(`Loader: ${parseNote}`, '');
  if (skipped.length > 0) {
    out.push(
      `Ruled unreadable by the rule floor before any call, exactly as the app does: ${skipped
        .map((row) => `${row.message.id} (${row.unreadable})`)
        .join(', ')}. No call was spent on them.`,
      '',
    );
  }
  if (runnable.length < SMALL_SAMPLE) {
    out.push(
      `Sample size: ${runnable.length} messages. One row is worth about ${(100 / runnable.length).toFixed(1)} points, so read the`,
      'percentages as counts and treat a one-row difference as noise. This measures a decision on the supplied',
      'queue; it is not a benchmark.',
      '',
    );
  }

  out.push(
    '## The arms',
    '',
    ...table(
      ['arm', 'the prompt contains', 'what it is for'],
      [
        ['1 blind', 'the message only', 'the baseline'],
        ['2 +observations', 'the message plus the symmetric scan, no verdict', 'the shipping candidate (D-009)'],
        ['3 +verdict', "arm 2 plus the rule floor's conclusion", 'the control, built to be rejected'],
      ],
    ),
    '',
    'Full description, and what each result would mean: `prompts/arms.md`. Arm 3 exists only in this script -',
    'nothing in `src/` knows how to put a verdict in a prompt, which is the point.',
    '',
    '## Agreement and accuracy',
    '',
  );

  const qualityRows: string[][] = [];
  const movementRows: string[][] = [];
  const spendRows: string[][] = [];
  for (const model of models) {
    const byArm = statsByModel.get(model);
    if (byArm === undefined) continue;
    for (const arm of arms) {
      const s = byArm.get(arm);
      if (s === undefined) continue;
      qualityRows.push([
        model,
        `${arm} ${ARM_NAMES[arm]}`,
        `${s.attributable.length}/${s.cells.length}`,
        pct(s.categoryVsLabels),
        pct(s.priorityVsLabels),
        pct(s.categoryVsRules),
        pct(s.priorityVsRules),
      ]);
      movementRows.push([
        model,
        `${arm} ${ARM_NAMES[arm]}`,
        arm === 1 ? '-' : pct(s.flips),
        arm === 1 ? '-' : pct(s.flipsTowardRules),
        arm === 1 ? '-' : pct(s.flipsRulesRight),
        arm === 1 ? '-' : pct(s.flipsRulesWrong),
        arm === 1 ? '-' : pct(s.flipsUnlabelled),
      ]);
      const perMessage = s.attributable.length === 0 ? 0 : s.costUsd / s.attributable.length;
      spendRows.push([
        model,
        `${arm} ${ARM_NAMES[arm]}`,
        String(s.cells.length),
        usd(s.costUsd),
        usd(perMessage),
        `$${(perMessage * 10_000).toFixed(2)}`,
        String(s.meanLatencyMs),
        String(s.maxLatencyMs),
        s.failures.size === 0
          ? 'none'
          : [...s.failures.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([kind, n]) => `${kind} x${n}`)
              .join(', '),
      ]);
    }
  }

  out.push(
    ...table(
      ['model', 'arm', 'attributable', 'category vs labels', 'priority vs labels', 'category vs rules', 'priority vs rules'],
      qualityRows,
    ),
    '',
    '`attributable` counts the answered calls that came back from the slug we asked for. Accuracy columns cover',
    "only the rows Joel labelled; `n/a` means unlabelled, never 'agreed'.",
    '',
    '## Blind-to-primed movement, split by whether the rules were right',
    '',
    ...table(
      ['model', 'arm', 'flips vs blind', "of those, onto the rules' answer", 'flips: rules right', 'flips: rules wrong', 'flips: unlabelled'],
      movementRows,
    ),
    '',
    'A flip is a message where this arm chose a different category than the blind arm did, same model, same',
    "message. The second column is the subset of those flips that landed on the rule floor's category, which",
    'is the anchoring signature. The last three columns split the flips by whether the floor was right, which',
    'is the only way to tell a model being helped from a model capitulating: flips onto a WRONG floor are the',
    'measured cost of injecting a conclusion.',
    '',
    '## Cost and latency',
    '',
    ...table(
      ['model', 'arm', 'calls', 'cost', 'per message', 'at 10k/day', 'mean ms', 'max ms', 'failures'],
      spendRows,
    ),
    '',
    'Cost is `estimateCostUsd` over the tokens the provider reported, priced against the slug that answered.',
    'At this volume cost cannot discriminate between candidates - the whole queue is a fraction of a cent - so',
    'the `at 10k/day` column is the one that carries information, and it is scale evidence rather than a build',
    'argument.',
    '',
  );

  const unpricedCalls = cells.filter((c) => c.answeredBy !== null && c.costUsd === null).length;
  if (unpricedCalls > 0) {
    out.push(
      `${unpricedCalls} call(s) answered without a usable usage report, so their cost is absent from the totals`,
      'rather than counted as zero: a zero disappears into a sum and reads as free.',
      '',
    );
  }

  out.push('## Per message', '');

  for (const model of models) {
    out.push(`### ${model}`, '');
    const perMessage: string[][] = runnable.map((row) => {
      const label = labels.byId.get(row.message.id);
      return [
        row.message.id,
        `${row.rules.category} / ${row.rules.priority} (${row.rules.confidence.toFixed(2)})`,
        label === undefined || (label.category === null && label.priority === null)
          ? 'unlabelled'
          : `${label.category ?? '?'} / ${label.priority ?? '?'}`,
        ...arms.map((arm) =>
          verdictCell(cells.find((c) => c.model === model && c.arm === arm && c.messageId === row.message.id)),
        ),
      ];
    });
    out.push(
      ...table(
        ['message', 'rule floor', "Joel's label", ...arms.map((arm) => `arm ${arm} ${ARM_NAMES[arm]}`)],
        perMessage,
      ),
      '',
      '`*` marks a verdict that came back from a different slug than the one requested, so it is excluded from',
      "that model's numbers above.",
      '',
    );
  }

  // The rows a person actually has to adjudicate, with the model's own words on them. A category grid says
  // that an arm was wrong; only the summary says what it thought it was reading, which is what rationale
  // answer (c) asks for — one concrete mis-triage, detected and handled.
  if (stubRows.length > 0) {
    out.push('## What the model said on the rows that disagreed', '');
    for (const row of stubRows) {
      out.push(`**${row.message.id}** - ${row.because}. Subject: ${row.message.subject || '(none)'}`, '');
      for (const model of models) {
        for (const arm of arms) {
          const cell = cells.find(
            (c) => c.model === model && c.arm === arm && c.messageId === row.message.id,
          );
          if (cell === undefined) continue;
          const said =
            cell.verdict === null
              ? `no verdict (${cell.failure ?? 'unknown'})`
              : `${cell.verdict.category} / ${cell.verdict.priority} @ ${cell.verdict.confidence.toFixed(2)} - "${cell.verdict.summary}"`;
          out.push(`- ${model} arm ${arm} ${ARM_NAMES[arm]}: ${said}`);
        }
      }
      out.push('');
    }
  }

  out.push('## The read', '');
  for (const model of models) {
    const byArm = statsByModel.get(model);
    if (byArm === undefined) continue;
    out.push(...readForModel(model, byArm));
  }

  if (models.length > 1) {
    out.push('### Which model ships (D-006)', '');
    const shippingArm = arms.includes(2) ? 2 : arms[arms.length - 1];
    if (shippingArm === undefined) {
      out.push('No arm was run, so there is nothing to compare.', '');
    } else {
      const ranked = models
        .map((model) => ({ model, stats: statsByModel.get(model)?.get(shippingArm) }))
        .filter((entry): entry is { model: string; stats: ArmStats } => entry.stats !== undefined);
      const anyLabels = ranked.some((entry) => entry.stats.categoryVsLabels.of > 0);
      out.push(
        `Compared on arm ${shippingArm} (${ARM_NAMES[shippingArm]}), which is the arm that would ship.`,
        '',
        ...table(
          ['model', 'category vs labels', 'category vs rules', 'failures', 'cost', 'mean ms'],
          ranked.map((entry) => [
            entry.model,
            pct(entry.stats.categoryVsLabels),
            pct(entry.stats.categoryVsRules),
            entry.stats.failures.size === 0 ? 'none' : String([...entry.stats.failures.values()].reduce((a, b) => a + b, 0)),
            usd(entry.stats.costUsd),
            String(entry.stats.meanLatencyMs),
          ]),
        ),
        '',
      );
      out.push(
        anyLabels
          ? 'Choose on the accuracy column. Cost does not discriminate at this volume, so it is a tie-breaker and'
          : 'This cannot be settled yet: with no labels there is no accuracy column, and agreement with the rules is',
        anyLabels
          ? 'nothing more, with latency behind it.'
          : 'not accuracy - a model that agreed with the floor on every row would score perfectly while being wrong.',
        '',
      );
    }
  }

  out.push('## Labels', '');
  const labelled = [...labels.byId.values()].filter((l) => l.category !== null || l.priority !== null).length;
  out.push(
    `${stubRows.length} row(s) disagreed and are worth a label. ${labelled} row(s) carry one.`,
    '',
  );
  if (!labelsExisted && stubRows.length > 0) {
    out.push(
      `Wrote the stub to \`${showPath(LABELS_PATH)}\` with those rows and NULL labels. ${LABELS_STUB_NOTES.who}`,
      '',
      `${LABELS_STUB_NOTES.absent}`,
      '',
    );
  } else if (labelsExisted) {
    out.push(`Read \`${showPath(LABELS_PATH)}\`. It was not rewritten - delete it for a fresh stub.`, '');
    const unlabelled = stubRows.filter((row) => {
      const label = labels.byId.get(row.message.id);
      return label === undefined || label.category === null;
    });
    if (unlabelled.length > 0) {
      out.push(
        `Still unlabelled, and each one is a row where a label would change a number above: ${unlabelled
          .map((row) => row.message.id)
          .join(', ')}.`,
        '',
      );
    }
  } else {
    out.push('No arm disagreed with any other and none disagreed with the rule floor, so no stub was written.', '');
  }
  if (labels.problems.length > 0) {
    out.push('Problems in the labels file, reported rather than skipped:', '');
    for (const problem of [...labels.problems].sort()) out.push(`- ${problem}`);
    out.push('');
  }

  const failedCells = cells.filter((c) => c.verdict === null);
  const routedCells = cells.filter((c) => c.routed);
  if (failedCells.length > 0 || routedCells.length > 0) {
    out.push('## Calls that did not land cleanly', '');
    for (const cell of failedCells) {
      out.push(
        `- ${cell.model} arm ${cell.arm} ${cell.messageId}: ${cell.failure ?? 'unknown'}${cell.detail === '' ? '' : ` - ${cell.detail}`}`,
      );
    }
    for (const cell of routedCells) {
      out.push(
        `- ${cell.model} arm ${cell.arm} ${cell.messageId}: answered by ${cell.answeredBy ?? 'unknown'} instead. The request sends the whole chain, so a provider error falls through; the row is excluded from this model's numbers.`,
      );
    }
    out.push('');
  }

  return `${out.join('\n')}\n`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    fail([parsed.message, 'Run `pnpm eval --help` for the flags.']);
    return;
  }
  const { models, arms, outPath } = parsed.options;

  const ineligible = models.filter((slug) => MODEL_REGISTRY[slug]?.structuredOutputs !== true);
  if (ineligible.length > 0) {
    // `modelChain` drops an override it cannot use, silently and by design, so an unregistered slug here
    // would produce a column of another model's answers with this model's name on it.
    const eligible = Object.values(MODEL_REGISTRY)
      .filter((facts) => facts.structuredOutputs)
      .map((facts) => facts.slug)
      .sort();
    fail([
      `Cannot measure ${ineligible.join(', ')}: not in the model registry with structured-output support.`,
      'The chain drops a model it cannot use, so the eval would silently measure a different one.',
      `Registered and capable: ${eligible.join(', ')}`,
    ]);
    return;
  }

  // Shell environment wins over the file, which is what `process.loadEnvFile` already does. Nothing here
  // reads, prints or writes the value beyond handing it to the transport.
  if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
  const apiKey = process.env['OPENROUTER_API_KEY'] ?? '';
  if (apiKey.trim() === '') {
    fail([
      'OPENROUTER_API_KEY is not set.',
      'Copy .env.example to .env and add a key — see README "Quick start".',
      'The eval measures real model calls; there is nothing to measure without one.',
    ]);
    return;
  }

  const { messages, parseNote } = loadInbound(INBOUND_PATH);

  const rows: Row[] = messages.map((message) => {
    const signals = observe(message);
    return {
      message,
      signals,
      rules: applyRules(message, signals),
      unreadable: unreadableReason(message, signals),
    };
  });
  const rowsById = new Map(rows.map((row) => [row.message.id, row]));

  // The app never spends a call on a message with nothing checkable in it, so neither does the measurement.
  // Including them would price and score a call that production does not make.
  const runnable = rows.filter((row) => row.unreadable === null);
  const skipped = rows.filter((row) => row.unreadable !== null);

  const system = buildSystemPrompt();

  // Every prompt is assembled before the first call: an assembly error then costs nothing instead of
  // surfacing a third of the way through a paid run.
  const tasks: Task[] = [];
  for (const model of models) {
    for (const arm of arms) {
      for (const row of runnable) {
        tasks.push({ model, arm, messageId: row.message.id, user: armPrompt(arm, row.message, row.signals, row.rules) });
      }
    }
  }

  const concurrency = Number(process.env['TRIAGE_CONCURRENCY'] ?? DEFAULT_CONCURRENCY);
  console.error(
    `${tasks.length} calls: ${runnable.length} messages x ${arms.length} arm(s) x ${models.length} model(s).`,
  );

  let done = 0;
  const cells = await mapWithConcurrency(tasks, concurrency, (task) =>
    runCell(task, {
      system,
      apiKey,
      onDone: (cell) => {
        done += 1;
        // Progress goes to stderr so the report on stdout stays byte-stable apart from its numbers.
        const outcome = cell.verdict === null ? `FAILED ${cell.failure ?? 'unknown'}` : 'ok';
        console.error(
          `[${done}/${tasks.length}] ${cell.messageId} arm ${cell.arm} ${cell.model} ${outcome} ${cell.latencyMs}ms`,
        );
      },
    }),
  );

  const knownIds = new Set(messages.map((m) => m.id));
  const labelsExisted = existsSync(LABELS_PATH);
  const labels: Labels = labelsExisted
    ? readLabels(LABELS_PATH, knownIds)
    : { byId: new Map(), problems: [] };

  // Rows worth a label: the arms disagreed with each other, or the rule floor disagreed with them. The
  // second half matters as much as the first — "split by whether the rules were right" is unmeasurable
  // without a label on exactly the rows where the floor and the model part ways.
  const stubRows: StubRow[] = [];
  for (const row of runnable) {
    const answers = cells.filter((c) => c.messageId === row.message.id && c.verdict !== null && !c.routed);
    if (answers.length === 0) continue;
    const distinct = new Set(answers.map((c) => `${c.verdict?.category}/${c.verdict?.priority}`));
    const armsDisagree = distinct.size > 1;
    const rulesDisagree = answers.some(
      (c) => c.verdict?.category !== row.rules.category || c.verdict?.priority !== row.rules.priority,
    );
    if (!armsDisagree && !rulesDisagree) continue;
    stubRows.push({
      message: row.message,
      because:
        armsDisagree && rulesDisagree
          ? 'the arms disagree with each other, and the rule floor disagrees with them'
          : armsDisagree
            ? 'the arms disagree with each other'
            : 'the rule floor disagrees with every arm',
    });
  }

  if (!labelsExisted && stubRows.length > 0) writeLabelsStub(LABELS_PATH, stubRows);

  const statsByModel = new Map<string, Map<ArmId, ArmStats>>();
  for (const model of models) {
    const blindByMessage = new Map(
      cells.filter((c) => c.model === model && c.arm === 1).map((c) => [c.messageId, c]),
    );
    const byArm = new Map<ArmId, ArmStats>();
    for (const arm of arms) {
      byArm.set(arm, statsFor(model, arm, cells, rowsById, labels, blindByMessage));
    }
    statsByModel.set(model, byArm);
  }

  const report = renderReport({
    models,
    arms,
    calls: tasks.length,
    runnable,
    skipped,
    parseNote,
    cells,
    labels,
    stubRows,
    labelsExisted,
    statsByModel,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report, 'utf8');
  console.log(report);
  console.error(`Report written to ${showPath(outPath)}`);
}

await main();
