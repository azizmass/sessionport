import { select, input, confirm } from '@inquirer/prompts';
import { ClaudeReader } from '../readers/claude.js';
import { OpenCodeReader } from '../readers/opencode.js';
import { CodexReader } from '../readers/codex.js';
import type { Reader } from '../readers/types.js';
import { compactSession } from '../render/compact.js';
import { renderJson } from '../render/json.js';
import { renderMarkdown } from '../render/markdown.js';
import { renderSeed } from '../render/seeds.js';
import type { SeedTarget } from '../render/seeds.js';
import { ClaudeImporter } from '../importers/claude.js';
import { OpenCodeImporter } from '../importers/opencode.js';
import { CodexImporter } from '../importers/codex.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { displayTitle, formatSessionTime } from '../ir/normalize.js';
import { extractPlans, selectPlans } from '../ir/plan.js';
import { planSession, renderPlanMarkdown } from '../render/plan.js';

export async function runWizard(): Promise<void> {
  const sourceVal = await select<string>({
    message: 'Select source tool:',
    loop: false,
    choices: [
      { name: 'Claude Code', value: 'claude' },
      { name: 'OpenCode', value: 'opencode' },
      { name: 'Codex', value: 'codex' },
    ],
  });

  let reader: Reader;
  switch (sourceVal) {
    case 'claude': reader = new ClaudeReader(); break;
    case 'opencode': reader = new OpenCodeReader(); break;
    case 'codex': reader = new CodexReader(); break;
    default: throw new Error(`Unknown source: ${sourceVal}`);
  }

  const sessions = reader.listSessions();
  if (sessions.length === 0) {
    console.log(`No sessions found for ${sourceVal}.`);
    return;
  }

  // The reader flags plans while listing, so the choice can be offered before
  // picking a session rather than after. Readers that cannot tell leave the
  // flag undefined, and the question is asked after the read instead.
  const planCount = sessions.filter((s) => s.hasPlan).length;
  const want = planCount
    ? await select<'session' | 'plan'>({
        message: 'What do you want to port?',
        loop: false,
        choices: [
          { name: 'A whole session', value: 'session' },
          {
            name: `Just a plan  (${planCount} of ${sessions.length} sessions have one)`,
            value: 'plan',
          },
        ],
      })
    : undefined;

  const pool = want === 'plan' ? sessions.filter((s) => s.hasPlan) : sessions;

  const sessionChoice = await select<string>({
    message:
      want === 'plan'
        ? `Select a session to take the plan from (${pool.length} available):`
        : `Select session (${pool.length} available, use arrows to browse):`,
    loop: false,
    choices: pool.map((s) => ({
      name:
        `${displayTitle(s, 65).padEnd(67)} ${formatSessionTime(s.updatedAt || s.createdAt)}` +
        `${s.model ? ' [' + s.model + ']' : ''}` +
        // Redundant once the list is already filtered down to plans.
        `${s.hasPlan && want !== 'plan' ? '  \u{1F4CB} plan' : ''}`,
      value: s.id,
    })),
    pageSize: 10,
  });

  console.log(`Reading session...`);
  const sourceSession = reader.readSession(sessionChoice);
  const plans = extractPlans(sourceSession);

  let what: 'session' | 'plan' = want ?? 'session';

  if (want === undefined && plans.length) {
    // No listing-level detection for this source, so ask now that we know.
    what = await select<'session' | 'plan'>({
      message: 'What do you want to port?',
      loop: false,
      choices: [
        { name: 'The whole session', value: 'session' },
        {
          name: `Just the plan${plans.length > 1 ? ` (${plans.length} revisions)` : ''}`,
          value: 'plan',
        },
      ],
    });
  }

  if (what === 'plan') {
    if (!plans.length) {
      console.log('That session turned out not to carry a readable plan.');
      return;
    }
    await doPlan(sourceSession, plans);
    return;
  }

  const mode = await select<'as-is' | 'compacted'>({
    message: 'Export mode:',
    loop: false,
    choices: [
      { name: 'As-is (full conversation history)', value: 'as-is' },
      { name: 'Compacted (summarized tool calls/outputs, trimmed reasoning)', value: 'compacted' },
    ],
  });

  const target = await select<string>({
    message: 'Target:',
    loop: false,
    choices: [
      { name: '📥 Import into Claude Code', value: 'import-claude' },
      { name: '📥 Import into OpenCode', value: 'import-opencode' },
      { name: '📥 Import into Codex', value: 'import-codex' },
      { name: '───── Export to file ─────', value: '-sep-' },
      { name: '📄 Portable JSON (.session.json)', value: 'json' },
      { name: '📄 Readable markdown (.md)', value: 'markdown' },
      { name: '🌱 Seed prompt for OpenCode', value: 'opencode' },
      { name: '🌱 Seed prompt for Claude Code', value: 'claude' },
      { name: '🌱 Seed prompt for Codex', value: 'codex' },
      { name: '🌱 Seed prompt (generic)', value: 'generic' },
    ],
  });

  if (target === '-sep-') {
    console.log('Please select a valid target.');
    return;
  }

  const finalSession = mode === 'compacted' ? compactSession(sourceSession) : sourceSession;

  if (target.startsWith('import-')) {
    const importTarget = target.replace('import-', '');
    await doImport(finalSession, importTarget);
  } else {
    await doExport(finalSession, target as SeedTarget | 'json' | 'markdown', mode);
  }
}

