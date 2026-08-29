import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { SourceTool, ModelInfo, TokenUsage, MessageIR, PartIR, SessionIR } from '../ir/types.js';
import type { Reader, SessionSummary } from './types.js';
import { claudeProjectsDir } from '../paths.js';
import {
  cleanTitle as normalize_cleanTitle,
  displayTitle,
  extractText,
  isPlaceholderTitle,
  UNTITLED,
} from '../ir/normalize.js';

interface ClaudeEvent {
  type: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | ClaudeContentBlock[];
    model?: string;
    id?: string;
    usage?: { input_tokens: number; output_tokens: number };
    stop_reason?: string;
  };
  cwd?: string;
  version?: string;
  gitBranch?: string;
  userType?: string;
  entrypoint?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  content?: string;
  [key: string]: unknown;
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  tool_use_id?: string;
  is_error?: boolean;
  caller?: { type: string };
  signatures?: string[];
  thinking?: string;
}

/** How many lines to scan from each end of a session file when summarising it. */
const SCAN_LINES = 400;

function parseTimestamp(ts: string): number {
  return new Date(ts).getTime();
}

function parseModel(modelStr?: string): ModelInfo | undefined {
  if (!modelStr) return undefined;
  return { provider: 'anthropic', id: modelStr };
}

function parseTokens(usage?: {
  input_tokens?: number;
  output_tokens?: number;
}): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
  };
}

function contentBlockToPart(block: ClaudeContentBlock): PartIR | null {
  switch (block.type) {
    case 'text':
      return { kind: 'text', text: block.text ?? '' };
    case 'thinking':
      return { kind: 'reasoning', text: block.thinking ?? '' };
    case 'tool_use':
      return {
        kind: 'tool_call',
        id: block.id ?? `tool_${Date.now()}`,
        name: block.name ?? 'unknown',
        input: block.input ?? {},
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        toolCallId: block.tool_use_id ?? '',
        content:
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content),
        isError: block.is_error,
      };
    default:
      return null;
  }
}

function extractTitle(events: ClaudeEvent[]): string {
  for (const e of events) {
    if (e.type === 'user' && !e.isMeta && e.message) {
      const cleaned = normalize_cleanTitle(extractText(e.message.content));
      if (cleaned !== UNTITLED) return cleaned;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'last-prompt' && typeof e.content === 'string') {
      const cleaned = normalize_cleanTitle(e.content);
      if (cleaned !== UNTITLED) return cleaned;
    }
  }
  return UNTITLED;
}

/** Last human-readable message in the session, newest first. */
function extractLastMessage(events: ClaudeEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'last-prompt' && typeof e.content === 'string') {
      const cleaned = normalize_cleanTitle(e.content);
      if (cleaned !== UNTITLED) return cleaned;
    }
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta || !e.message) continue;
    const cleaned = normalize_cleanTitle(extractText(e.message.content));
    if (cleaned !== UNTITLED) return cleaned;
  }
  return undefined;
}

function parseJsonlLines(lines: string[]): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as ClaudeEvent);
    } catch {
      // skip truncated or malformed lines rather than losing the whole session
    }
  }
  return events;
}

