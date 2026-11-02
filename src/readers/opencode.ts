import Database from 'better-sqlite3';
import type {
  SourceTool,
  ModelInfo,
  TokenUsage,
  MessageIR,
  PartIR,
  SessionIR,
} from '../ir/types.js';
import type { Reader, SessionSummary } from './types.js';
import { opencodeDbPath } from '../paths.js';
import {
  cleanTitle,
  displayTitle,
  isPlaceholderTitle,
  UNTITLED,
} from '../ir/normalize.js';

export interface OpenCodePartData {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    metadata?: { output?: string };
  };
  path?: string;
  content?: string;
  name?: string;
  prompt?: string;
  time?: { start?: number; end?: number };
  auto?: boolean;
  tail_start_id?: string;
}

export interface OpenCodeMessageData {
  role: string;
  parentID?: string;
  agent?: string;
  model?: {
    providerID: string;
    modelID?: string;
    id?: string;
    variant?: string;
  };
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { write?: number; read?: number };
  };
  finish?: string;
  path?: { cwd?: string; root?: string };
  time?: { created: number; completed?: number };
  cost?: number;
}

export interface OpenCodeSessionRow {
  id: string;
  title: string;
  slug: string;
  directory: string;
  model: string | null;
  agent: string | null;
  time_created: number;
  time_updated: number;
}

/** A row of the v2 `session_v2` table. Same fields the legacy projection used. */
interface OpenCodeSessionV2Row extends OpenCodeSessionRow {}

interface OpenCodeMessageV2Row {
  id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  data: string;
}

interface OpenCodeV2Data {
  text?: string;
  agent?: string;
  model?: {
    providerID?: string;
    id?: string;
    modelID?: string;
    variant?: string;
  };
  tokens?: OpenCodeMessageData['tokens'];
  finish?: string;
  time?: { created?: number; completed?: number };
  content?: OpenCodeV2Content[];
}

interface OpenCodeV2Content {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  state?: {
    status?: string;
    input?: unknown;
    content?: Array<{ type?: string; text?: string }>;
    metadata?: { output?: string; truncated?: boolean };
    /** Older imports stored the whole output here instead of in `content`. */
    output?: string;
    error?: string | { message?: string };
  };
}

function parseModel(jsonStr: string | null): ModelInfo | undefined {
  if (!jsonStr) return undefined;
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      provider: parsed.providerID ?? 'unknown',
      // v2 writes `{ id }`; v1 wrote `{ modelID }`.
      id: parsed.id ?? parsed.modelID ?? 'unknown',
      variant: parsed.variant,
    };
  } catch {
    return undefined;
  }
}

function parseMessageData(jsonStr: string): OpenCodeMessageData {
  return JSON.parse(jsonStr);
}

/** Text of the last message that carried any, for use as a title fallback. */
function lastTextOf(messages: MessageIR[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i].parts) {
      if (part.kind === 'text' && part.text.trim()) {
        const cleaned = cleanTitle(part.text);
        if (cleaned !== UNTITLED) return cleaned;
      }
    }
  }
  return undefined;
}

function parsePartData(jsonStr: string): OpenCodePartData {
  return JSON.parse(jsonStr);
}

function partDataToIR(data: OpenCodePartData): PartIR | null {
  switch (data.type) {
    case 'text':
      return { kind: 'text', text: data.text ?? '' };
    case 'reasoning':
      return { kind: 'reasoning', text: data.text ?? '' };
    case 'tool':
      return {
        kind: 'tool_call',
        id: data.callID ?? `call_${Date.now()}`,
        name: data.tool ?? 'unknown',
        input: data.state?.input ?? {},
      };
    case 'file':
      return { kind: 'file', path: data.path ?? '', content: data.content };
    case 'agent':
      return { kind: 'agent', name: data.name ?? '', prompt: data.prompt };
    case 'step-start':
    case 'step-finish':
    case 'compaction':
      return { kind: 'meta', raw: data };
    default:
      return null;
  }
}

