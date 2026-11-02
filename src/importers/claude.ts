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

/**
 * Claude resumes a session on the model recorded in its last assistant message.
 * Native transcripts use a bare id (`claude-opus-5-5`); `provider/id` is rejected
 * as an unknown model, and a model ported from another vendor does not exist
 * here at all — in both cases Claude must fall back to its default.
 */
function claudeModelId(session: SessionIR): string | undefined {
  const id = session.model?.id;
  return id && /^claude-/.test(id) ? id : undefined;
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

/** Tool outputs may live in a different message than the call; index them by id. */
function collectToolResults(session: SessionIR): Map<string, ToolResultPart> {
  const results = new Map<string, ToolResultPart>();
  for (const message of session.messages) {
    for (const part of message.parts) {
      if (part.kind === 'tool_result') results.set(part.toolCallId, part);
    }
  }
  return results;
}

function partToClaudeBlocks(parts: PartIR[]): unknown[] {
  const blocks: unknown[] = [];
  for (const p of parts) {
    // Reasoning is deliberately dropped: Claude only accepts thinking blocks
    // carrying a signature it issued. An imported block has none, and the API
    // rejects the whole conversation if one is present.
    // Whitespace-only text is dropped too: Claude rejects empty text blocks.
    if (p.kind === 'text' && p.text.trim() !== '') {
      blocks.push({ type: 'text', text: p.text });
    }
  }
  return blocks;
}

/**
 * Claude accepts only [A-Za-z0-9_-] in a tool id, while OpenCode's legacy ids
 * look like `read:7`. A colon makes Claude report the conversation as malformed
 * (or leaves the tool result unmatched), so every id is mapped once and reused
 * for both the call and its result.
 */
function toolIdFactory(): (original: string) => string {
  const mapped = new Map<string, string>();
  const used = new Set<string>();
  let counter = 0;

  return (original: string): string => {
    const known = mapped.get(original);
    if (known) return known;

    let candidate = original.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    if (!candidate) candidate = `tool_${++counter}`;
    let suffix = 1;
    while (used.has(candidate)) {
      suffix++;
      candidate = `${candidate.slice(0, 60)}_${suffix}`;
    }

    used.add(candidate);
    mapped.set(original, candidate);
    return candidate;
  };
}

/** A tool result Claude can send: empty output becomes an explicit message. */
function toolResultContent(content: string, isError: boolean | undefined): string {
  if (content.trim()) return content;
  return isError ? 'Tool call failed.' : '(no output)';
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
    const messageModel = claudeModelId(session);

    lines.push(JSON.stringify({ type: 'mode', mode: 'normal', sessionId }));
    lines.push(JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }));
    // Without this Claude labels the resumed session with its first message,
    // which for a ported session is rarely the title it already had.
    if (session.title && session.title.trim()) {
      lines.push(JSON.stringify({ type: 'ai-title', aiTitle: session.title.trim(), sessionId }));
    }

    let prevUuid = '';
    const claudeToolId = toolIdFactory();
    const allToolResults = collectToolResults(session);
    // A result that already has its own user turn will be written there; don't
    // also write a second one right after the assistant call.
    const resultsInUserMessages = new Set(
      session.messages
        .filter((message) => message.role === 'user')
        .flatMap((message) =>
          message.parts
            .filter((part): part is ToolResultPart => part.kind === 'tool_result')
            .map((part) => part.toolCallId),
        ),
    );

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
        const toolResults: { id: string; content: string; isError: boolean }[] = [];

        for (const pair of pairs) {
          if (pair.result) {
            const result = {
              id: claudeToolId(pair.result.toolCallId),
              content: toolResultContent(pair.result.content, pair.result.isError),
              isError: pair.result.isError || false,
            };
            toolResults.push(result);
            contentBlocks.push({
              type: 'tool_result',
              tool_use_id: result.id,
              content: result.content,
              is_error: result.isError,
            });
          }
        }

        if (contentBlocks.length === 0) continue;

        const userEvent: Record<string, unknown> = {
          type: 'user',
          uuid,
          // Explicit null, not a dropped key: the first message is the root.
          parentUuid: prevUuid || null,
          ...common,
          permissionMode: 'default',
          message: {
            role: 'user',
            content: contentBlocks.length === 1 && contentBlocks[0] && typeof (contentBlocks[0] as Record<string, unknown>).type === 'string' && (contentBlocks[0] as Record<string, unknown>).type === 'text'
              ? ((contentBlocks[0] as Record<string, unknown>).text as string)
              : contentBlocks,
          },
        };

        // A single tool result is the shape Claude writes when it executes a
        // tool itself; `toolUseResult` is what its transcript reader keys on.
        if (toolResults.length === 1) {
          userEvent.toolUseResult = toolResults[0].content;
          if (prevUuid) userEvent.sourceToolAssistantUUID = prevUuid;
        }

        lines.push(JSON.stringify(userEvent));
        prevUuid = uuid;
      }

      if (msg.role === 'assistant') {
        const contentBlocks: unknown[] = [...partToClaudeBlocks(nonTool)];
        const toolResults: { id: string; content: string; isError: boolean }[] = [];

        for (const pair of pairs) {
          const translated = translateToolCall(pair.call.name, pair.call.input, 'claude');
          const id = claudeToolId(pair.call.id);
          contentBlocks.push({
            type: 'tool_use',
            id,
            name: translated.name,
            input: toolInput(translated.input),
            caller: { type: 'direct' },
          });

          // Every tool_use must be answered by a tool_result in the next user
          // turn. OpenCode leaves interrupted calls without one, and Claude
          // then reads the following turn as malformed.
          if (pair.result) {
            toolResults.push({
              id,
              content: toolResultContent(pair.result.content, pair.result.isError),
              isError: pair.result.isError || false,
            });
          } else if (!resultsInUserMessages.has(pair.call.id)) {
            const elsewhere = allToolResults.get(pair.call.id);
            toolResults.push(
              elsewhere
                ? {
                    id,
                    content: toolResultContent(elsewhere.content, elsewhere.isError),
                    isError: elsewhere.isError || false,
                  }
                : {
                    id,
                    content: 'No tool output captured (imported session).',
                    isError: true,
                  },
            );
          }
        }

        if (contentBlocks.length === 0) continue;

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
            ...(messageModel ? { model: messageModel } : {}),
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
        if (toolResults.length > 0) {
          const resultUuid = claudeUuid();
          const resultTimestamp = isoOr(
            msg.timestamp ? msg.timestamp + 1 : new Date(sessionStart).getTime() + 1,
            sessionStart,
          );
          const resultEvent: Record<string, unknown> = {
            type: 'user',
            uuid: resultUuid,
            parentUuid: uuid,
            ...common,
            timestamp: resultTimestamp,
            message: {
              role: 'user',
              content: toolResults.map((result) => ({
                type: 'tool_result',
                tool_use_id: result.id,
                content: result.content,
                is_error: result.isError,
              })),
            },
          };

          if (toolResults.length === 1) {
            resultEvent.toolUseResult = toolResults[0].content;
            resultEvent.sourceToolAssistantUUID = uuid;
          }

          lines.push(JSON.stringify(resultEvent));
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
