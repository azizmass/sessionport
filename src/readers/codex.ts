import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { StringDecoder } from 'string_decoder';
import { join } from 'path';
import type { SourceTool, ModelInfo, MessageIR, PartIR, SessionIR } from '../ir/types.js';
import type { Reader, SessionSummary } from './types.js';
import { codexDir, codexIndexPath } from '../paths.js';
import { cleanTitle, displayTitle, UNTITLED } from '../ir/normalize.js';

interface CodexIndexEntry {
  id: string;
  thread_name?: string;
  updated_at: string;
}

interface CodexEvent {
  type: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    role?: string;
    content?: { type: string; text: string; summary?: string }[];
    session_id?: string;
    cwd?: string;
    model_provider?: string;
    base_instructions?: { text: string };
    originator?: string;
    cli_version?: string;
    call_id?: string;
    name?: string;
    input?: string;
    output?: { type: string; text: string }[] | string;
    status?: string;
    turn_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Codex writes a tool's output either as a list of content blocks or, for a shell
 * command that produced plain text, as a bare string. Assuming the list shape threw
 * on the string one and took the whole session read down with it.
 */
function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((o) => (typeof o === 'string' ? o : ((o as { text?: string })?.text ?? '')))
      .join('\n');
  }
  return '';
}

function findRolloutFile(sessionId: string, root: string): string | undefined {
  const sessionsDir = join(root, 'sessions');
  if (!existsSync(sessionsDir)) return undefined;

  const years = readdirSync(sessionsDir);
  for (const year of years) {
    const yearDir = join(sessionsDir, year);
    if (!statSync(yearDir).isDirectory()) continue;
    const months = readdirSync(yearDir);
    for (const month of months) {
      const monthDir = join(yearDir, month);
      if (!statSync(monthDir).isDirectory()) continue;
      const days = readdirSync(monthDir);
      for (const day of days) {
        const dayDir = join(monthDir, day);
        if (!statSync(dayDir).isDirectory()) continue;
        const files = readdirSync(dayDir);
        for (const file of files) {
          if (file.includes(sessionId)) return join(dayDir, file);
        }
      }
    }
  }
  return undefined;
}

/**
 * Yields a JSONL file one line at a time. A Codex rollout can be hundreds of
 * megabytes; reading it whole and splitting it held several copies of the file
 * in memory at once. StringDecoder keeps a multi-byte character that straddles
 * a chunk boundary intact.
 */
function* readJsonlLines(filePath: string): Generator<string> {
  const READ_CHUNK = 1 << 20;
  const fd = openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(READ_CHUNK);
  try {
    let rest = '';
    for (;;) {
      const read = readSync(fd, buffer, 0, READ_CHUNK, null);
      if (read === 0) break;
      rest += decoder.write(buffer.subarray(0, read));

      let newline = rest.indexOf('\n');
      while (newline !== -1) {
        yield rest.slice(0, newline);
        rest = rest.slice(newline + 1);
        newline = rest.indexOf('\n');
      }
    }
    rest += decoder.end();
    if (rest) yield rest;
  } finally {
    closeSync(fd);
  }
}

/**
 * One damaged line used to abort the whole import, so the reader skips it and
 * says what it skipped instead.
 */
function warnSkippedLines(filePath: string, skipped: number, firstLine: number): void {
  if (skipped === 0) return;
  const lines = skipped === 1 ? 'line' : 'lines';
  console.warn(`Warning: skipped ${skipped} malformed ${lines} in ${filePath} (first at line ${firstLine})`);
}

