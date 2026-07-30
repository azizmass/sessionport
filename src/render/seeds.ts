import type { SessionIR } from '../ir/types.js';
import { compactSession } from './compact.js';
import { renderMarkdown } from './markdown.js';

export type SeedTarget = 'opencode' | 'claude' | 'codex' | 'generic';

function seedHeader(session: SessionIR, target: SeedTarget): string[] {
  const lines: string[] = [];
  lines.push('# Session Context Handoff');
  lines.push('');
  lines.push(`This context was exported from **${session.sourceTool}** to seed a **${target}** session.`);
  lines.push('');
  if (session.model) {
    lines.push(`- **Original model:** ${session.model.provider}/${session.model.id}${session.model.variant ? ` (${session.model.variant})` : ''}`);
  }
  lines.push(`- **Original session:** ${session.title}`);
  if (session.cwd) lines.push(`- **Working directory:** \`${session.cwd}\``);
  lines.push(`- **Exported:** ${new Date().toISOString()}`);
  lines.push('');
  return lines;
}

function opencodeSeed(session: SessionIR): string {
  const compacted = compactSession(session);
  const h = seedHeader(session, 'opencode');
  const body = renderMarkdown(compacted, { compacted: true, includeSystem: false });
  return [
    ...h,
    '> Paste this into your first OpenCode prompt to continue the previous session\'s context.',
    '',
    '---',
    '',
    body,
  ].join('\n');
}

function claudeSeed(session: SessionIR): string {
  const compacted = compactSession(session);
  const h = seedHeader(session, 'claude');
  const body = renderMarkdown(compacted, { compacted: true, includeSystem: false });
  return [
    ...h,
    '> Paste this as your first message in a new Claude Code session to continue from where you left off.',
    '',
    '---',
    '',
    body,
  ].join('\n');
}

function codexSeed(session: SessionIR): string {
  const compacted = compactSession(session);
  const h = seedHeader(session, 'codex');
  const body = renderMarkdown(compacted, { compacted: true, includeSystem: false });
  return [
    ...h,
    '> Paste this as your first prompt in a new Codex session to continue from where you left off.',
    '',
    '---',
    '',
    body,
  ].join('\n');
}

function genericSeed(session: SessionIR): string {
  const compacted = compactSession(session);
  const h = seedHeader(session, 'generic');
  const body = renderMarkdown(compacted, { compacted: true, includeSystem: false });
  return [
    ...h,
    '> This compacted transcript can be pasted into any AI coding tool to provide context from a prior session.',
    '',
    '---',
    '',
    body,
  ].join('\n');
}

export function renderSeed(session: SessionIR, target: SeedTarget): string {
  switch (target) {
    case 'opencode': return opencodeSeed(session);
    case 'claude': return claudeSeed(session);
    case 'codex': return codexSeed(session);
    case 'generic': return genericSeed(session);
  }
}
