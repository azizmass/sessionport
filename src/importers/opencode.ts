import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import type { SessionIR, PartIR, ToolCallPart, ToolResultPart } from '../ir/types.js';
import type { Importer, ImportResult } from './types.js';
import { opencodeSessionId, opencodeMessageId, opencodePartId, opencodeEventId, opencodeSlug } from './ids.js';
import { translateToolCall, toolInput } from './tools.js';

interface ToolPair {
  call: ToolCallPart;
  result?: ToolResultPart;
}

/**
 * Tool results do not always live in the message that made the call — Claude Code puts
 * them in the following user message — while OpenCode stores call and output in a single
 * tool part. So results are collected across the whole session and matched by call id.
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

/** Parts that become OpenCode parts of their own: meta is dropped, results are merged. */
function renderableParts(parts: PartIR[]): PartIR[] {
  return parts.filter((p) => p.kind !== 'meta' && p.kind !== 'tool_result');
}

/**
 * OpenCode's finish reasons come from the AI SDK vocabulary. Source tools use their
 * own (Claude: `end_turn` / `tool_use` / …). The value matters: the session loop only
 * treats `tool-calls` as "there is more work in this turn".
 */
const FINISH_REASONS: Record<string, string> = {
  stop: 'stop',
  end_turn: 'stop',
  'end-turn': 'stop',
  stop_sequence: 'stop',
  length: 'length',
  max_tokens: 'length',
  'tool-calls': 'tool-calls',
  tool_use: 'tool-calls',
  tool_calls: 'tool-calls',
  'content-filter': 'content-filter',
  content_filter: 'content-filter',
  refusal: 'content-filter',
  error: 'error',
  aborted: 'error',
  cancelled: 'error',
};

function mapFinishReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return FINISH_REASONS[reason] ?? FINISH_REASONS[reason.toLowerCase()] ?? 'other';
}

function toolTitle(name: string, input: Record<string, unknown>): string {
  const candidate =
    input.command ?? input.cmd ?? input.file_path ?? input.filePath ?? input.path ?? input.url ?? input.pattern ?? input.input;
  const text = typeof candidate === 'string' && candidate.length > 0 ? candidate : name;
  return text.length > 120 ? text.slice(0, 120) + '…' : text;
}

function toolState(pair: ToolPair, start: number, end: number): Record<string, unknown> {
  const translated = translateToolCall(pair.call.name, pair.call.input, 'opencode');
  const input = toolInput(translated.input);
  const result = pair.result;

  if (!result) {
    // No output was ever captured — same shape OpenCode uses for an interrupted call,
    // so its loop treats it as settled instead of trying to resume the tool.
    return {
      status: 'error',
      input,
      error: 'No tool output captured (imported session).',
      metadata: { interrupted: true },
      time: { start, end },
    };
  }

  if (result.isError) {
    return {
      status: 'error',
      input,
      error: result.content || 'Tool call failed.',
      metadata: { truncated: result.truncated === true },
      time: { start, end },
    };
  }

  const output = result.content ?? '';
  return {
    status: 'completed',
    input,
    output,
    title: toolTitle(translated.name, input),
    metadata: { output, truncated: result.truncated === true },
    time: { start, end },
  };
}

/**
 * Part payload as stored in the `part.data` column. `id` / `sessionID` / `messageID`
 * live in their own columns, so they are omitted here but included in the event copy.
 */
function partToOpenCodeData(part: PartIR, callId: string, ts: number, toolPair?: ToolPair): Record<string, unknown> {
  switch (part.kind) {
    case 'text':
      return { type: 'text', text: part.text, time: { start: ts, end: ts } };
    case 'reasoning':
      return { type: 'reasoning', text: part.text, time: { start: ts, end: ts } };
    case 'tool_call':
      return {
        type: 'tool',
        tool: translateToolCall(part.name, part.input, 'opencode').name,
        callID: callId,
        state: toolState(toolPair ?? { call: part }, ts, ts),
      };
    case 'file':
      return { type: 'file', mime: 'text/plain', filename: part.path, url: `file://${part.path}` };
    case 'agent':
      return { type: 'agent', name: part.name };
    default:
      return { type: 'text', text: String(part) };
  }
}