function parseCodexJsonl(filePath: string, threadName?: string): SessionIR {
  let sessionId = '';
  let cwd = '';
  let modelProvider = '';
  let systemPrompt = '';

  let skipped = 0;
  let firstSkippedLine = 0;
  let lineNumber = 0;

  const messages: MessageIR[] = [];
  const pendingReasoning: PartIR[] = [];
  let currentCallId = '';
  let currentCallName = '';

  for (const line of readJsonlLines(filePath)) {
    lineNumber++;
    if (!line.trim()) continue;

    let e: CodexEvent;
    try {
      e = JSON.parse(line) as CodexEvent;
    } catch {
      skipped++;
      if (firstSkippedLine === 0) firstSkippedLine = lineNumber;
      continue;
    }

    if (e.type === 'session_meta' && e.payload) {
      sessionId = e.payload.session_id ?? sessionId;
      cwd = e.payload.cwd ?? cwd;
      modelProvider = e.payload.model_provider ?? modelProvider;
      systemPrompt = e.payload.base_instructions?.text ?? '';
    }

    if (e.type === 'turn_context') {
      continue;
    }

    if (e.type === 'response_item') {
      const p = e.payload;
      if (!p) continue;

      if (p.type === 'reasoning') {
        const text = p.content
          ?.map((c: { text?: string }) => c.text ?? '')
          .join('\n');
        if (text) {
          pendingReasoning.push({ kind: 'reasoning', text, summary: text.slice(0, 200) } as PartIR);
        }
      }

      if (p.type === 'message' && p.role) {
        const parts: PartIR[] = [...pendingReasoning];
        pendingReasoning.length = 0;

        if (p.content) {
          for (const c of p.content) {
            if (c.type === 'input_text' || c.type === 'output_text') {
              parts.push({ kind: 'text', text: c.text } as PartIR);
            }
          }
        }

        const role = p.role === 'developer' ? ('system' as const) : (p.role as MessageIR['role']);
        const timestamp = e.timestamp ? new Date(e.timestamp).getTime() : Date.now();

        messages.push({
          id: p.id ?? `msg_${timestamp}`,
          role,
          timestamp,
          parts: parts.length > 0 ? parts : [{ kind: 'text', text: '' }],
        });
      }

      if (p.type === 'custom_tool_call') {
        if (p.call_id) currentCallId = p.call_id;
        if (p.name) currentCallName = p.name;

        const toolPart: PartIR = {
          kind: 'tool_call',
          id: p.call_id ?? `call_${Date.now()}`,
          name: p.name ?? 'unknown',
          input: p.input ?? {},
        };

        const timestamp = e.timestamp ? new Date(e.timestamp).getTime() : Date.now();
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.parts.push(toolPart);
        } else {
          messages.push({
            id: `msg_assistant_${timestamp}`,
            role: 'assistant',
            timestamp,
            parts: [toolPart],
          });
        }
      }

      if (p.type === 'custom_tool_call_output') {
        const outputText = toolOutputText(p.output);

        const resultPart: PartIR = {
          kind: 'tool_result',
          toolCallId: p.call_id ?? currentCallId,
          content: outputText,
        };

        const timestamp = e.timestamp ? new Date(e.timestamp).getTime() : Date.now();
        messages.push({
          id: `msg_user_${timestamp}`,
          role: 'user',
          timestamp,
          parts: [resultPart],
        });
      }
    }
  }

  warnSkippedLines(filePath, skipped, firstSkippedLine);

  const model: ModelInfo | undefined = modelProvider
    ? { provider: modelProvider === 'openai' ? 'openai' : modelProvider, id: modelProvider }
    : undefined;

  const titleFromEvents = (() => {
    for (const m of messages) {
      if (m.role === 'user') {
        for (const p of m.parts) {
          if (p.kind === 'text') {
            const c = cleanTitle(p.text);
            if (c !== UNTITLED) return c;
          }
        }
      }
    }
    return UNTITLED;
  })();

  const lastMessage = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const p of messages[i].parts) {
        if (p.kind === 'text' && p.text.trim()) {
          const c = cleanTitle(p.text);
          if (c !== UNTITLED) return c;
        }
      }
    }
    return undefined;
  })();

  const timestamps = messages
    .map((m) => m.timestamp)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);

  return {
    id: sessionId,
    sourceTool: 'codex' as SourceTool,
    sourcePath: filePath,
    title: displayTitle({
      // The name Codex gave the thread beats anything guessed from the transcript.
      title: threadName || titleFromEvents,
      lastMessage,
      updatedAt: timestamps[timestamps.length - 1],
      createdAt: timestamps[0],
    }),
    cwd: cwd || undefined,
    model,
    createdAt: timestamps[0] ?? Date.now(),
    updatedAt: Date.now(),
    messages,
    metadata: systemPrompt ? { systemPrompt: systemPrompt.slice(0, 500) } : undefined,
  };
}

export class CodexReader implements Reader {
  readonly tool = 'codex';

  private codexRoot: string;

  constructor(codexRoot?: string) {
    this.codexRoot = codexRoot ?? codexDir();
  }

  listSessions(): SessionSummary[] {
    const results: SessionSummary[] = [];
    const indexPath = join(this.codexRoot, 'session_index.jsonl');

    if (!existsSync(indexPath)) return results;

    let content: string;
    try {
      content = readFileSync(indexPath, 'utf-8');
    } catch {
      return results;
    }

    let skipped = 0;
    let firstSkippedLine = 0;
    let lineNumber = 0;
    for (const line of content.split('\n')) {
      lineNumber++;
      if (!line.trim()) continue;
      try {
        const entry: CodexIndexEntry = JSON.parse(line);
        results.push({
          id: entry.id,
          title: entry.thread_name ?? '',
          tool: 'codex',
          createdAt: new Date(entry.updated_at).getTime(),
          updatedAt: new Date(entry.updated_at).getTime(),
          path: join(this.codexRoot, 'sessions'),
        });
      } catch {
        skipped++;
        if (firstSkippedLine === 0) firstSkippedLine = lineNumber;
      }
    }
    warnSkippedLines(indexPath, skipped, firstSkippedLine);

    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
  }

  readSession(id: string): SessionIR {
    const rolloutPath = findRolloutFile(id, this.codexRoot);
    if (!rolloutPath) {
      throw new Error(`Codex session not found: ${id}`);
    }
    return parseCodexJsonl(rolloutPath, this.threadName(id));
  }

  readFromFile(filePath: string): SessionIR {
    return parseCodexJsonl(filePath);
  }

  /**
   * A Codex thread's name lives in the index, not in the rollout file, so reading a
   * session by id has to go and fetch it. Without it a ported session is titled by
   * whatever its opening message happened to say.
   */
  private threadName(id: string): string | undefined {
    return this.listSessions().find((s) => s.id === id)?.title || undefined;
  }
}
