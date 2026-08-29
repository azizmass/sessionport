import Database from 'better-sqlite3';
import type { SourceTool, ModelInfo, TokenUsage, MessageIR, PartIR, SessionIR } from '../ir/types.js';
import type { Reader, SessionSummary } from './types.js';
import { opencodeDbPath } from '../paths.js';
import { cleanTitle, displayTitle, isPlaceholderTitle, UNTITLED } from '../ir/normalize.js';

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
  model?: { providerID: string; modelID: string; variant?: string };
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

function parseModel(jsonStr: string | null): ModelInfo | undefined {
  if (!jsonStr) return undefined;
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      provider: parsed.providerID ?? 'unknown',
      id: parsed.modelID ?? parsed.id ?? 'unknown',
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
      (p.data.state.output !== undefined || p.data.state.metadata?.output !== undefined)
    ) {
      return p.data.state.metadata?.output ?? p.data.state.output ?? '';
    }
  }
  return undefined;
}

export class OpenCodeReader implements Reader {
  readonly tool = 'opencode';

  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? opencodeDbPath();
  }

  listSessions(): SessionSummary[] {
    try {
      const db = new Database(this.dbPath, { readonly: true });
      const rows = db
        .prepare(
          `SELECT id, title, directory, model, time_created, time_updated 
           FROM session ORDER BY time_updated DESC`,
        )
        .all() as OpenCodeSessionRow[];

      // OpenCode stores "New session - <iso>" placeholders for unnamed sessions;
      // pull their last text part so the list can show something meaningful.
      const lastText = db.prepare(
        `SELECT data FROM part
         WHERE session_id = ?
           AND json_extract(data, '$.type') = 'text'
           AND trim(coalesce(json_extract(data, '$.text'), '')) != ''
         ORDER BY time_created DESC LIMIT 5`,
      );

      const summaries = rows.map((r) => {
        let lastMessage: string | undefined;
        if (isPlaceholderTitle(r.title)) {
          try {
            for (const row of lastText.all(r.id) as { data: string }[]) {
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
        return {
          id: r.id,
          title: r.title,
          tool: 'opencode',
          createdAt: r.time_created,
          updatedAt: r.time_updated,
          model: r.model ? parseModel(r.model)?.id : undefined,
          path: r.directory,
          lastMessage,
        };
      });

      db.close();
      return summaries;
    } catch {
      return [];
    }
  }

  readSession(id: string): SessionIR {
    let db: Database.Database;
    try {
      db = new Database(this.dbPath, { readonly: true });
    } catch (err) {
      throw new Error(`Cannot open opencode database: ${(err as Error).message}`);
    }

    try {
      const sessionRow = db
        .prepare('SELECT * FROM session WHERE id = ?')
        .get(id) as OpenCodeSessionRow | undefined;

      if (!sessionRow) {
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

      db.close();

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
                  toolCallId: (irPart as import('../ir/types.js').ToolCallPart).id,
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
            id: mData.model.modelID,
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
                id: mData.model.modelID,
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
    } catch (err) {
      db.close();
      throw err;
    }
  }
}
