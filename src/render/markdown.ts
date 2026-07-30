import type { SessionIR, MessageIR, PartIR, ToolCallPart, ToolResultPart } from '../ir/types.js';

export interface MarkdownOptions {
  compacted?: boolean;
  includeSystem?: boolean;
}

export function renderMarkdown(session: SessionIR, options?: MarkdownOptions): string {
  const lines: string[] = [];

  lines.push(`# ${session.title}`);
  lines.push('');

  lines.push(`**Session:** \`${session.id}\``);
  lines.push(`**Source:** \`${session.sourceTool}\``);
  if (session.model) {
    lines.push(`**Model:** ${session.model.provider}/${session.model.id}${session.model.variant ? ` (${session.model.variant})` : ''}`);
  }
  if (session.cwd) {
    lines.push(`**CWD:** \`${session.cwd}\``);
  }
  lines.push(`**Messages:** ${session.messages.length}`);
  if (options?.compacted) {
    lines.push(`**Mode:** compacted`);
  }
  lines.push('');

  const separator = `---\n`;

  for (const msg of session.messages) {
    if (!options?.includeSystem && (msg.role === 'system' || msg.role === 'developer')) continue;
    if (msg.parts.length === 0) continue;

    lines.push(separator);

    const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : '';
    lines.push(`## ${msg.role}${timestamp ? ` — ${timestamp}` : ''}`);
    if (msg.model) {
      lines.push(`*model: ${msg.model.provider}/${msg.model.id}*`);
    }
    lines.push('');

    for (const part of msg.parts) {
      lines.push(...renderPart(part, options));
      lines.push('');
    }
  }

  return lines.join('\n');
}

function renderPart(part: PartIR, options?: MarkdownOptions): string[] {
  switch (part.kind) {
    case 'text':
      return [part.text];

    case 'reasoning': {
      const header = '> 💭 *reasoning*';
      if (options?.compacted) {
        const summary = part.summary || part.text.slice(0, 200) + (part.text.length > 200 ? '…' : '');
        return [header, '', '> ' + summary.replace(/\n/g, '\n> ')];
      }
      return [header, '', part.text];
    }

    case 'tool_call': {
      const t = part as ToolCallPart;
      const inputRaw = typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2);
      const header = `**Tool:** \`${t.name}\``;
      if (options?.compacted) {
        const inputLine = inputRaw.length > 120 ? inputRaw.slice(0, 120) + '…' : inputRaw;
        return [`> 🔧 ${header} — \`${inputLine.replace(/^"|"$/g, '')}\``];
      }
      const inputStr = typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2);
      return [header, '', '```', inputStr, '```'];
    }

    case 'tool_result': {
      const t = part as ToolResultPart;
      const status = t.isError ? '❌ error' : '✅ ok';
      if (options?.compacted) {
        return [`> 📋 *tool result (${t.toolCallId.slice(0, 12)}):* ${t.content.slice(0, 200)}`];
      }
      const truncated = t.truncated ? '\n\n*[truncated]*' : '';
      return [`**Tool Result** ${status}`, '', '```', t.content.slice(0, 5000), '```' + truncated];
    }

    case 'file':
      return [`**File:** \`${part.path}\``];

    case 'agent':
      return [`**Agent:** \`${part.name}\``];

    case 'meta':
      return [];
  }
}
