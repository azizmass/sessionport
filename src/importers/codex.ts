import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SessionIR, MessageIR, PartIR, ToolCallPart, ToolResultPart } from '../ir/types.js';
import type { Importer, ImportResult } from './types.js';
import { codexSessionId, codexTurnId, codexCallId, codexToolCallId, claudeUuid } from './ids.js';

interface ToolPair {
  call: ToolCallPart;
  result?: ToolResultPart;
}

/**
 * A tool's result does not always sit in the message that made the call — Claude Code
 * puts it in the following user turn — so results are gathered across the whole
 * session first and matched to their call by id.
 */
function collectToolResults(session: SessionIR): Map<string, ToolResultPart> {
  const results = new Map<string, ToolResultPart>();
  for (const msg of session.messages) {
    for (const part of msg.parts) {
      if (part.kind === 'tool_result') results.set(part.toolCallId, part);
    }
  }
  return results;
}

function pairTools(parts: PartIR[], toolResults: Map<string, ToolResultPart>): { nonTool: PartIR[]; pairs: ToolPair[] } {
  const nonTool: PartIR[] = [];
  const pairs: ToolPair[] = [];

  for (const p of parts) {
    if (p.kind === 'tool_call') {
      pairs.push({ call: p, result: toolResults.get(p.id) });
    } else if (p.kind === 'tool_result') {
      // Already emitted alongside its call. Pairing per message instead of per
      // session used to write it a second time as a call named 'unknown', which
      // doubled every tool call in a ported Claude session.
      continue;
    } else {
      nonTool.push(p);
    }
  }

  return { nonTool, pairs };
}

export class CodexImporter implements Importer {
  readonly target = 'codex';
  private codexRoot: string;

  constructor(codexRoot?: string) {
    this.codexRoot = codexRoot ?? join(homedir(), '.codex');
  }

  importSession(session: SessionIR): ImportResult {
    const codexRoot = this.codexRoot;
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const sessionsDir = join(codexRoot, 'sessions', String(y), m, d);

    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    const sessionId = codexSessionId();
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const fileName = `rollout-${ts}-${sessionId}.jsonl`;
    const filePath = join(sessionsDir, fileName);
    const lines: string[] = [];

    lines.push(JSON.stringify({
      timestamp: now.toISOString(),
      type: 'session_meta',
      payload: {
        session_id: sessionId,
        id: sessionId,
        timestamp: now.toISOString(),
        cwd: session.cwd || process.cwd(),
        originator: 'sessionport',
        cli_version: '0.1.0',
        source: 'cli',
        thread_source: 'import',
        model_provider: session.model?.provider || 'unknown',
      },
    }));

    const tsISO = now.toISOString();
    const toolResults = collectToolResults(session);

    for (const msg of session.messages) {
      if (msg.role === 'system') continue;

      const { nonTool, pairs } = pairTools(msg.parts, toolResults);
      const turnId = codexTurnId();

      lines.push(JSON.stringify({
        timestamp: tsISO,
        type: 'turn_context',
        payload: {
          turn_id: turnId,
          cwd: session.cwd || process.cwd(),
          workspace_roots: session.cwd ? [session.cwd] : [],
          current_date: now.toISOString().slice(0, 10),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          approval_policy: 'auto',
          sandbox_policy: { type: 'workspace-write', network_access: false },
        },
      }));

      const reasoningParts = nonTool.filter((p) => p.kind === 'reasoning');
      for (const rp of reasoningParts) {
        lines.push(JSON.stringify({
          timestamp: tsISO,
          type: 'response_item',
          payload: {
            type: 'reasoning',
            id: `reasoning_${claudeUuid().slice(0, 8)}`,
            content: [{ type: 'reasoning_summary', text: rp.text.slice(0, 500) }],
          },
        }));
      }

      const textParts = nonTool.filter((p) => p.kind === 'text');
      // A Claude user turn that exists only to carry tool results has nothing of its
      // own to say; writing an empty message for it would put a blank turn in the
      // transcript for every tool call in the session.
      const carriesToolResults = msg.parts.some((p) => p.kind === 'tool_result');

      const codexRole = msg.role === 'developer' ? 'developer' : msg.role;
      if (textParts.length > 0 || (msg.role === 'user' && pairs.length === 0 && !carriesToolResults)) {
        lines.push(JSON.stringify({
          timestamp: tsISO,
          type: 'response_item',
          payload: {
            type: 'message',
            id: `msg_${claudeUuid().slice(0, 12)}`,
            role: codexRole,
            content: textParts.map((p) =>
              p.kind === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_text', text: '' },
            ),
          },
        }));
      }

      for (const pair of pairs) {
        // One id per pair: a fresh codexCallId() for the output meant no result
        // ever pointed back at the call it came from.
        const callId = codexCallId();

        lines.push(JSON.stringify({
          timestamp: tsISO,
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            id: codexToolCallId(),
            status: 'completed',
            call_id: callId,
            name: pair.call.name || 'exec',
            input: typeof pair.call.input === 'string' ? pair.call.input : JSON.stringify(pair.call.input),
          },
        }));

        if (pair.result) {
          lines.push(JSON.stringify({
            timestamp: tsISO,
            type: 'response_item',
            payload: {
              type: 'custom_tool_call_output',
              id: `ctco_${claudeUuid().slice(0, 12)}`,
              call_id: callId,
              output: [{ type: 'input_text', text: pair.result.content.slice(0, 5000) }],
            },
          }));
        }
      }
    }

    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    const indexPath = join(codexRoot, 'session_index.jsonl');
    const indexEntry = JSON.stringify({
      id: sessionId,
      thread_name: session.title,
      updated_at: now.toISOString(),
    });

    try {
      appendFileSync(indexPath, indexEntry + '\n', 'utf-8');
    } catch {
      writeFileSync(indexPath, indexEntry + '\n', 'utf-8');
    }

    return {
      target: 'codex',
      sessionId,
      path: filePath,
      messageCount: session.messages.length,
    };
  }
}
