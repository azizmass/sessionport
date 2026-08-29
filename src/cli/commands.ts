import { Command } from 'commander';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { ClaudeReader } from '../readers/claude.js';
import { OpenCodeReader } from '../readers/opencode.js';
import { CodexReader } from '../readers/codex.js';
import type { Reader } from '../readers/types.js';
import { compactSession } from '../render/compact.js';
import { renderJson } from '../render/json.js';
import { renderMarkdown } from '../render/markdown.js';
import { renderSeed } from '../render/seeds.js';
import type { SeedTarget } from '../render/seeds.js';
import type { SessionIR } from '../ir/types.js';
import { ClaudeImporter } from '../importers/claude.js';
import { OpenCodeImporter } from '../importers/opencode.js';
import { CodexImporter } from '../importers/codex.js';
import type { ImportResult } from '../importers/types.js';
import { displayTitle, formatSessionTime } from '../ir/normalize.js';
import { extractPlans, selectPlans } from '../ir/plan.js';
import { planSession, renderPlanMarkdown } from '../render/plan.js';

function getReader(source: string): Reader {
  switch (source) {
    case 'claude': return new ClaudeReader();
    case 'opencode': return new OpenCodeReader();
    case 'codex': return new CodexReader();
    default: throw new Error(`Unknown source: ${source}. Use: claude, opencode, codex`);
  }
}

function listSessions(source: string): void {
  const reader = getReader(source);
  const sessions = reader.listSessions();
  if (sessions.length === 0) {
    console.log(`No sessions found for ${source}.`);
    return;
  }
  console.log(`\n${source.toUpperCase()} sessions:`);
  console.log('-'.repeat(80));
  for (const s of sessions) {
    const updated = formatSessionTime(s.updatedAt || s.createdAt);
    const model = s.model ? ` [${s.model}]` : '';
    const label = displayTitle(s, 50);
    console.log(
      `  ${s.id.padEnd(44)} ${updated}  ${label.padEnd(52)}${model}`,
    );
  }
  console.log();
}

function writeOutput(
  finalSession: SessionIR,
  target: string,
  baseName: string,
  outputDir: string,
  quiet: boolean,
): void {
  const resolvedDir = resolve(outputDir);
  if (!existsSync(resolvedDir)) {
    mkdirSync(resolvedDir, { recursive: true });
  }

  const seedTargets: Set<string> = new Set(['opencode', 'claude', 'codex', 'generic']);

  const safeName = baseName.replace(/[^a-z0-9_-]/g, '_');

  if (target === 'json') {
    const outPath = join(resolvedDir, `${safeName}.session.json`);
    writeFileSync(outPath, renderJson(finalSession), 'utf-8');
    if (!quiet) console.log(`Written: ${outPath}`);
  } else if (target === 'markdown') {
    const outPath = join(resolvedDir, `${safeName}.md`);
    writeFileSync(
      outPath,
      renderMarkdown(finalSession, { compacted: false }),
      'utf-8',
    );
    if (!quiet) console.log(`Written: ${outPath}`);
  } else if (seedTargets.has(target)) {
    const outPath = join(resolvedDir, `${safeName}_to_${target}.seed.md`);
    writeFileSync(outPath, renderSeed(finalSession, target as SeedTarget), 'utf-8');
    if (!quiet) console.log(`Written: ${outPath}`);
  } else {
    console.error(`Unknown target: ${target}. Use: json, markdown, opencode, claude, codex, generic`);
    process.exit(1);
  }
}

function exportSession(
  source: string,
  id: string,
  target: string,
  mode: 'as-is' | 'compacted',
  outputDir: string,
  quiet: boolean,
): void {
  const reader = getReader(source);
  let session: SessionIR;
  try {
    session = reader.readSession(id);
  } catch (err) {
    console.error(`Error reading session: ${(err as Error).message}`);
    process.exit(1);
  }

  const finalSession = mode === 'compacted' ? compactSession(session) : session;
  const baseName = `${session.sourceTool}_${session.id.slice(0, 12)}_${mode}`;
  writeOutput(finalSession, target, baseName, outputDir, quiet);
}

