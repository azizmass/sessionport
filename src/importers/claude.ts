import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import type { SessionIR, MessageIR, PartIR, ToolCallPart, ToolResultPart } from '../ir/types.js';
import type { Importer, ImportResult } from './types.js';
import { claudeSessionId, claudeUuid, claudeProjectSlug } from './ids.js';
import { translateToolCall, toolInput } from './tools.js';

// Claude stamps every event with the branch it was recorded on. A ported
// session did not happen here, but the directory it refers to usually exists,
// so the current branch is the closest honest answer.
function currentBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out && out !== 'HEAD' ? out : undefined;
  } catch {
    return undefined;
  }
}

function isoOr(ts: number | undefined, fallback: string): string {
  if (!ts) return fallback;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

// Claude records the CLI version that wrote each event; a ported session
// claims a recent one so the reader does not treat it as ancient.
const CLAUDE_VERSION = '2.1.250';

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
    const sessionStart = isoOr(session.createdAt, now);

    const gitBranch = currentBranch(cwd);
    const version = CLAUDE_VERSION;

    lines.push(JSON.stringify({ type: 'mode', mode: 'normal', sessionId }));
    lines.push(JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }));
    // Without this Claude labels the resumed session with its first message,
    // which for a ported session is rarely the title it already had.
    if (session.title && session.title.trim()) {
      lines.push(JSON.stringify({ type: 'ai-title', aiTitle: session.title.trim(), sessionId }));
    }

    let prevUuid = '';

    for (const msg of session.messages) {
      if (msg.role === 'system' || msg.role === 'developer') continue;
      if (msg.parts.length === 0) continue;

      const { nonTool, pairs } = pairTools(msg.parts);
      const uuid = claudeUuid();
      msgIds.push(uuid);
      const timestamp = isoOr(msg.timestamp, sessionStart);
      // Claude writes these on every conversation event; omitting them left
      // ported sessions subtly different from native ones.
      const common = {
        sessionId,
        session_id: sessionId,
        timestamp,
        cwd,
        userType: 'external',
        entrypoint: 'cli',
        version,
        isSidechain: false,
        ...(gitBranch ? { gitBranch } : {}),
      };

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
          // Explicit null, not a dropped key: the first message is the root.
          parentUuid: prevUuid || null,
          ...common,
          permissionMode: 'default',
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
          const translated = translateToolCall(pair.call.name, pair.call.input, 'claude');
          contentBlocks.push({
            type: 'tool_use',
            id: pair.call.id,
            name: translated.name,
            input: toolInput(translated.input),
            caller: { type: 'direct' },
          });
        }

        const assistantEvent: Record<string, unknown> = {
          type: 'assistant',
          uuid,
          parentUuid: prevUuid || null,
          ...common,
          message: {
            id: msg.id || uuid,
            type: 'message',
            role: 'assistant',
            content: contentBlocks,
            model: session.model ? `${session.model.provider}/${session.model.id}` : 'unknown',
            usage: {
              input_tokens: msg.tokens?.input || 0,
              output_tokens: msg.tokens?.output || 0,
            },
            stop_reason: pairs.length > 0 ? 'tool_use' : (msg.finishReason || 'end_turn'),
            stop_sequence: null,
          },
        };

        lines.push(JSON.stringify(assistantEvent));
        prevUuid = uuid;

        // Claude carries tool results in the user turn after the call, but
        // OpenCode packs them into the same assistant message. Without this
        // split they were written nowhere and the outputs were lost.
        const results = pairs.filter((p) => p.result);
        if (results.length > 0) {
          const resultUuid = claudeUuid();
          lines.push(
            JSON.stringify({
              type: 'user',
              uuid: resultUuid,
              parentUuid: uuid,
              ...common,
              message: {
                role: 'user',
                content: results.map((p) => ({
                  type: 'tool_result',
                  tool_use_id: p.result!.toolCallId,
                  content: p.result!.content,
                  is_error: p.result!.isError || false,
                })),
              },
            }),
          );
          prevUuid = resultUuid;
        }
      }
    }

    // The leaf Claude continues from when the session is resumed.
    if (prevUuid) {
      lines.push(JSON.stringify({ type: 'last-prompt', leafUuid: prevUuid, sessionId }));
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
