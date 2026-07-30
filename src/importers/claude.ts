import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SessionIR, MessageIR, PartIR, ToolCallPart, ToolResultPart } from '../ir/types.js';
import type { Importer, ImportResult } from './types.js';
import { claudeSessionId, claudeUuid, claudeProjectSlug } from './ids.js';

interface ToolPair {
  call: ToolCallPart;
  result?: ToolResultPart;
}

function pairTools(parts: PartIR[]): { nonTool: PartIR[]; pairs: ToolPair[] } {
  const nonTool: PartIR[] = [];
  const callMap = new Map<string, ToolPair>();
  const pairs: ToolPair[] = [];

  for (const p of parts) {
    if (p.kind === 'tool_call') {
      const pair: ToolPair = { call: p };
      callMap.set(p.id, pair);
      pairs.push(pair);
    } else if (p.kind === 'tool_result') {
      const existing = callMap.get(p.toolCallId);
      if (existing) {
        existing.result = p;
      } else {
        pairs.push({ call: { kind: 'tool_call', id: p.toolCallId, name: 'unknown', input: 'unknown' }, result: p });
      }
    } else {
      nonTool.push(p);
    }
  }

  return { nonTool, pairs };
}

function partToClaudeBlocks(parts: PartIR[]): unknown[] {
  const blocks: unknown[] = [];
  for (const p of parts) {
    switch (p.kind) {
      case 'text':
        blocks.push({ type: 'text', text: p.text });
        break;
      case 'reasoning':
        blocks.push({ type: 'thinking', thinking: p.text });
        break;
    }
  }
  return blocks;
}

export class ClaudeImporter implements Importer {
  readonly target = 'claude';
  private projectsDir: string;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? join(homedir(), '.claude', 'projects');
  }

  importSession(session: SessionIR): ImportResult {
    const projectsDir = this.projectsDir;
    const cwd = session.cwd || process.cwd();

    const slug = claudeProjectSlug(cwd);
    const projectDir = join(projectsDir, slug);

    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    const sessionId = claudeSessionId();
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    const lines: string[] = [];
    const msgIds: string[] = [];
    const now = new Date().toISOString();

    lines.push(JSON.stringify({ type: 'mode', mode: 'normal', sessionId }));
    lines.push(JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }));

    let prevUuid = '';

    for (const msg of session.messages) {
      if (msg.role === 'system' || msg.role === 'developer') continue;
      if (msg.parts.length === 0) continue;

      const { nonTool, pairs } = pairTools(msg.parts);
      const uuid = claudeUuid();
      msgIds.push(uuid);

      if (msg.role === 'user') {
        const contentBlocks: unknown[] = [...partToClaudeBlocks(nonTool)];

        for (const pair of pairs) {
          if (pair.result) {
            contentBlocks.push({
              type: 'tool_result',
              tool_use_id: pair.result.toolCallId,
              content: pair.result.content,
              is_error: pair.result.isError || false,
            });
          }
        }

        const userEvent: Record<string, unknown> = {
          type: 'user',
          uuid,
          parentUuid: prevUuid || undefined,
          sessionId,
          timestamp: now,
          cwd,
          userType: 'external',
          entrypoint: 'cli',
          version: '2.1.220',
        };

        if (contentBlocks.length > 0) {
          userEvent.message = { role: 'user', content: contentBlocks.length === 1 && contentBlocks[0] && typeof (contentBlocks[0] as Record<string, unknown>).type === 'string' && (contentBlocks[0] as Record<string, unknown>).type === 'text'
            ? ((contentBlocks[0] as Record<string, unknown>).text as string)
            : contentBlocks,
          };
        }

        lines.push(JSON.stringify(userEvent));
        prevUuid = uuid;
      }

      if (msg.role === 'assistant') {
        const contentBlocks: unknown[] = [...partToClaudeBlocks(nonTool)];

        for (const pair of pairs) {
          contentBlocks.push({
            type: 'tool_use',
            id: pair.call.id,
            name: pair.call.name,
            input: typeof pair.call.input === 'string' ? pair.call.input : pair.call.input,
            caller: { type: 'direct' },
          });
        }

        const assistantEvent: Record<string, unknown> = {
          type: 'assistant',
          uuid,
          parentUuid: prevUuid || undefined,
          sessionId,
          timestamp: now,
          cwd,
          entrypoint: 'cli',
          message: {
            role: 'assistant',
            content: contentBlocks,
            model: session.model ? `${session.model.provider}/${session.model.id}` : 'unknown',
            usage: {
              input_tokens: msg.tokens?.input || 0,
              output_tokens: msg.tokens?.output || 0,
            },
            stop_reason: pairs.length > 0 ? 'tool_use' : (msg.finishReason || 'end_turn'),
          },
        };

        lines.push(JSON.stringify(assistantEvent));
        prevUuid = uuid;
      }
    }

    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    return {
      target: 'claude',
      sessionId,
      path: filePath,
      messageCount: session.messages.length,
    };
  }
}