async function doPlan(
  session: import('../ir/types.js').SessionIR,
  found: import('../ir/plan.js').PlanIR[],
): Promise<void> {
  const all =
    found.length > 1 &&
    (await confirm({
      message: `Include all ${found.length} plan revisions? (No = only the final one)`,
      default: false,
    }));

  const plans = selectPlans(found, all);
  const planIR = planSession(session, plans);

  const target = await select<string>({
    message: 'Send the plan to:',
    loop: false,
    choices: [
      { name: '📥 OpenCode', value: 'opencode' },
      { name: '📥 Claude Code', value: 'claude' },
      { name: '📥 Codex', value: 'codex' },
      { name: '📄 Markdown file', value: 'markdown' },
    ],
  });

  if (target === 'markdown') {
    const outDir = await input({ message: 'Output directory:', default: './export' });
    const resolvedDir = resolve(outDir);
    if (!existsSync(resolvedDir)) mkdirSync(resolvedDir, { recursive: true });
    const outPath = join(resolvedDir, `${session.id.slice(0, 12)}_plan.md`);
    writeFileSync(outPath, renderPlanMarkdown(session, plans), 'utf-8');
    console.log(`\n✅ Plan written: ${outPath}`);
    return;
  }

  await doImport(planIR, target);
}

async function doImport(session: import('../ir/types.js').SessionIR, target: string): Promise<void> {
  try {
    let result;
    switch (target) {
      case 'claude': {
        const importer = new ClaudeImporter();
        result = importer.importSession(session);
        console.log(`\n✅ Session imported into Claude Code!`);
        console.log(`   Title: "${session.title}"`);
        console.log(`   Messages: ${result.messageCount}`);
        console.log(`   File: ${result.path}`);
        console.log(`\n   ▶ Open Claude Code and run: claude --resume`);
        console.log(`   (Or run \`claude --continue\` in the same directory)`);
        break;
      }
      case 'opencode': {
        const importer = new OpenCodeImporter();
        result = importer.importSession(session);
        console.log(`\n✅ Session imported into OpenCode!`);
        console.log(`   Title: "${session.title}"`);
        console.log(`   Messages: ${result.messageCount}`);
        console.log(`\n   ▶ Open OpenCode and find "${session.title.slice(0, 40)}..." in your session list.`);
        console.log(`   (DB backup saved at: opencode.db.sessionport-backup)`);
        break;
      }
      case 'codex': {
        const importer = new CodexImporter();
        result = importer.importSession(session);
        console.log(`\n✅ Session imported into Codex!`);
        console.log(`   Title: "${session.title}"`);
        console.log(`   Messages: ${result.messageCount}`);
        console.log(`\n   ▶ Open Codex and find "${session.title.slice(0, 40)}..." in your session list.`);
        break;
      }
    }
  } catch (err) {
    console.error(`\n❌ Import failed: ${(err as Error).message}`);
  }
}

async function doExport(
  session: import('../ir/types.js').SessionIR,
  target: SeedTarget | 'json' | 'markdown',
  mode: string,
): Promise<void> {
  const outDir = await input({
    message: 'Output directory:',
    default: './export',
  });

  const resolvedDir = resolve(outDir);
  if (!existsSync(resolvedDir)) mkdirSync(resolvedDir, { recursive: true });

  const baseName = `${session.sourceTool}_${session.id.slice(0, 12)}_${mode}`.replace(/[^a-z0-9_-]/g, '_');
  const seedTargets = new Set<string>(['opencode', 'claude', 'codex', 'generic']);

  if (target === 'json') {
    const outPath = join(resolvedDir, `${baseName}.session.json`);
    writeFileSync(outPath, renderJson(session), 'utf-8');
    console.log(`\n📄 JSON session exported:\n   ${outPath}`);
  } else if (target === 'markdown') {
    const outPath = join(resolvedDir, `${baseName}.md`);
    writeFileSync(outPath, renderMarkdown(session, { compacted: mode === 'compacted' }), 'utf-8');
    console.log(`\n📄 Markdown transcript exported:\n   ${outPath}`);
  } else if (seedTargets.has(target)) {
    const outPath = join(resolvedDir, `${baseName}_to_${target}.seed.md`);
    writeFileSync(outPath, renderSeed(session, target as SeedTarget), 'utf-8');
    console.log(`\n🌱 Seed prompt for ${target} exported:\n   ${outPath}`);
  }
}