function findToolResultForCall(
  callId: string,
  allParts: { data: OpenCodePartData }[],
): string | undefined {
  for (const p of allParts) {
    if (
      p.data.type === 'tool' &&
      p.data.state &&
      p.data.callID === callId &&
      (p.data.state.output !== undefined ||
        p.data.state.metadata?.output !== undefined)
    ) {
      return p.data.state.metadata?.output ?? p.data.state.output ?? '';
    }
  }
  return undefined;
}

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/** Readable text of a v2 message, used for titles and last-message fallbacks. */
function v2Text(type: string, jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr) as OpenCodeV2Data;
    if (type === 'user') return data.text ?? '';
    if (type === 'assistant') {
      return (data.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(' ')
        .trim();
    }
    return '';
  } catch {
    return '';
  }
}

function v2ToolResult(state: OpenCodeV2Content['state']):
  | {
      content: string;
      isError: boolean;
      truncated?: boolean;
    }
  | undefined {
  if (!state || state.status === 'streaming' || state.status === 'running')
    return undefined;

  const fromContent = (state.content ?? [])
    .map((item) => (typeof item?.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
  const output =
    fromContent ||
    (typeof state.output === 'string' ? state.output : '') ||
    (typeof state.metadata?.output === 'string' ? state.metadata.output : '');

  if (state.status === 'error') {
    const message =
      typeof state.error === 'string'
        ? state.error
        : (state.error?.message ?? output);
    return {
      content: message || 'Tool call failed.',
      isError: true,
      truncated: state.metadata?.truncated,
    };
  }

  return {
    content: output,
    isError: false,
    truncated: state.metadata?.truncated,
  };
}

function v2ContentToParts(
  row: OpenCodeMessageV2Row,
  data: OpenCodeV2Data,
): PartIR[] {
  const parts: PartIR[] = [];
  for (const [index, content] of (data.content ?? []).entries()) {
    if (content.type === 'text') {
      if (content.text) parts.push({ kind: 'text', text: content.text });
      continue;
    }
    if (content.type === 'reasoning') {
      if (content.text) parts.push({ kind: 'reasoning', text: content.text });
      continue;
    }
    if (content.type === 'tool') {
      const id = content.id ?? `call_${row.id}_${index}`;
      parts.push({
        kind: 'tool_call',
        id,
        name: content.name ?? 'unknown',
        input: content.state?.input ?? {},
      });
      const result = v2ToolResult(content.state);
      if (result) {
        parts.push({
          kind: 'tool_result',
          toolCallId: id,
          content: result.content,
          isError: result.isError,
          truncated: result.truncated,
        });
      }
    }
  }
  return parts;
}

function v2MessageToIR(row: OpenCodeMessageV2Row): MessageIR | null {
  let data: OpenCodeV2Data;
  try {
    data = JSON.parse(row.data) as OpenCodeV2Data;
  } catch {
    return null;
  }

  const timestamp = data.time?.created ?? row.time_created;

  if (row.type === 'user') {
    const text = data.text ?? '';
    if (!text.trim()) return null;
    return {
      id: row.id,
      role: 'user',
      timestamp,
      parts: [{ kind: 'text', text }],
    };
  }

  if (row.type === 'system') {
    const text = data.text ?? '';
    if (!text.trim()) return null;
    return {
      id: row.id,
      role: 'system',
      timestamp,
      parts: [{ kind: 'text', text }],
    };
  }

  if (row.type !== 'assistant') return null;

  const parts = v2ContentToParts(row, data);
  if (parts.length === 0) return null;

  const tokens: TokenUsage | undefined = data.tokens
    ? {
        input: data.tokens.input,
        output: data.tokens.output,
        reasoning: data.tokens.reasoning,
        cacheRead: data.tokens.cache?.read,
        cacheWrite: data.tokens.cache?.write,
      }
    : undefined;

  return {
    id: row.id,
    role: 'assistant',
    timestamp,
    model: data.model
      ? {
          provider: data.model.providerID ?? 'unknown',
          id: data.model.id ?? data.model.modelID ?? 'unknown',
          variant: data.model.variant,
        }
      : undefined,
    tokens,
    finishReason: data.finish,
    parts,
  };
}

function buildV2Session(
  row: OpenCodeSessionV2Row,
  rows: OpenCodeMessageV2Row[],
): SessionIR {
  const messages = rows
    .map(v2MessageToIR)
    .filter((message): message is MessageIR => message !== null);

  let model = parseModel(row.model);
  for (const message of messages) {
    if (!model && message.model) {
      model = message.model;
      break;
    }
  }

  return {
    id: row.id,
    sourceTool: 'opencode' as SourceTool,
    title: displayTitle({
      title: row.title,
      lastMessage: lastTextOf(messages),
      updatedAt: row.time_updated,
      createdAt: row.time_created,
    }),
    cwd: row.directory || undefined,
    model,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
    messages,
  };
}

export class OpenCodeReader implements Reader {
  readonly tool = 'opencode';

  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? opencodeDbPath();
  }

  listSessions(): SessionSummary[] {
    let db: Database.Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch {
      return [];
    }

    try {
      const summaries: SessionSummary[] = [];
      const seen = new Set<string>();

      // OpenCode 2 stores sessions in `session_v2`. The old `session` table is
      // still there for sessions that have not been migrated, so both are read.
      if (hasTable(db, 'session_v2') && hasTable(db, 'session_message')) {
        const rows = db
          .prepare(
            `SELECT id, title, directory, model, time_created, time_updated
             FROM session_v2 ORDER BY time_updated DESC`,
          )
          .all() as OpenCodeSessionV2Row[];

        const lastText = db.prepare(
          `SELECT type, data FROM session_message
           WHERE session_id = ? AND type IN ('user', 'assistant')
           ORDER BY seq DESC LIMIT 8`,
        );

        for (const r of rows) {
          seen.add(r.id);
          let lastMessage: string | undefined;
          if (isPlaceholderTitle(r.title)) {
            try {
              for (const row of lastText.all(r.id) as {
                type: string;
                data: string;
              }[]) {
                const cleaned = cleanTitle(v2Text(row.type, row.data));
                if (cleaned !== UNTITLED) {
                  lastMessage = cleaned;
                  break;
                }
              }
            } catch {
              // no readable last message — the timestamp fallback still applies
            }
          }
          summaries.push({
            id: r.id,
            title: r.title,
            tool: 'opencode',
            createdAt: r.time_created,
            updatedAt: r.time_updated,
            model: r.model ? parseModel(r.model)?.id : undefined,
            path: r.directory,
            lastMessage,
          });
        }
      }

      const legacyRows = hasTable(db, 'session')
        ? (db
            .prepare(
              `SELECT id, title, directory, model, time_created, time_updated
               FROM session ORDER BY time_updated DESC`,
            )
            .all() as OpenCodeSessionRow[])
        : [];

      // OpenCode stores "New session - <iso>" placeholders for unnamed sessions;
      // pull their last text part so the list can show something meaningful.
      const lastText = hasTable(db, 'part')
        ? db.prepare(
            `SELECT data FROM part
             WHERE session_id = ?
               AND json_extract(data, '$.type') = 'text'
               AND trim(coalesce(json_extract(data, '$.text'), '')) != ''
             ORDER BY time_created DESC LIMIT 5`,
          )
        : undefined;

      for (const r of legacyRows) {
        if (seen.has(r.id)) continue;
        let lastMessage: string | undefined;
        if (isPlaceholderTitle(r.title)) {
          try {
            for (const row of (lastText?.all(r.id) ?? []) as {
              data: string;
            }[]) {
              const cleaned = cleanTitle(parsePartData(row.data).text ?? '');
              if (cleaned !== UNTITLED) {
                lastMessage = cleaned;
                break;
              }
            }
          } catch {
            // no readable last message — the timestamp fallback still applies
          }
        }
        summaries.push({
          id: r.id,
          title: r.title,
          tool: 'opencode',
          createdAt: r.time_created,
          updatedAt: r.time_updated,
          model: r.model ? parseModel(r.model)?.id : undefined,
          path: r.directory,
          lastMessage,
        });
      }

      summaries.sort((a, b) => b.updatedAt - a.updatedAt);
      return summaries;
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  readSession(id: string): SessionIR {
    let db: Database.Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch (err) {
      throw new Error(
        `Cannot open opencode database: ${(err as Error).message}`,
      );
    }

    try {
      if (hasTable(db, 'session_v2') && hasTable(db, 'session_message')) {
        const row = db
          .prepare(
            `SELECT id, title, directory, model, agent, time_created, time_updated
             FROM session_v2 WHERE id = ?`,
          )
          .get(id) as OpenCodeSessionV2Row | undefined;

        if (row) {
          const messageRows = db
            .prepare(
              `SELECT id, type, seq, time_created, time_updated, data
               FROM session_message WHERE session_id = ? ORDER BY seq ASC`,
            )
            .all(id) as OpenCodeMessageV2Row[];

          // A migrated session can exist in both tables; its v2 projection is
          // authoritative once it has messages, but older sessions have none.
          if (messageRows.length > 0) return buildV2Session(row, messageRows);
        }
      }

      const sessionRow = hasTable(db, 'session')
        ? (db.prepare('SELECT * FROM session WHERE id = ?').get(id) as
            OpenCodeSessionRow | undefined)
        : undefined;

      if (!sessionRow) {
        // A v2 session without messages is still a valid (empty) session.
        if (hasTable(db, 'session_v2')) {
          const row = db
            .prepare(
              `SELECT id, title, directory, model, agent, time_created, time_updated
               FROM session_v2 WHERE id = ?`,
            )
            .get(id) as OpenCodeSessionV2Row | undefined;
          if (row) return buildV2Session(row, []);
        }
        throw new Error(`OpenCode session not found: ${id}`);
      }

      const messageRows = db
        .prepare(
          'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC',
        )
        .all(id) as { id: string; time_created: number; data: string }[];

      const partRows = db
        .prepare(
          'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC',
        )
        .all(id) as { message_id: string; data: string }[];

      const partMap = new Map<string, { data: OpenCodePartData }[]>();
      for (const pr of partRows) {
        if (!partMap.has(pr.message_id)) partMap.set(pr.message_id, []);
        partMap.get(pr.message_id)!.push({ data: parsePartData(pr.data) });
      }

      const messages: MessageIR[] = [];
      let model = parseModel(sessionRow.model);

      for (const mr of messageRows) {
        const mData = parseMessageData(mr.data);
        const parts = partMap.get(mr.id) ?? [];
        const irParts: PartIR[] = [];

        for (const p of parts) {
          const irPart = partDataToIR(p.data);
          if (irPart) {
            if (irPart.kind === 'tool_call') {
              const output = findToolResultForCall(
                (irPart as import('../ir/types.js').ToolCallPart).id,
                parts,
              );
              irParts.push(irPart);
              if (output !== undefined) {
                irParts.push({
                  kind: 'tool_result',
                  toolCallId: (irPart as import('../ir/types.js').ToolCallPart)
                    .id,
                  content: output,
                });
              }
            } else {
              irParts.push(irPart);
            }
          }
        }

        if (!model && mData.model) {
          model = {
            provider: mData.model.providerID,
            id: mData.model.modelID ?? mData.model.id ?? 'unknown',
            variant: mData.model.variant,
          };
        }

        const tokens: TokenUsage | undefined = mData.tokens
          ? {
              total: mData.tokens.total,
              input: mData.tokens.input,
              output: mData.tokens.output,
              reasoning: mData.tokens.reasoning,
              cacheWrite: mData.tokens.cache?.write,
              cacheRead: mData.tokens.cache?.read,
            }
          : undefined;

        messages.push({
          id: mr.id,
          parentId: mData.parentID,
          role: mData.role as MessageIR['role'],
          timestamp: mData.time?.created ?? mr.time_created,
          model: mData.model
            ? {
                provider: mData.model.providerID,
                id: mData.model.modelID ?? mData.model.id ?? 'unknown',
                variant: mData.model.variant,
              }
            : undefined,
          tokens,
          finishReason: mData.finish,
          parts: irParts,
        });
      }

      return {
        id: sessionRow.id,
        sourceTool: 'opencode' as SourceTool,
        title: displayTitle({
          title: sessionRow.title,
          lastMessage: lastTextOf(messages),
          updatedAt: sessionRow.time_updated,
          createdAt: sessionRow.time_created,
        }),
        cwd: sessionRow.directory || undefined,
        model,
        createdAt: sessionRow.time_created,
        updatedAt: sessionRow.time_updated,
        messages,
      };
    } finally {
      db.close();
    }
  }
}