function convertFile(
  filePath: string,
  from: string,
  to: string,
  mode: 'as-is' | 'compacted',
  outputDir: string,
  quiet: boolean,
): void {
  const resolvedFile = resolve(filePath);
  if (!existsSync(resolvedFile)) {
    console.error(`File not found: ${resolvedFile}`);
    process.exit(1);
  }

  let session: SessionIR;

  if (from === 'claude') {
    const reader = new ClaudeReader();
    session = reader.readFromFile(resolvedFile);
  } else if (from === 'codex') {
    const reader = new CodexReader();
    session = reader.readFromFile(resolvedFile);
  } else {
    console.error(`Convert --from must be claude or codex (got: ${from})`);
    process.exit(1);
  }

  const finalSession = mode === 'compacted' ? compactSession(session) : session;
  const baseName = `convert_${from}_${mode}`;
  writeOutput(finalSession, to, baseName, outputDir, quiet);
}

function exportAll(
  source: string,
  target: string,
  mode: 'as-is' | 'compacted',
  outputDir: string,
  quiet: boolean,
): void {
  const reader = getReader(source);
  const sessions = reader.listSessions();
  if (sessions.length === 0) {
    console.log(`No sessions found for ${source}.`);
    return;
  }
  for (const s of sessions) {
    try {
      const session = reader.readSession(s.id);
      const finalSession = mode === 'compacted' ? compactSession(session) : session;
      const baseName = `${session.sourceTool}_${s.id.slice(0, 12)}_${mode}`;
      writeOutput(finalSession, target, baseName, outputDir, true);
    } catch (err) {
      console.error(`Failed to export ${s.id}: ${(err as Error).message}`);
    }
  }
  if (!quiet) console.log(`Exported ${sessions.length} sessions to ${resolve(outputDir)}.`);
}

