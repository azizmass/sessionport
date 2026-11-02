import { existsSync, copyFileSync, mkdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import type {
  SessionIR,
  PartIR,
  ToolCallPart,
  ToolResultPart,
} from '../ir/types.js';
import type { Importer, ImportResult } from './types.js';
import {
  opencodeSessionId,
  opencodeMessageId,
  opencodePartId,
  opencodeEventId,
  opencodeSlug,
} from './ids.js';
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
  return (
    FINISH_REASONS[reason] ?? FINISH_REASONS[reason.toLowerCase()] ?? 'other'
  );
}

function toolTitle(name: string, input: Record<string, unknown>): string {
  const candidate =
    input.command ??
    input.cmd ??
    input.file_path ??
    input.filePath ??
    input.path ??
    input.url ??
    input.pattern ??
    input.input;
  const text =
    typeof candidate === 'string' && candidate.length > 0 ? candidate : name;
  return text.length > 120 ? text.slice(0, 120) + '…' : text;
}

function toolState(
  pair: ToolPair,
  start: number,
  end: number,
): Record<string, unknown> {
  const translated = translateToolCall(
    pair.call.name,
    pair.call.input,
    'opencode',
  );
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
function partToOpenCodeData(
  part: PartIR,
  callId: string,
  ts: number,
  toolPair?: ToolPair,
): Record<string, unknown> {
  switch (part.kind) {
    case 'text':
      return { type: 'text', text: part.text, time: { start: ts, end: ts } };
    case 'reasoning':
      return {
        type: 'reasoning',
        text: part.text,
        time: { start: ts, end: ts },
      };
    case 'tool_call':
      return {
        type: 'tool',
        tool: translateToolCall(part.name, part.input, 'opencode').name,
        callID: callId,
        state: toolState(toolPair ?? { call: part }, ts, ts),
      };
    case 'file':
      return {
        type: 'file',
        mime: 'text/plain',
        filename: part.path,
        url: `file://${part.path}`,
      };
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
    part: {
      id: partId,
      sessionID: sessionId,
      messageID: messageId,
      ...partData,
    },
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

interface V2Model {
  id: string;
  providerID: string;
  variant?: string;
}

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** `https://github.com/o/r.git`, `git@github.com:o/r` → `github.com/o/r`. */
function gitRemoteKey(remote: string): string | undefined {
  const clean = (host: string, path: string) => {
    const trimmed = path
      .replace(/^\/+/, '')
      .replace(/\.git\/?$/, '')
      .replace(/\/+$/, '');
    return host && trimmed ? `${host.toLowerCase()}/${trimmed}` : undefined;
  };

  const value = remote.trim();
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return undefined;
    return clean(url.hostname, url.pathname);
  } catch {
    // scp-style remote: [user@]host:path
  }

  const match = /^([^@/:]+@)?([^/:]+):(.+)$/.exec(value);
  return match ? clean(match[2], match[3]) : undefined;
}

/** The project id OpenCode itself would use for this directory. */
function resolveProject(
  db: Database.Database,
  cwd: string,
  now: number,
): { id: string; worktree: string; vcs: string | null } {
  // Reuse a project OpenCode has already recorded for this checkout or a parent
  // of it; that also covers linked worktrees and repos with no remote.
  const existing = db
    .prepare(
      `SELECT id, worktree, vcs FROM project
       WHERE worktree = ? OR (? LIKE worktree || '/%')
       ORDER BY length(worktree) DESC LIMIT 1`,
    )
    .get(cwd, cwd) as
    { id: string; worktree: string; vcs: string | null } | undefined;
  if (existing) return existing;

  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top) {
    const remote = git(top, ['remote', 'get-url', 'origin']);
    const remoteKey = remote ? gitRemoteKey(remote) : undefined;
    if (remoteKey) {
      return { id: sha1(`git-remote:${remoteKey}`), worktree: top, vcs: 'git' };
    }

    const rootCommit = git(top, [
      'rev-list',
      '--max-parents=0',
      '--reverse',
      'HEAD',
    ])?.split('\n')[0];
    if (rootCommit) return { id: rootCommit, worktree: top, vcs: 'git' };

    return { id: sha1(`directory:${top}`), worktree: top, vcs: 'git' };
  }

  let directory = cwd;
  try {
    directory = realpathSync(cwd);
  } catch {
    // keep the absolute path we were given
  }
  return { id: sha1(`directory:${directory}`), worktree: directory, vcs: null };
}

function parseV2Model(jsonStr: string | null): V2Model | undefined {
  if (!jsonStr) return undefined;
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const id = (parsed.id ?? parsed.modelID) as string | undefined;
    if (!id) return undefined;
    return {
      id,
      providerID: (parsed.providerID as string) ?? 'unknown',
      variant: parsed.variant as string | undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * OpenCode v2 stores the whole conversation in `session_v2` + `session_message`.
 * The old event-sourced tables are ignored by 2.x, so a v1 import is invisible
 * there — this writes the projection tables directly, like OpenCode's own import.
 */
function importIntoV2(
  db: Database.Database,
  session: SessionIR,
  now: number,
): ImportResult {
  const sid = opencodeSessionId(session.createdAt || now);
  const slug = opencodeSlug();

  const cwd =
    session.cwd && existsSync(session.cwd) ? session.cwd : process.cwd();
  const project = resolveProject(db, cwd, now);

  const versionRow = db
    .prepare(
      'SELECT version FROM session_v2 ORDER BY time_created DESC LIMIT 1',
    )
    .get() as { version: string } | undefined;
  const version = versionRow?.version || '2.0.0';

  // Use the current OpenCode model instead of a source model it may not have.
  const currentModelRow =
    (db
      .prepare(
        "SELECT model FROM session_v2 WHERE model IS NOT NULL AND json_extract(model, '$.providerID') != 'anthropic' ORDER BY time_created DESC LIMIT 1",
      )
      .get() as { model: string } | undefined) ??
    (hasTable(db, 'session')
      ? (db
          .prepare(
            "SELECT model FROM session WHERE model IS NOT NULL AND json_extract(model, '$.providerID') != 'anthropic' ORDER BY time_created DESC LIMIT 1",
          )
          .get() as { model: string } | undefined)
      : undefined);

  const model =
    parseV2Model(currentModelRow?.model ?? null) ??
    (session.model
      ? {
          id: session.model.id,
          providerID: session.model.provider,
          variant: session.model.variant,
        }
      : { id: 'unknown', providerID: 'unknown' });
  const modelJson = JSON.stringify(
    model.variant
      ? { id: model.id, providerID: model.providerID, variant: model.variant }
      : { id: model.id, providerID: model.providerID },
  );

  const agent = session.metadata?.plan ? 'plan' : 'build';
  const totalTokens = {
    input: session.messages.reduce(
      (sum, message) => sum + (message.tokens?.input || 0),
      0,
    ),
    output: session.messages.reduce(
      (sum, message) => sum + (message.tokens?.output || 0),
      0,
    ),
    reasoning: session.messages.reduce(
      (sum, message) => sum + (message.tokens?.reasoning || 0),
      0,
    ),
    cacheRead: session.messages.reduce(
      (sum, message) => sum + (message.tokens?.cacheRead || 0),
      0,
    ),
    cacheWrite: session.messages.reduce(
      (sum, message) => sum + (message.tokens?.cacheWrite || 0),
      0,
    ),
  };

  const tools = collectToolResults(session);
  const importable = session.messages.filter((message) => {
    if (message.role === 'system' || message.role === 'developer') return false;
    if (message.role === 'user') {
      return message.parts.some(
        (part) => part.kind === 'text' && part.text.trim() !== '',
      );
    }
    return renderableParts(message.parts).some(
      (part) =>
        part.kind === 'text' ||
        part.kind === 'reasoning' ||
        part.kind === 'tool_call',
    );
  });

  const insertProject = db.prepare(
    `INSERT OR IGNORE INTO project (id, worktree, vcs, sandboxes, time_created, time_updated)
     VALUES (?, ?, ?, '[]', ?, ?)`,
  );
  const touchProject = db.prepare(
    'UPDATE project SET time_updated = ? WHERE id = ?',
  );
  const insertSession = db.prepare(
    `INSERT INTO session_v2
       (id, project_id, slug, directory, path, title, version, cost,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
        agent, model, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const sequencer = new Sequencer(Math.floor(session.createdAt || now));
  let seq = 0;

  const transaction = db.transaction(() => {
    insertProject.run(project.id, project.worktree, project.vcs, now, now);
    touchProject.run(now, project.id);

    insertSession.run(
      sid,
      project.id,
      slug,
      cwd,
      null,
      session.title,
      version,
      0,
      totalTokens.input,
      totalTokens.output,
      totalTokens.reasoning,
      totalTokens.cacheRead,
      totalTokens.cacheWrite,
      agent,
      modelJson,
      Math.floor(session.createdAt || now),
      now,
    );

    for (const message of importable) {
      const ts = sequencer.next(message.timestamp);
      const mid = opencodeMessageId(ts);

      if (message.role === 'user') {
        const text = message.parts
          .filter(
            (part): part is Extract<PartIR, { kind: 'text' }> =>
              part.kind === 'text',
          )
          .map((part) => part.text)
          .join('\n\n');
        insertMessage.run(
          mid,
          sid,
          'user',
          ++seq,
          ts,
          now,
          JSON.stringify({
            time: { created: ts },
            text,
            files: [],
            agents: [],
          }),
        );
        continue;
      }

      const content: Record<string, unknown>[] = [];
      for (const part of message.parts) {
        if (part.kind === 'text') {
          content.push({ type: 'text', text: part.text });
        } else if (part.kind === 'reasoning') {
          content.push({ type: 'reasoning', text: part.text });
        } else if (part.kind === 'tool_call') {
          const translated = translateToolCall(
            part.name,
            part.input,
            'opencode',
          );
          content.push({
            type: 'tool',
            id: part.id,
            name: translated.name,
            executed: false,
            // Required by OpenCode's v2 message schema, even though it looks optional.
            time: { created: ts, completed: ts },
            state: v2ToolState(
              { call: part, result: tools.get(part.id) },
              translated.input,
            ),
          });
        }
      }
      if (content.length === 0) continue;

      const finish = mapFinishReason(message.finishReason) ?? 'stop';
      const tokens = {
        input: message.tokens?.input || 0,
        output: message.tokens?.output || 0,
        reasoning: message.tokens?.reasoning || 0,
        cache: {
          read: message.tokens?.cacheRead || 0,
          write: message.tokens?.cacheWrite || 0,
        },
      };

      insertMessage.run(
        mid,
        sid,
        'assistant',
        ++seq,
        ts,
        now,
        JSON.stringify({
          time: { created: ts, completed: ts },
          agent,
          model: model.variant
            ? {
                id: model.id,
                providerID: model.providerID,
                variant: model.variant,
              }
            : { id: model.id, providerID: model.providerID },
          content,
          tokens,
          cost: 0,
          // v2 accepts `unknown` where v1 used `other`.
          finish: finish === 'other' ? 'unknown' : finish,
        }),
      );
    }

    db.prepare(
      `INSERT OR REPLACE INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, NULL)`,
    ).run(sid, seq);
  });

  transaction();

  return {
    target: 'opencode',
    sessionId: sid,
    path: db.name,
    messageCount: importable.length,
  };
}

function v2ToolState(pair: ToolPair, input: unknown): Record<string, unknown> {
  const stateInput = toolInput(input);
  const result = pair.result;

  if (!result) {
    return {
      status: 'error',
      input: stateInput,
      error: {
        type: 'tool.execution',
        message: 'No tool output captured (imported session).',
      },
      metadata: { truncated: false },
    };
  }

  if (result.isError) {
    return {
      status: 'error',
      input: stateInput,
      error: {
        type: 'tool.execution',
        message: result.content || 'Tool call failed.',
      },
      metadata: { truncated: result.truncated === true },
    };
  }

  return {
    status: 'completed',
    input: stateInput,
    content: [{ type: 'text', text: result.content ?? '' }],
    metadata: { truncated: result.truncated === true },
  };
}

export class OpenCodeImporter implements Importer {
  readonly target = 'opencode';
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath =
      dbPath ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  }

  importSession(session: SessionIR): ImportResult {
    if (!existsSync(this.dbPath)) {
      throw new Error(
        `OpenCode database not found at ${this.dbPath}. Is OpenCode installed?`,
      );
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
      // OpenCode 2 no longer reads the legacy `session`/`message`/`part`
      // projection. Detect it once and write the tables it actually uses.
      if (hasTable(db, 'session_v2') && hasTable(db, 'session_message')) {
        const result = importIntoV2(db, session, now);
        db.close();
        return result;
      }

      const sid = opencodeSessionId(session.createdAt || now);
      const slug = opencodeSlug();
      const ts = now;

      // Match the schema version OpenCode itself is writing, not a pinned one.
      const versionRow = db
        .prepare(
          'SELECT version FROM session ORDER BY time_created DESC LIMIT 1',
        )
        .get() as { version: string } | undefined;
      const version = versionRow?.version || '1.18.9';

      // Use the current OpenCode model instead of source model
      const currentModel = db
        .prepare(
          "SELECT model FROM session WHERE json_extract(model, '$.providerID') != ? ORDER BY time_created DESC LIMIT 1",
        )
        .get('anthropic') as { model: string } | undefined;

      let providerID: string;
      let modelID: string;
      let variant: string;

      if (currentModel) {
        const parsed = JSON.parse(currentModel.model) as {
          id: string;
          providerID: string;
          variant?: string;
        };
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

      const modelJson = JSON.stringify(
        variant
          ? { id: modelID, providerID, variant }
          : { id: modelID, providerID },
      );

      const totalTokens = {
        input: session.messages.reduce((s, m) => s + (m.tokens?.input || 0), 0),
        output: session.messages.reduce(
          (s, m) => s + (m.tokens?.output || 0),
          0,
        ),
        reasoning: session.messages.reduce(
          (s, m) => s + (m.tokens?.reasoning || 0),
          0,
        ),
        cacheRead: session.messages.reduce(
          (s, m) => s + (m.tokens?.cacheRead || 0),
          0,
        ),
        cacheWrite: session.messages.reduce(
          (s, m) => s + (m.tokens?.cacheWrite || 0),
          0,
        ),
        total: session.messages.reduce((s, m) => s + (m.tokens?.total || 0), 0),
      };

      // A session ported from another machine can carry a directory that does not
      // exist here; OpenCode resolves the session directory at prompt time and fails
      // the whole turn if it is missing.
      const cwd =
        session.cwd && existsSync(session.cwd) ? session.cwd : process.cwd();
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
            cache: {
              read: totalTokens.cacheRead,
              write: totalTokens.cacheWrite,
            },
          },
          title: session.title,
          agent,
          model: variant
            ? { id: modelID, providerID, variant }
            : { id: modelID, providerID },
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

        const insertEvent = db.prepare(
          `INSERT OR IGNORE INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)`,
        );
        const insertEventSeq = db.prepare(
          `INSERT OR REPLACE INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, ?)`,
        );
        const updateEventSeq = db.prepare(
          `UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?`,
        );

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
          sid,
          'global',
          null,
          null,
          slug,
          dirPath,
          relPath,
          session.title,
          version,
          modelJson,
          agent,
          tsCreated,
          tsUpdated,
          0,
          totalTokens.input,
          totalTokens.output,
          totalTokens.reasoning,
          totalTokens.cacheRead,
          totalTokens.cacheWrite,
          0,
          0,
          0,
        );

        // OpenCode's assistant messages point at the user message that opened the turn.
        let lastUserMsgId = '';
        let msgCount = 0;

        const toolResults = collectToolResults(session);
        const importable = session.messages.filter(
          (m) =>
            m.role !== 'system' &&
            m.role !== 'developer' &&
            renderableParts(m.parts).length > 0,
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
              (msg.tokens?.input || 0) +
                (msg.tokens?.output || 0) +
                (msg.tokens?.reasoning || 0),
            input: msg.tokens?.input || 0,
            output: msg.tokens?.output || 0,
            reasoning: msg.tokens?.reasoning || 0,
            cache: {
              write: msg.tokens?.cacheWrite || 0,
              read: msg.tokens?.cacheRead || 0,
            },
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
            msgInfo.model = variant
              ? { providerID, modelID, variant }
              : { providerID, modelID };
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

          const ordered: Array<{ part: PartIR; pair?: ToolPair }> = parts.map(
            (part) =>
              part.kind === 'tool_call'
                ? {
                    part,
                    pair: { call: part, result: toolResults.get(part.id) },
                  }
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
              data: JSON.stringify(
                eventPartData(data, opcId, mid, sid, partTs),
              ),
            });
          };

          // Assistant turns in OpenCode open with a step-start part…
          if (msgRole === 'assistant') emitPart({ type: 'step-start' });

          let partSeq = 0;

          for (const { part, pair } of ordered) {
            const callId =
              pair?.call.id || `call_${mid.slice(4, 16)}_${partSeq}`;
            const partTs = messageSeq.next();
            emitPart(partToOpenCodeData(part, callId, partTs, pair), partTs);
            partSeq++;
          }

          // …and close with a step-finish, which is where OpenCode reads the turn's
          // usage from. An assistant turn without one reads as still running.
          if (msgRole === 'assistant') {
            emitPart({
              type: 'step-finish',
              reason: msgInfo.finish,
              tokens,
              cost: 0,
            });
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
          insertEvent.run(
            evt.id,
            evt.aggregate_id,
            evt.seq,
            evt.type,
            evt.data,
          );
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
          (m) =>
            m.role !== 'system' &&
            m.role !== 'developer' &&
            renderableParts(m.parts).length > 0,
        ).length,
      };
    } catch (err) {
      db.close();
      throw err;
    }
  }
}
