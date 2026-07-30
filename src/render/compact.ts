import type { SessionIR, MessageIR, PartIR, CompactOptions, ToolCallPart, ToolResultPart } from '../ir/types.js';

export function compactSession(session: SessionIR, options?: CompactOptions): SessionIR {
  const opts: Required<CompactOptions> = {
    reasoningMaxChars: options?.reasoningMaxChars ?? 300,
    includeSystem: options?.includeSystem ?? false,
    includeToolOutput: options?.includeToolOutput ?? false,
    toolOutputTruncate: options?.toolOutputTruncate ?? 200,
  };

  const messages: MessageIR[] = [];

  for (const msg of session.messages) {
    if (!opts.includeSystem && (msg.role === 'system' || msg.role === 'developer')) continue;

    const parts: PartIR[] = [];

    for (const part of msg.parts) {
      switch (part.kind) {
        case 'text':
          parts.push(part);
          break;

        case 'reasoning': {
          const text =
            part.text.length > opts.reasoningMaxChars
              ? part.text.slice(0, opts.reasoningMaxChars) +
                `\n\n*[reasoning truncated: ${part.text.length} chars → ${opts.reasoningMaxChars}]*`
              : part.text;
          parts.push({ kind: 'reasoning', text, summary: part.summary });
          break;
        }

        case 'tool_call': {
          const t = part as ToolCallPart;
          parts.push({
            kind: 'tool_call',
            id: t.id,
            name: t.name,
            input: summarizeToolInput(t.name, t.input),
          });
          break;
        }

        case 'tool_result': {
          const t = part as ToolResultPart;
          if (opts.includeToolOutput) {
            const truncated = t.content.length > opts.toolOutputTruncate;
            parts.push({
              ...t,
              content: t.content.slice(0, opts.toolOutputTruncate) +
                (truncated
                  ? `\n\n*[output truncated: ${t.content.length} chars]*`
                  : ''),
              truncated: truncated || t.truncated,
            });
          } else {
            const lineCount = t.content.split('\n').length;
            const sizeLabel = t.content.length > 1000
              ? `${(t.content.length / 1024).toFixed(1)} KB`
              : `${lineCount} lines`;
            parts.push({
              kind: 'tool_result',
              toolCallId: t.toolCallId,
              content: `[${sizeLabel}${t.isError ? ', error' : ', ok'}]`,
              isError: t.isError,
            });
          }
          break;
        }

        case 'file':
        case 'agent':
          parts.push(part);
          break;

        case 'meta':
          break;
      }
    }

    if (parts.length > 0) {
      messages.push({ ...msg, parts });
    }
  }

  return { ...session, messages };
}

function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input === 'string') {
    return input.length > 100 ? input.slice(0, 100) + '...' : input;
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (name === 'Bash' || name === 'exec' || name === 'exec_command') {
      return (obj.command as string) ?? (obj.cmd as string) ?? JSON.stringify(input);
    }
    if (name === 'Read' || name === 'read') {
      return (obj.file_path as string) ?? (obj.path as string) ?? JSON.stringify(input);
    }
    if (name === 'Edit' || name === 'edit' || name === 'Write' || name === 'write') {
      const path = (obj.file_path as string) ?? (obj.path as string) ?? '';
      return path.length > 0 ? `edit ${path}` : JSON.stringify(input);
    }
    if (name === 'WebFetch' || name === 'fetch' || name === 'web_fetch') {
      return (obj.url as string) ?? JSON.stringify(input);
    }
    const str = JSON.stringify(input);
    return str.length > 120 ? str.slice(0, 120) + '...' : str;
  }
  return String(input);
}