function importSession(
  source: string,
  id: string,
  mode: 'as-is' | 'compacted',
  targetTool: string,
): void {
  const reader = getReader(source);
  let session: SessionIR;
  try {
    session = reader.readSession(id);
  } catch (err) {
    console.error(`Error reading session: ${(err as Error).message}`);
    process.exit(1);
  }

  const finalSession = mode === 'compacted' ? compactSession(session) : session;
  let result: ImportResult;

  try {
    switch (targetTool) {
      case 'claude': {
        const importer = new ClaudeImporter();
        result = importer.importSession(finalSession);
        break;
      }
      case 'opencode': {
        const importer = new OpenCodeImporter();
        result = importer.importSession(finalSession);
        break;
      }
      case 'codex': {
        const importer = new CodexImporter();
        result = importer.importSession(finalSession);
        break;
      }
      default:
        console.error(`Unknown import target: ${targetTool}. Use: claude, opencode, codex`);
        process.exit(1);
    }
    console.log(`✅ Imported "${session.title}" → ${targetTool}`);
    console.log(`   Messages: ${result.messageCount}`);
  } catch (err) {
    console.error(`❌ Import failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

function exportPlan(
  source: string,
  id: string,
  target: string,
  all: boolean,
  outputDir: string,
  quiet: boolean,
): void {
  const reader = getReader(source);
  let session: SessionIR;
  try {
    session = reader.readSession(id);
  } catch (err) {
    console.error(`Error reading session: ${(err as Error).message}`);
    process.exit(1);
  }

  const found = extractPlans(session);
  if (found.length === 0) {
    console.error(
      `No plan found in ${source} session ${id}. Only sessions where plan mode was used carry one.`,
    );
    process.exit(1);
  }

  const plans = selectPlans(found, all);
  const planIR = planSession(session, plans);

  if (target === 'markdown') {
    const resolvedDir = resolve(outputDir);
    if (!existsSync(resolvedDir)) mkdirSync(resolvedDir, { recursive: true });
    const safeName = `${session.sourceTool}_${session.id.slice(0, 12)}_plan`.replace(/[^a-z0-9_-]/gi, '_');
    const outPath = join(resolvedDir, `${safeName}.md`);
    writeFileSync(outPath, renderPlanMarkdown(session, plans), 'utf-8');
    if (!quiet) console.log(`Written: ${outPath}`);
    return;
  }

  if (target === 'stdout') {
    console.log(renderPlanMarkdown(session, plans));
    return;
  }

  let result: ImportResult;
  try {
    switch (target) {
      case 'opencode': {
        result = new OpenCodeImporter().importSession(planIR);
        break;
      }
      case 'claude': {
        result = new ClaudeImporter().importSession(planIR);
        break;
      }
      case 'codex': {
        result = new CodexImporter().importSession(planIR);
        break;
      }
      default:
        console.error(
          `Unknown plan target: ${target}. Use: opencode, claude, codex, markdown, stdout`,
        );
        process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Plan export failed: ${(err as Error).message}`);
    process.exit(1);
  }

  if (quiet) return;
  const revisions = plans.length > 1 ? ` (${plans.length} revisions)` : '';
  console.log(`✅ Exported plan "${planIR.title}"${revisions} → ${target}`);
  if (target === 'opencode') {
    console.log(`   Open OpenCode and pick it from your session list to start executing it.`);
  } else if (target === 'claude') {
    console.log(`   Run \`claude --resume\` in ${planIR.cwd ?? 'the project directory'} to pick it up.`);
  }
  if (result.path) console.log(`   ${result.path}`);
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('sessionport')
    .description('Port AI coding sessions between tools (Claude Code ⇄ OpenCode ⇄ Codex)')
    .version('0.1.0');

  program
    .command('list')
    .description('List sessions from a source tool')
    .argument('<source>', 'Source tool: claude, opencode, codex')
    .action((source: string) => {
      listSessions(source);
    });

  program
    .command('export')
    .description('Export a session')
    .argument('<source>', 'Source tool: claude, opencode, codex')
    .argument('<id>', 'Session ID')
    .option('-t, --to <target>', 'Target format: json, markdown, opencode, claude, codex, generic', 'markdown')
    .option('-m, --mode <mode>', 'Export mode: as-is, compacted', 'as-is')
    .option('-o, --out <dir>', 'Output directory', './export')
    .option('-q, --quiet', 'Suppress progress output')
    .action(
      (source: string, id: string, options: { to: string; mode: string; out: string; quiet?: boolean }) => {
        exportSession(source, id, options.to, options.mode as 'as-is' | 'compacted', options.out, options.quiet ?? false);
      },
    );

  program
    .command('export-all')
    .description('Export all sessions from a source tool')
    .argument('<source>', 'Source tool: claude, opencode, codex')
    .option('-t, --to <target>', 'Target format', 'markdown')
    .option('-m, --mode <mode>', 'Export mode: as-is, compacted', 'as-is')
    .option('-o, --out <dir>', 'Output directory', './export')
    .option('-q, --quiet', 'Suppress progress output')
    .action(
      (source: string, options: { to: string; mode: string; out: string; quiet?: boolean }) => {
        exportAll(source, options.to, options.mode as 'as-is' | 'compacted', options.out, options.quiet ?? false);
      },
    );

  program
    .command('convert')
    .description('Convert a file directly without scanning source directories')
    .argument('<file>', 'Path to session file (.jsonl)')
    .requiredOption('-f, --from <source>', 'Source format: claude, codex')
    .option('-t, --to <target>', 'Target format', 'markdown')
    .option('-m, --mode <mode>', 'Export mode: as-is, compacted', 'as-is')
    .option('-o, --out <dir>', 'Output directory', './export')
    .option('-q, --quiet', 'Suppress progress output')
    .action(
      (file: string, options: { from: string; to: string; mode: string; out: string; quiet?: boolean }) => {
        convertFile(file, options.from, options.to, options.mode as 'as-is' | 'compacted', options.out, options.quiet ?? false);
      },
    );

  program
    .command('inspect')
    .description('Preview a session as markdown in the terminal')
    .argument('<source>', 'Source tool: claude, opencode, codex')
    .argument('<id>', 'Session ID')
    .option('-m, --mode <mode>', 'View mode: as-is, compacted', 'compacted')
    .action(
      (source: string, id: string, options: { mode: string }) => {
        const reader = getReader(source);
        try {
          const session = reader.readSession(id);
          const finalSession = options.mode === 'compacted' ? compactSession(session) : session;
          console.log(
            renderMarkdown(finalSession, { compacted: options.mode === 'compacted' }),
          );
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  program
    .command('import')
    .description('Import a session from one tool into another')
    .argument('<source>', 'Source tool: claude, opencode, codex')
    .argument('<id>', 'Session ID')
    .argument('<target>', 'Target tool: claude, opencode, codex')
    .option('-m, --mode <mode>', 'Import mode: as-is, compacted', 'as-is')
    .action(
      (source: string, id: string, target: string, options: { mode: string }) => {
        importSession(source, id, options.mode as 'as-is' | 'compacted', target);
      },
    );

  program
    .command('plan')
    .description('Export the plan from a session (plan mode) into another tool')
    .argument('<source>', 'Source tool: claude, opencode, codex')
    .argument('<id>', 'Session ID')
    .option('-t, --to <target>', 'Target: opencode, claude, codex, markdown, stdout', 'opencode')
    .option('-a, --all', 'Include every plan revision, not just the final one')
    .option('-o, --out <dir>', 'Output directory (markdown only)', './export')
    .option('-q, --quiet', 'Suppress progress output')
    .action(
      (source: string, id: string, options: { to: string; all?: boolean; out: string; quiet?: boolean }) => {
        exportPlan(source, id, options.to, options.all ?? false, options.out, options.quiet ?? false);
      },
    );

  program
    .command('cleanup')
    .description('Remove orphaned sessions from a tool\'s database (sessions with no event history)')
    .argument('<tool>', 'Tool to clean up: opencode')
    .option('-n, --dry-run', 'List orphans without deleting')
    .action((tool: string, options: { dryRun?: boolean }) => {
      if (tool !== 'opencode') {
        console.error(`Unsupported tool: ${tool}. Only 'opencode' is supported.`);
        process.exit(1);
      }
      const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
      if (!existsSync(dbPath)) {
        console.error(`OpenCode database not found at ${dbPath}.`);
        process.exit(1);
      }
      import('better-sqlite3').then((Database) => {
        const db = new Database.default(dbPath);
        const orphans = db.prepare(
          `SELECT s.id, s.title, s.time_created FROM session s
           WHERE (SELECT COALESCE(MAX(seq), 0) FROM event_sequence es WHERE es.aggregate_id = s.id) = 0
           ORDER BY s.time_created DESC`
        ).all() as { id: string; title: string; time_created: number }[];

        if (orphans.length === 0) {
          console.log('No orphaned sessions found.');
          db.close();
          return;
        }

        console.log(`Found ${orphans.length} orphaned session(s):`);
        for (const o of orphans) {
          const date = new Date(o.time_created).toLocaleString();
          console.log(`  ${o.id.slice(0, 26)}  ${date}  ${o.title}`);
        }

        if (options.dryRun) {
          console.log('\n(Dry run — no deletions performed. Pass --dry-run to list only.)');
          db.close();
          return;
        }

        const ids = orphans.map((o) => o.id);
        const del = db.transaction(() => {
          db.prepare(`DELETE FROM part WHERE session_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
          db.prepare(`DELETE FROM message WHERE session_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
          db.prepare(`DELETE FROM event WHERE aggregate_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
          db.prepare(`DELETE FROM event_sequence WHERE aggregate_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
          db.prepare(`DELETE FROM session WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        });
        del();
        console.log(`\nDeleted ${orphans.length} orphaned session(s).`);
        db.close();
      }).catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      });
    });

  return program;
}