function eventPartData(
  partData: Record<string, unknown>,
  partId: string,
  messageId: string,
  sessionId: string,
  ts: number,
): Record<string, unknown> {
  return {
    sessionID: sessionId,
    part: { id: partId, sessionID: sessionId, messageID: messageId, ...partData },
    time: ts,
  };
}

/**
 * Hands out strictly increasing millisecond timestamps, preferring the source
 * timestamp when it moves forward. Message and part ids are derived from these, and
 * OpenCode reads both back ordered by (time_created, id) — equal or out-of-order
 * timestamps scramble the transcript.
 */
class Sequencer {
  private cursor: number;

  constructor(start: number) {
    this.cursor = Math.floor(start) - 1;
  }

  next(preferred?: number): number {
    const base = preferred && preferred > 0 ? Math.floor(preferred) : 0;
    this.cursor = Math.max(base, this.cursor + 1);
    return this.cursor;
  }
}

interface EventRow {
  id: string;
  aggregate_id: string;
  seq: number;
  type: string;
  data: string;
}

export class OpenCodeImporter implements Importer {
  readonly target = 'opencode';
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  }

  importSession(session: SessionIR): ImportResult {
    if (!existsSync(this.dbPath)) {
      throw new Error(`OpenCode database not found at ${this.dbPath}. Is OpenCode installed?`);
    }

    const backupPath = this.dbPath + '.sessionport-backup';
    if (!existsSync(backupPath)) {
      copyFileSync(this.dbPath, backupPath);
    }

    const opencodeDir = join(this.dbPath, '..');
    const storageDir = join(opencodeDir, 'storage');
    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }

    const now = Date.now();
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    try {
      const sid = opencodeSessionId(session.createdAt || now);
      const slug = opencodeSlug();
      const ts = now;

      // Match the schema version OpenCode itself is writing, not a pinned one.
      const versionRow = db.prepare('SELECT version FROM session ORDER BY time_created DESC LIMIT 1').get() as
        | { version: string }
        | undefined;
      const version = versionRow?.version || '1.18.9';

      // Use the current OpenCode model instead of source model
      const currentModel = db.prepare(
        "SELECT model FROM session WHERE json_extract(model, '$.providerID') != ? ORDER BY time_created DESC LIMIT 1"
      ).get('anthropic') as { model: string } | undefined;

      let providerID: string;
      let modelID: string;
      let variant: string;

      if (currentModel) {
        const parsed = JSON.parse(currentModel.model) as { id: string; providerID: string; variant?: string };
        providerID = parsed.providerID;
        modelID = parsed.id;
        variant = parsed.variant || '';
      } else if (session.model) {
        providerID = session.model.provider;
        modelID = session.model.id;
        variant = session.model.variant || '';
      } else {
        providerID = 'unknown';
        modelID = 'unknown';
        variant = '';
      }

      const modelJson = JSON.stringify(variant ? { id: modelID, providerID, variant } : { id: modelID, providerID });

      const totalTokens = {
        input: session.messages.reduce((s, m) => s + (m.tokens?.input || 0), 0),
        output: session.messages.reduce((s, m) => s + (m.tokens?.output || 0), 0),
        reasoning: session.messages.reduce((s, m) => s + (m.tokens?.reasoning || 0), 0),
        cacheRead: session.messages.reduce((s, m) => s + (m.tokens?.cacheRead || 0), 0),
        cacheWrite: session.messages.reduce((s, m) => s + (m.tokens?.cacheWrite || 0), 0),
        total: session.messages.reduce((s, m) => s + (m.tokens?.total || 0), 0),
      };

      // A session ported from another machine can carry a directory that does not
      // exist here; OpenCode resolves the session directory at prompt time and fails
      // the whole turn if it is missing.
      const cwd = session.cwd && existsSync(session.cwd) ? session.cwd : process.cwd();
      const dirPath = cwd;
      const relPath = cwd.replace(/^\//, '');

      // Plan exports belong on the plan agent; a ported conversation belongs on
      // the working one. Forcing everything onto 'plan' left every imported
      // session read-only, unable to edit files when it was picked up again.
      const agent = session.metadata?.plan ? 'plan' : 'build';

      const insertAll = db.transaction(() => {
        let seq = 0;
        const events: EventRow[] = [];

        const tsCreatedInfo = Math.floor(session.createdAt || ts);
        const messageSeq = new Sequencer(tsCreatedInfo);
        const eventSeq = new Sequencer(tsCreatedInfo);

        const sessionInfo = {
          id: sid,
          slug,
          projectID: 'global',
          directory: dirPath,
          path: relPath,
          // Cost is a currency amount in OpenCode, not a token count.
          cost: 0,
          tokens: {
            input: totalTokens.input,
            output: totalTokens.output,
            reasoning: totalTokens.reasoning,
            cache: { read: totalTokens.cacheRead, write: totalTokens.cacheWrite },
          },
          title: session.title,
          agent,
          model: variant ? { id: modelID, providerID, variant } : { id: modelID, providerID },
          version,
          time: { created: tsCreatedInfo, updated: ts },
        };

        events.push({
          id: opencodeEventId(eventSeq.next()),
          aggregate_id: sid,
          seq: seq++,
          type: 'session.created.1',
          data: JSON.stringify({ sessionID: sid, info: sessionInfo }),
        });

        const insertEvent = db.prepare(`INSERT OR IGNORE INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)`);
        const insertEventSeq = db.prepare(`INSERT OR REPLACE INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, ?)`);
        const updateEventSeq = db.prepare(`UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?`);

        const tsCreated = Math.floor(session.createdAt || ts);
        const tsUpdated = Math.floor(ts);

        const insertSession = db.prepare(`INSERT INTO session
          (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, model,
           agent, time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning,
           tokens_cache_read, tokens_cache_write, summary_additions, summary_deletions, summary_files)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

        const insertMessage = db.prepare(`INSERT INTO message
          (id, session_id, time_created, time_updated, data)
          VALUES (?, ?, ?, ?, ?)`);

        const insertPart = db.prepare(`INSERT INTO part
          (id, message_id, session_id, time_created, time_updated, data)
          VALUES (?, ?, ?, ?, ?, ?)`);

        insertSession.run(
          sid, 'global', null, null, slug, dirPath,
          relPath, session.title, version, modelJson,
          agent, tsCreated, tsUpdated,
          0, totalTokens.input, totalTokens.output,
          totalTokens.reasoning, totalTokens.cacheRead, totalTokens.cacheWrite,
          0, 0, 0,
        );

        // OpenCode's assistant messages point at the user message that opened the turn.
        let lastUserMsgId = '';
        let msgCount = 0;

        const toolResults = collectToolResults(session);
        const importable = session.messages.filter(
          (m) => m.role !== 'system' && m.role !== 'developer' && renderableParts(m.parts).length > 0,
        );

        for (const msg of importable) {
          const parts = renderableParts(msg.parts);
          const msgTs = messageSeq.next(msg.timestamp);
          const mid = opencodeMessageId(msgTs);
          const msgRole = msg.role as string;

          const tokens = {
            // OpenCode carries a `total` on every assistant message and reads it back
            // for the per-message usage display; without it a ported turn shows nothing.
            total:
              msg.tokens?.total ||
              (msg.tokens?.input || 0) + (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0),
            input: msg.tokens?.input || 0,
            output: msg.tokens?.output || 0,
            reasoning: msg.tokens?.reasoning || 0,
            cache: { write: msg.tokens?.cacheWrite || 0, read: msg.tokens?.cacheRead || 0 },
          };

          const msgInfo: Record<string, unknown> = {
            id: mid,
            sessionID: sid,
            role: msgRole,
            time: { created: msgTs },
          };

          if (msgRole === 'assistant') {
            // parentID, path, cost and tokens are all required on an assistant message.
            msgInfo.parentID = lastUserMsgId || mid;
            msgInfo.mode = agent;
            msgInfo.agent = agent;
            msgInfo.modelID = modelID;
            msgInfo.providerID = providerID;
            if (variant) msgInfo.variant = variant;
            msgInfo.path = { cwd, root: '/' };
            msgInfo.time = { created: msgTs, completed: msgTs };
            msgInfo.cost = 0;
            msgInfo.tokens = tokens;
            msgInfo.finish = mapFinishReason(msg.finishReason) ?? 'stop';
          } else {
            msgInfo.agent = agent;
            msgInfo.model = variant ? { providerID, modelID, variant } : { providerID, modelID };
            msgInfo.summary = { diffs: [] };
            lastUserMsgId = mid;
          }

          events.push({
            id: opencodeEventId(eventSeq.next()),
            aggregate_id: sid,
            seq: seq++,
            type: 'message.updated.1',
            data: JSON.stringify({ sessionID: sid, info: msgInfo }),
          });

          insertMessage.run(mid, sid, msgTs, ts, JSON.stringify(msgInfo));

          const ordered: Array<{ part: PartIR; pair?: ToolPair }> = parts.map((part) =>
            part.kind === 'tool_call'
              ? { part, pair: { call: part, result: toolResults.get(part.id) } }
              : { part },
          );

          // Every part is stored twice: as a row, and as the event that projects it.
          const emitPart = (data: Record<string, unknown>, at?: number) => {
            const partTs = at ?? messageSeq.next();
            const opcId = opencodePartId(partTs);
            insertPart.run(opcId, mid, sid, partTs, ts, JSON.stringify(data));
            events.push({
              id: opencodeEventId(eventSeq.next()),
              aggregate_id: sid,
              seq: seq++,
              type: 'message.part.updated.1',
              data: JSON.stringify(eventPartData(data, opcId, mid, sid, partTs)),
            });
          };

          // Assistant turns in OpenCode open with a step-start part…
          if (msgRole === 'assistant') emitPart({ type: 'step-start' });

          let partSeq = 0;

          for (const { part, pair } of ordered) {
            const callId = pair?.call.id || `call_${mid.slice(4, 16)}_${partSeq}`;
            const partTs = messageSeq.next();
            emitPart(partToOpenCodeData(part, callId, partTs, pair), partTs);
            partSeq++;
          }

          // …and close with a step-finish, which is where OpenCode reads the turn's
          // usage from. An assistant turn without one reads as still running.
          if (msgRole === 'assistant') {
            emitPart({ type: 'step-finish', reason: msgInfo.finish, tokens, cost: 0 });
          }

          msgCount++;
        }

        events.push({
          id: opencodeEventId(eventSeq.next()),
          aggregate_id: sid,
          seq: seq++,
          type: 'session.updated.1',
          data: JSON.stringify({ sessionID: sid, info: sessionInfo }),
        });

        insertEventSeq.run(sid, 0, null);

        for (const evt of events) {
          insertEvent.run(evt.id, evt.aggregate_id, evt.seq, evt.type, evt.data);
        }

        updateEventSeq.run(seq - 1, sid);
      });

      insertAll();
      db.close();

      return {
        target: 'opencode',
        sessionId: sid,
        path: this.dbPath,
        messageCount: session.messages.filter(
          (m) => m.role !== 'system' && m.role !== 'developer' && renderableParts(m.parts).length > 0,
        ).length,
      };
    } catch (err) {
      db.close();
      throw err;
    }
  }
}