function parseClaudeEvents(filePath: string, content: string): SessionIR {
  const lines = content.split('\n').filter(Boolean);
  const events: ClaudeEvent[] = parseJsonlLines(lines);

  const messages: MessageIR[] = [];
  let sessionId = '';
  let cwd = '';
  let model: ModelInfo | undefined;

  for (const e of events) {
    if (e.sessionId) sessionId = e.sessionId;
    if (e.cwd) cwd = e.cwd;
    if (e.type === 'mode' || e.type === 'permission-mode') continue;

    if (e.type === 'user' && e.message) {
      if (e.isMeta) continue;

      const parts: PartIR[] = [];
      const contentBlock = e.message.content;

      if (typeof contentBlock === 'string') {
        parts.push({ kind: 'text', text: contentBlock });
      } else if (Array.isArray(contentBlock)) {
        for (const block of contentBlock) {
          const part = contentBlockToPart(block);
          if (part) parts.push(part);
        }
      }

      if (parts.length === 0) continue;

      messages.push({
        id: e.uuid ?? `user_${e.timestamp ?? Date.now()}`,
        parentId: e.parentUuid,
        role: 'user',
        timestamp: e.timestamp ? parseTimestamp(e.timestamp) : Date.now(),
        parts,
      });
    }

    if (e.type === 'assistant' && e.message) {
      const parts: PartIR[] = [];
      const contentBlock = e.message.content;

      if (Array.isArray(contentBlock)) {
        for (const block of contentBlock) {
          const part = contentBlockToPart(block);
          if (part) parts.push(part);
        }
      } else if (typeof contentBlock === 'string') {
        parts.push({ kind: 'text', text: contentBlock });
      }

      if (!model && e.message.model) {
        model = parseModel(e.message.model);
      }

      messages.push({
        id: e.uuid ?? `assistant_${e.timestamp ?? Date.now()}`,
        parentId: e.parentUuid,
        role: 'assistant',
        timestamp: e.timestamp ? parseTimestamp(e.timestamp) : Date.now(),
        model: e.message.model ? parseModel(e.message.model) : undefined,
        tokens: e.message.usage ? parseTokens(e.message.usage) : undefined,
        finishReason: e.message.stop_reason,
        parts,
      });
    }
  }

  const timestamps = messages
    .map((m) => m.timestamp)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  const updatedAt = Date.now();
  const title = displayTitle({
    title: extractTitle(events),
    lastMessage: extractLastMessage(events),
    updatedAt: timestamps[timestamps.length - 1] ?? updatedAt,
    createdAt: timestamps[0],
  });

  return {
    id: sessionId,
    sourceTool: 'claude' as SourceTool,
    sourcePath: filePath,
    title,
    cwd: cwd || undefined,
    model,
    createdAt: timestamps[0] ?? Date.now(),
    updatedAt,
    messages,
  };
}

export class ClaudeReader implements Reader {
  readonly tool = 'claude';

  private projectsDir: string;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? claudeProjectsDir();
  }

  listSessions(): SessionSummary[] {
    const results: SessionSummary[] = [];
    let projects: string[];
    try {
      projects = readdirSync(this.projectsDir);
    } catch {
      return results;
    }

    for (const project of projects) {
      const projectDir = join(this.projectsDir, project);
      let entries: string[];
      try {
        entries = readdirSync(projectDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const filePath = join(projectDir, entry);
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;

        const sessionId = entry.replace(/\.jsonl$/, '');
        try {
          const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
          // The opening events are usually meta noise (/clear, caveats, hooks),
          // so scan well past them for the first real prompt, and scan the tail
          // for a fallback when the session never had a titleable message.
          const head = parseJsonlLines(lines.slice(0, SCAN_LINES));
          const tail =
            lines.length > SCAN_LINES
              ? parseJsonlLines(lines.slice(-SCAN_LINES))
              : head;
          const title = extractTitle(head);
          const lastMessage = extractLastMessage(tail) ?? extractLastMessage(head);
          const model =
            tail.find((e) => e.message?.model)?.message?.model ??
            head.find((e) => e.message?.model)?.message?.model;

          let createdAt = stat.mtimeMs;
          for (const e of head) {
            if (e.timestamp) {
              const ts = parseTimestamp(e.timestamp);
              if (ts && ts < createdAt) createdAt = ts;
            }
          }

          results.push({
            id: sessionId,
            title,
            tool: 'claude',
            createdAt,
            updatedAt: stat.mtimeMs,
            model,
            path: filePath,
            lastMessage,
          });
        } catch {
          // skip unparseable files
        }
      }
    }

    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
  }

  readSession(id: string): SessionIR {
    const projects = readdirSync(this.projectsDir);
    let filePath = '';

    for (const project of projects) {
      const candidate = join(this.projectsDir, project, `${id}.jsonl`);
      try {
        if (statSync(candidate).isFile()) {
          filePath = candidate;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!filePath) {
      throw new Error(`Claude session not found: ${id}`);
    }

    return this.readFromFile(filePath);
  }

  readFromFile(filePath: string): SessionIR {
    const content = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);
    const session = parseClaudeEvents(filePath, content);
    session.createdAt = stat.mtimeMs;
    session.updatedAt = stat.mtimeMs;
    return session;
  }
}
