import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import type { SourceTool, ModelInfo, MessageIR, PartIR, SessionIR } from '../ir/types.js';
import type { Reader, SessionSummary } from './types.js';
import { codexDir, codexIndexPath } from '../paths.js';
import { cleanTitle } from '../ir/normalize.js';

interface CodexIndexEntry {
  id: string;
  thread_name: string;
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
    output?: { type: string; text: string }[];
    status?: string;
    turn_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
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

function parseCodexJsonl(filePath: string, content: string): SessionIR {
  const lines = content.split('\n').filter(Boolean);
  const events: CodexEvent[] = lines.map((l) => JSON.parse(l));

  let sessionId = '';
  let cwd = '';
  let modelProvider = '';
  let systemPrompt = '';

  for (const e of events) {
    if (e.type === 'session_meta' && e.payload) {
      sessionId = e.payload.session_id ?? sessionId;
      cwd = e.payload.cwd ?? cwd;
      modelProvider = e.payload.model_provider ?? modelProvider;
      systemPrompt = e.payload.base_instructions?.text ?? '';
    }
  }

  const messages: MessageIR[] = [];
  const pendingReasoning: PartIR[] = [];
  let currentCallId = '';
  let currentCallName = '';

  for (const e of events) {
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
        const outputText =
          p.output
            ?.map((o: { text?: string }) => o.text ?? '')
            .join('\n') ?? '';

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

  const model: ModelInfo | undefined = modelProvider
    ? { provider: modelProvider === 'openai' ? 'openai' : modelProvider, id: modelProvider }
    : undefined;

  const titleFromEvents = (() => {
    for (const m of messages) {
      if (m.role === 'user') {
        for (const p of m.parts) {
          if (p.kind === 'text') {
            const c = cleanTitle(p.text);
            if (c !== 'Untitled Session') return c;
          }
        }
      }
    }
    return 'Untitled Codex Session';
  })();

  const timestamps = messages
    .map((m) => m.timestamp)
    .filter((t) => t > 0)
    .sort();

  return {
    id: sessionId,
    sourceTool: 'codex' as SourceTool,
    sourcePath: filePath,
    title: titleFromEvents,
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

    try {
      const content = readFileSync(indexPath, 'utf-8');
      for (const line of content.split('\n').filter(Boolean)) {
        const entry: CodexIndexEntry = JSON.parse(line);
        results.push({
          id: entry.id,
          title: entry.thread_name,
          tool: 'codex',
          createdAt: new Date(entry.updated_at).getTime(),
          updatedAt: new Date(entry.updated_at).getTime(),
          path: join(this.codexRoot, 'sessions'),
        });
      }
    } catch {
      // ignore
    }

    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
  }

  readSession(id: string): SessionIR {
    const rolloutPath = findRolloutFile(id, this.codexRoot);
    if (!rolloutPath) {
      throw new Error(`Codex session not found: ${id}`);
    }
    return this.readFromFile(rolloutPath);
  }

  readFromFile(filePath: string): SessionIR {
    const content = readFileSync(filePath, 'utf-8');
    return parseCodexJsonl(filePath, content);
  }
}
