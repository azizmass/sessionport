import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { ClaudeImporter } from '../src/importers/claude.js';
import { CodexImporter } from '../src/importers/codex.js';
import { OpenCodeImporter } from '../src/importers/opencode.js';
import {
  opencodeSessionId, opencodeMessageId, opencodePartId, opencodeSlug, opencodeIdTimestamp,
  claudeUuid, claudeProjectSlug, codexSessionId, codexTurnId, codexCallId, codexToolCallId,
} from '../src/importers/ids.js';
import type { SessionIR } from '../src/ir/types.js';
import { ClaudeReader } from '../src/readers/claude.js';
import { extractPlans, selectPlans } from '../src/ir/plan.js';
import { planSession } from '../src/render/plan.js';

interface EventRow {
  id: string;
  aggregate_id: string;
  seq: number;
  type: string;
  data: string;
}

function makeMinimalSession(overrides: Partial<SessionIR> = {}): SessionIR {
  return {
    id: 'test-import-001',
    sourceTool: 'claude',
    title: 'Test Import Session',
    cwd: '/test/project',
    createdAt: Date.now(),
    model: { id: 'claude-opus-5', provider: 'anthropic' },
    messages: [
      {
        role: 'user' as const,
        parts: [{ kind: 'text' as const, text: 'Hello' }],
      },
      {
        role: 'assistant' as const,
        parts: [
          { kind: 'reasoning' as const, text: 'Let me think about this...' },
          { kind: 'text' as const, text: 'Here is the answer.' },
        ],
      },
      {
        role: 'user' as const,
        parts: [{ kind: 'text' as const, text: 'Explain more.' }],
      },
      {
        role: 'assistant' as const,
        parts: [
          {
            kind: 'tool_call' as const,
            id: 'toolu_abc123',
            name: 'execute_command',
            input: { command: 'ls -la' },
          },
        ],
      },
      {
        role: 'tool' as const,
        parts: [
          {
            kind: 'tool_result' as const,
            toolCallId: 'toolu_abc123',
            content: 'total 42\n-rw-r--r--  1 user staff  1024 Jan 1 12:00 file.txt',
            isError: false,
          },
        ],
      },
      {
        role: 'assistant' as const,
        parts: [{ kind: 'text' as const, text: 'Done.' }],
      },
    ],
    ...overrides,
  };
}

describe('ID generators', () => {
  it('generates valid opencode session IDs', () => {
    const id = opencodeSessionId();
    expect(id).toMatch(/^ses_[a-zA-Z0-9]{26}$/);
  });

  it('generates valid opencode message IDs', () => {
    const id = opencodeMessageId();
    expect(id).toMatch(/^msg_[a-zA-Z0-9]{26}$/);
  });

  it('generates valid opencode part IDs', () => {
    const id = opencodePartId();
    expect(id).toMatch(/^prt_[a-zA-Z0-9]{26}$/);
  });

  it('generates opencode slugs', () => {
    const slug = opencodeSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('generates opencode ids that sort in creation order', () => {
    const ids = [1000, 1000, 1001, 2000].map((ts) => opencodeMessageId(ts));
    expect([...ids].sort()).toEqual(ids);
    const parts = [opencodePartId(500), opencodePartId(500), opencodePartId(501)];
    expect([...parts].sort()).toEqual(parts);
  });

  it('encodes timestamps the way opencode does', () => {
    // Real id OpenCode wrote for a message whose time.created was this value.
    const realId = 'msg_fb28eef2200135pJOBxyiyRU8O';
    const ts = 1785407139618;
    expect(opencodeMessageId(ts).slice(4, 16)).toBe(realId.slice(4, 16));
    // OpenCode keeps only the low 48 bits of `ts * 4096 + counter`, so the decoded
    // timestamp is ts modulo 2^36 — matching its own Identifier.timestamp().
    expect(opencodeIdTimestamp(opencodeMessageId(ts))).toBe(ts % 2 ** 36);
    expect(opencodeIdTimestamp(realId)).toBe(ts % 2 ** 36);
  });

  it('generates descending opencode session ids', () => {
    const older = opencodeSessionId(1000);
    const newer = opencodeSessionId(2000);
    expect(newer < older).toBe(true);
  });

  it('generates valid UUIDs for claude', () => {
    const uuid = claudeUuid();
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates claude project slugs from cwd', () => {
    const slug = claudeProjectSlug('/home/user/my-project');
    expect(slug).toBe('-home-user-my-project');
  });

  it('generates codex session IDs', () => {
    const id = codexSessionId();
    expect(id).toMatch(/^019/);
    expect(id.length).toBeGreaterThan(30);
  });

  it('generates codex turn IDs', () => {
    const id = codexTurnId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates codex call IDs', () => {
    const id = codexCallId();
    expect(id).toMatch(/^call_/);
    expect(id.length).toBe(29);
  });

  it('generates codex tool call IDs', () => {
    const id = codexToolCallId();
    expect(id).toMatch(/^ctc_/);
    expect(id.length).toBe(28);
  });
});

describe('ClaudeImporter', () => {
  const tmpDir = join(tmpdir(), 'sessionport-test-claude-' + randomUUID().slice(0, 8));

  beforeAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports a session as JSONL', () => {
    const session = makeMinimalSession();
    const importer = new ClaudeImporter(tmpDir);
    const result = importer.importSession(session);
    expect(result.target).toBe('claude');
    expect(result.messageCount).toBe(6);
    expect(existsSync(result.path)).toBe(true);

    const content = readFileSync(result.path, 'utf-8').trim();
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe('mode');
  });

  it('creates session ID in the filename', () => {
    const session = makeMinimalSession();
    const importer = new ClaudeImporter(tmpDir);
    const result = importer.importSession(session);
    expect(result.path).toContain(result.sessionId);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates valid Claude JSONL events', () => {
    const session = makeMinimalSession();
    const importer = new ClaudeImporter(tmpDir);
    const result = importer.importSession(session);
    const content = readFileSync(result.path, 'utf-8').trim();
    const lines = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const userMsgs = lines.filter((l) => l.type === 'user');
    const assistantMsgs = lines.filter((l) => l.type === 'assistant');
    expect(userMsgs.length).toBe(2);
    expect(assistantMsgs.length).toBe(3);

    const toolAssistant = assistantMsgs[1];
    expect(toolAssistant.message.content.some((c: Record<string, unknown>) => c.type === 'tool_use')).toBe(true);
    const toolUse = toolAssistant.message.content.find((c: Record<string, unknown>) => c.type === 'tool_use');
    expect(toolUse.name).toBe('execute_command');
  });

  it('keeps each message at its own time rather than the import time', () => {
    const base = Date.UTC(2026, 0, 15, 9, 30, 0);
    const session = makeMinimalSession({ createdAt: base });
    session.messages.forEach((m, i) => {
      m.timestamp = base + i * 60_000;
    });
    const result = new ClaudeImporter(tmpDir).importSession(session);
    const events = readFileSync(result.path, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'user' || e.type === 'assistant');

    const stamps = events.map((e) => e.timestamp);
    expect(new Set(stamps).size).toBe(stamps.length);
    expect(stamps[0]).toBe(new Date(base).toISOString());
    expect(stamps).toEqual([...stamps].sort());
  });

  it('falls back to the session start for messages with no time of their own', () => {
    const base = Date.UTC(2026, 0, 15, 9, 30, 0);
    const session = makeMinimalSession({ createdAt: base });
    const result = new ClaudeImporter(tmpDir).importSession(session);
    const first = readFileSync(result.path, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'user');
    expect(first.timestamp).toBe(new Date(base).toISOString());
  });

  it('carries the session title over as an ai-title event', () => {
    const session = makeMinimalSession({ title: 'Ported session name' });
    const result = new ClaudeImporter(tmpDir).importSession(session);
    const events = readFileSync(result.path, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const title = events.find((e) => e.type === 'ai-title');
    expect(title).toBeDefined();
    expect(title.aiTitle).toBe('Ported session name');
    expect(title.sessionId).toBe(result.sessionId);
  });

  it('writes the fields Claude puts on every conversation event', () => {
    const session = makeMinimalSession();
    const result = new ClaudeImporter(tmpDir).importSession(session);
    const events = readFileSync(result.path, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'user' || e.type === 'assistant');

    for (const e of events) {
      expect(e.isSidechain).toBe(false);
      expect(e.userType).toBe('external');
      expect(e.session_id).toBe(result.sessionId);
      expect(e.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // Explicit null, not an absent key: the first message is the root.
    expect(events[0].parentUuid).toBeNull();
    expect('parentUuid' in events[0]).toBe(true);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].parentUuid).toBe(events[i - 1].uuid);
    }
  });

  it('keeps tool results that arrived in the assistant message', () => {
    // OpenCode packs the call and its result into one assistant message;
    // Claude expects the result in the user turn that follows.
    const session = makeMinimalSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          timestamp: Date.now(),
          parts: [
            { kind: 'tool_call', id: 'toolu_x1', name: 'read_file', input: { path: 'a.ts' } },
            { kind: 'tool_result', toolCallId: 'toolu_x1', content: 'file body', isError: false },
          ],
        },
      ],
    } as Partial<SessionIR>);

    const result = new ClaudeImporter(tmpDir).importSession(session);
    const events = readFileSync(result.path, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    const assistant = events.find((e) => e.type === 'assistant');
    expect(assistant.message.content.some((c: { type: string }) => c.type === 'tool_use')).toBe(true);

    const carrier = events.find(
      (e) =>
        e.type === 'user' &&
        Array.isArray(e.message?.content) &&
        e.message.content.some((c: { type: string }) => c.type === 'tool_result'),
    );
    expect(carrier).toBeDefined();
    expect(carrier.parentUuid).toBe(assistant.uuid);
    const block = carrier.message.content[0];
    expect(block.tool_use_id).toBe('toolu_x1');
    expect(block.content).toBe('file body');
    expect(block.is_error).toBe(false);
  });

  it('anchors resume at the final message', () => {
    const session = makeMinimalSession();
    const result = new ClaudeImporter(tmpDir).importSession(session);
    const events = readFileSync(result.path, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const conv = events.filter((e) => e.type === 'user' || e.type === 'assistant');
    const anchor = events.find((e) => e.type === 'last-prompt');
    expect(anchor.leafUuid).toBe(conv[conv.length - 1].uuid);
  });

  it('writes sessionId in every event', () => {
    const session = makeMinimalSession();
    const importer = new ClaudeImporter(tmpDir);
    const result = importer.importSession(session);
    const content = readFileSync(result.path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const line of lines) {
      expect(line.sessionId).toBe(result.sessionId);
    }
  });
});

describe('CodexImporter', () => {
  const tmpDir = join(tmpdir(), 'sessionport-test-codex-' + randomUUID().slice(0, 8));

  beforeAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports a session as rollout JSONL', () => {
    const session = makeMinimalSession();
    const importer = new CodexImporter(tmpDir);
    const result = importer.importSession(session);
    expect(result.target).toBe('codex');
    expect(result.messageCount).toBe(6);
    expect(existsSync(result.path)).toBe(true);

    const content = readFileSync(result.path, 'utf-8').trim();
    const lines = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);

    const header = lines[0];
    expect(header.type).toBe('session_meta');
  });

  it('creates session index file', () => {
    const session = makeMinimalSession();
    const importer = new CodexImporter(tmpDir);
    const result = importer.importSession(session);
    const indexPath = join(tmpDir, 'session_index.jsonl');
    expect(existsSync(indexPath)).toBe(true);
    const lines = readFileSync(indexPath, 'utf-8').trim().split('\n').filter(Boolean);
    const idx = JSON.parse(lines[lines.length - 1]);
    expect(idx.id).toBe(result.sessionId);
    expect(idx.thread_name).toBe('Test Import Session');
  });
});


const tmpDir = join(tmpdir(), 'sessionport-test-opencode-' + randomUUID().slice(0, 8));

function createTestDb(): string {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const dbPath = join(tmpDir, 'opencode.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY
    );
    INSERT OR IGNORE INTO project (id) VALUES ('global');
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id),
      workspace_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, path TEXT,
      title TEXT, version TEXT, model TEXT, agent TEXT,
      time_created INTEGER, time_updated INTEGER,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      FOREIGN KEY (project_id) REFERENCES project(id)
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id),
      time_created INTEGER, time_updated INTEGER, data TEXT,
      FOREIGN KEY (session_id) REFERENCES session(id)
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY, message_id TEXT REFERENCES message(id),
      session_id TEXT REFERENCES session(id),
      time_created INTEGER, time_updated INTEGER, data TEXT,
      FOREIGN KEY (message_id) REFERENCES message(id),
      FOREIGN KEY (session_id) REFERENCES session(id)
    );
    CREATE TABLE IF NOT EXISTS event (
      id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL,
      seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_sequence (
      aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT
    );
  `);
  db.close();
  return dbPath;
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('OpenCodeImporter', () => {

  it('leaves a ported conversation on the working agent', () => {
    const dbPath = createTestDb();
    const result = new OpenCodeImporter(dbPath).importSession(makeMinimalSession());
    const db = new Database(dbPath);
    const row = db.prepare('SELECT agent FROM session WHERE id = ?').get(result.sessionId) as {
      agent: string;
    };
    // 'plan' is read-only in OpenCode; a resumed session must be able to edit.
    expect(row.agent).toBe('build');
    db.close();
  });

  it('imports a plan-only session that opencode can open in plan mode', () => {
    const dbPath = createTestDb();
    const source = new ClaudeReader(
      join(import.meta.dirname, 'fixtures', 'claude-projects'),
    ).readSession('claude-plan');
    const ir = planSession(source, selectPlans(extractPlans(source)));

    const result = new OpenCodeImporter(dbPath).importSession(ir);
    expect(result.target).toBe('opencode');
    expect(result.messageCount).toBe(1);

    const db = new Database(dbPath);
    const row = db
      .prepare('SELECT title, agent FROM session WHERE id = ?')
      .get(result.sessionId) as { title: string; agent: string };
    expect(row.title).toBe('Refactor auth, take two');
    // Only plan exports get the plan agent.
    expect(row.agent).toBe('plan');

    const parts = db
      .prepare(
        `SELECT json_extract(data, '$.type') AS type, json_extract(data, '$.text') AS text
         FROM part WHERE session_id = ?`,
      )
      .all(result.sessionId) as { type: string; text: string }[];
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('# Refactor auth, take two');
    expect(parts[0].text).toContain('Ported from the claude session');
    db.close();
  });

  it('imports a session into opencode.db', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const session = makeMinimalSession();
    const result = importer.importSession(session);
    expect(result.target).toBe('opencode');
    // The tool-result-only message is merged into the call that produced it.
    expect(result.messageCount).toBe(5);
    expect(result.path).toBe(dbPath);

    const db = new Database(dbPath);
    const sessions = db.prepare('SELECT * FROM session').all();
    expect(sessions.length).toBe(1);
    const s = sessions[0] as Record<string, unknown>;
    expect(s.title).toBe('Test Import Session');
    expect(s.slug).toMatch(/^[a-z]+-[a-z]+$/);

    const messages = db.prepare('SELECT * FROM message WHERE session_id = ?').all(result.sessionId);
    expect(messages.length).toBe(5);

    // 5 content parts + one step-start per assistant message (3).
    const parts = db.prepare('SELECT * FROM part WHERE session_id = ?').all(result.sessionId);
    expect(parts.length).toBe(9);

    db.close();
  });

  it('orders messages and parts by both time_created and id', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    // Sessions whose source has no per-message timestamps must still come back in order.
    const result = importer.importSession(makeMinimalSession());

    const db = new Database(dbPath);
    const messages = db.prepare(
      'SELECT id, time_created FROM message WHERE session_id = ? ORDER BY time_created, id',
    ).all(result.sessionId) as { id: string; time_created: number }[];

    const roles = messages.map(
      (m) => JSON.parse((db.prepare('SELECT data FROM message WHERE id = ?').get(m.id) as { data: string }).data).role,
    );
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'assistant']);

    const times = messages.map((m) => m.time_created);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);

    const ids = messages.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);

    const parts = db.prepare(
      'SELECT id FROM part WHERE session_id = ? ORDER BY time_created, id',
    ).all(result.sessionId) as { id: string }[];
    const partIds = parts.map((p) => p.id);
    expect([...partIds].sort()).toEqual(partIds);

    db.close();
  });

  it('writes messages OpenCode can load', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const result = importer.importSession(makeMinimalSession());

    const db = new Database(dbPath);
    const messages = db.prepare(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id',
    ).all(result.sessionId) as { id: string; data: string }[];

    for (const row of messages) {
      const info = JSON.parse(row.data);
      expect(info.id).toBe(row.id);
      expect(info.sessionID).toBe(result.sessionId);
      expect(info.time.created).toBeGreaterThan(0);

      if (info.role === 'assistant') {
        // All required by OpenCode's AssistantMessage schema.
        expect(info.parentID).toBeTruthy();
        expect(info.modelID).toBeTruthy();
        expect(info.providerID).toBeTruthy();
        expect(info.mode).toBeTruthy();
        expect(info.agent).toBeTruthy();
        expect(info.path.cwd).toBeTruthy();
        expect(info.path.root).toBeTruthy();
        expect(typeof info.cost).toBe('number');
        expect(typeof info.tokens.input).toBe('number');
        expect(typeof info.tokens.cache.read).toBe('number');
        // AI SDK vocabulary, never the source tool's own reason.
        expect(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'other']).toContain(info.finish);
      } else {
        expect(info.model.providerID).toBeTruthy();
        expect(info.model.modelID).toBeTruthy();
        expect(info.agent).toBeTruthy();
      }
    }

    // Assistant messages hang off the user message that opened the turn.
    const firstUser = JSON.parse(messages[0].data);
    expect(JSON.parse(messages[1].data).parentID).toBe(firstUser.id);

    db.close();
  });

  it('writes tool parts OpenCode can load', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const result = importer.importSession(makeMinimalSession());

    const db = new Database(dbPath);
    const parts = (db.prepare('SELECT data FROM part WHERE session_id = ?').all(result.sessionId) as { data: string }[])
      .map((p) => JSON.parse(p.data));

    const tools = parts.filter((p) => p.type === 'tool');
    expect(tools.length).toBe(1);
    const state = tools[0].state;
    expect(state.status).toBe('completed');
    // input must be an object, not a JSON string or a summary line
    expect(typeof state.input).toBe('object');
    expect(state.input.command).toBe('ls -la');
    expect(typeof state.output).toBe('string');
    expect(state.output).toContain('total 42');
    expect(typeof state.title).toBe('string');
    expect(typeof state.metadata).toBe('object');
    expect(state.time.start).toBeGreaterThan(0);
    expect(state.time.end).toBeGreaterThan(0);

    expect(parts.filter((p) => p.type === 'step-start').length).toBe(3);

    db.close();
  });

  it('marks tool calls without output as interrupted', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const session = makeMinimalSession();
    // Drop the tool result, as happens when a session is exported mid-tool-call.
    session.messages = session.messages.filter((m) => !m.parts.some((p) => p.kind === 'tool_result'));
    const result = importer.importSession(session);

    const db = new Database(dbPath);
    const tools = (db.prepare('SELECT data FROM part WHERE session_id = ?').all(result.sessionId) as { data: string }[])
      .map((p) => JSON.parse(p.data))
      .filter((p) => p.type === 'tool');

    expect(tools.length).toBe(1);
    expect(tools[0].state.status).toBe('error');
    expect(tools[0].state.metadata.interrupted).toBe(true);
    db.close();
  });

  it('normalizes source finish reasons', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const session = makeMinimalSession();
    session.messages[1].finishReason = 'end_turn';
    session.messages[3].finishReason = 'tool_use';
    const result = importer.importSession(session);

    const db = new Database(dbPath);
    const finishes = (db.prepare(
      'SELECT data FROM message WHERE session_id = ? ORDER BY time_created, id',
    ).all(result.sessionId) as { data: string }[])
      .map((m) => JSON.parse(m.data))
      .filter((m) => m.role === 'assistant')
      .map((m) => m.finish);

    expect(finishes[0]).toBe('stop');
    expect(finishes[1]).toBe('tool-calls');
    db.close();
  });

  it('imported parts have correct data', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const session = makeMinimalSession();
    const result = importer.importSession(session);

    const db = new Database(dbPath);
    const parts = db.prepare(
      'SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created ASC',
    ).all(result.sessionId) as { id: string; data: string }[];

    expect(parts.length).toBeGreaterThan(0);

    const textParts = parts.filter((p) => JSON.parse(p.data).type === 'text');
    expect(textParts.length).toBeGreaterThan(0);
    expect(JSON.parse(textParts[0].data).text).toBe('Hello');

    const reasoningParts = parts.filter((p) => JSON.parse(p.data).type === 'reasoning');
    expect(reasoningParts.length).toBe(1);
    expect(JSON.parse(reasoningParts[0].data).text).toBe('Let me think about this...');

    const toolParts = parts.filter((p) => JSON.parse(p.data).type === 'tool');
    expect(toolParts.length).toBeGreaterThan(0);
    const toolWithOutput = toolParts.find((p) => JSON.parse(p.data).state?.output);
    expect(toolWithOutput).toBeDefined();
    if (toolWithOutput) {
      const td = JSON.parse(toolWithOutput.data);
      expect(td.state.output).toContain('total 42');
    }

    db.close();
  });

  it('creates a backup of the existing database', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const session = makeMinimalSession();
    importer.importSession(session);
    expect(existsSync(dbPath + '.sessionport-backup')).toBe(true);
  });

  it('throws if database does not exist', () => {
    const missingPath = join(tmpDir, 'nonexistent.db');
    const importer = new OpenCodeImporter(missingPath);
    expect(() => importer.importSession(makeMinimalSession())).toThrow('OpenCode database not found');
  });

  it('writes events to the event table', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const session = makeMinimalSession();
    const result = importer.importSession(session);

    const db = new Database(dbPath);
    const events = db.prepare('SELECT * FROM event WHERE aggregate_id = ? ORDER BY seq ASC').all(result.sessionId) as EventRow[];
    expect(events.length).toBeGreaterThan(0);

    const first = events[0];
    expect(first.type).toBe('session.created.1');
    expect(first.seq).toBe(0);
    expect(first.id).toMatch(/^evt_[a-zA-Z0-9]{26}$/);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session.created.1');
    expect(types.filter((t) => t === 'message.updated.1').length).toBe(5);
    expect(types.filter((t) => t === 'message.part.updated.1').length).toBe(9);
    expect(types[types.length - 1]).toBe('session.updated.1');

    const sessionCreated = JSON.parse(events[0].data);
    expect(sessionCreated.sessionID).toBe(result.sessionId);
    expect(sessionCreated.info.title).toBe('Test Import Session');
    expect(sessionCreated.info.slug).toMatch(/^[a-z]+-[a-z]+$/);
    expect(sessionCreated.info.model).toBeDefined();
    expect(sessionCreated.info.model.id).toBe('claude-opus-5');

    db.close();
  });

  it('writes event_sequence entry', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const session = makeMinimalSession();
    const result = importer.importSession(session);

    const db = new Database(dbPath);
    const seqRow = db.prepare('SELECT * FROM event_sequence WHERE aggregate_id = ?').get(result.sessionId) as { aggregate_id: string; seq: number } | undefined;
    expect(seqRow).toBeDefined();
    if (seqRow) {
      const eventCount = db.prepare('SELECT COUNT(*) as c FROM event WHERE aggregate_id = ?').get(result.sessionId) as { c: number };
      expect(seqRow.seq).toBe(eventCount.c - 1);
    }
    db.close();
  });

  it('event data matches projection data', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const session = makeMinimalSession();
    const result = importer.importSession(session);

    const db = new Database(dbPath);
    const msgEvents = db.prepare("SELECT data FROM event WHERE aggregate_id = ? AND type = 'message.updated.1' ORDER BY seq ASC").all(result.sessionId) as { data: string }[];
    expect(msgEvents.length).toBe(5);

    const firstMsg = JSON.parse(msgEvents[0].data);
    expect(firstMsg.info.role).toBe('user');
    // A ported conversation lands on the working agent, not the read-only one.
    expect(firstMsg.info.agent).toBe('build');

    const partEvents = db.prepare("SELECT data FROM event WHERE aggregate_id = ? AND type = 'message.part.updated.1' ORDER BY seq ASC").all(result.sessionId) as { data: string }[];
    expect(partEvents.length).toBe(9);

    const firstPart = JSON.parse(partEvents[0].data);
    expect(firstPart.part.type).toBe('text');

    const toolEvents = partEvents.filter((e) => JSON.parse(e.data).part.type === 'tool');
    expect(toolEvents.length).toBeGreaterThan(0);
    const toolWithOutput = toolEvents.find((e) => JSON.parse(e.data).part.state?.output);
    expect(toolWithOutput).toBeDefined();
    if (toolWithOutput) {
      const toolData = JSON.parse(toolWithOutput.data);
      expect(toolData.part.state.status).toBe('completed');
      expect(toolData.part.state.output).toContain('total 42');
    }

    db.close();
  });

  it('generates valid IDs for all tables', () => {
    const dbPath = createTestDb();
    const importer = new OpenCodeImporter(dbPath);
    const session = makeMinimalSession();
    const result = importer.importSession(session);

    expect(result.sessionId).toMatch(/^ses_[a-zA-Z0-9]{26}$/);

    const db = new Database(dbPath);
    const messages = db.prepare('SELECT id FROM message WHERE session_id = ?').all(result.sessionId) as { id: string }[];
    for (const m of messages) {
      expect(m.id).toMatch(/^msg_[a-zA-Z0-9]{26}$/);
    }

    const parts = db.prepare('SELECT id FROM part WHERE session_id = ?').all(result.sessionId) as { id: string }[];
    for (const p of parts) {
      expect(p.id).toMatch(/^prt_[a-zA-Z0-9]{26}$/);
    }

    db.close();
  });
});

describe('tool vocabulary translation', () => {
  const claudeOutDir = join(tmpdir(), 'sessionport-test-tools-' + randomUUID().slice(0, 8));
  afterAll(() => {
    rmSync(claudeOutDir, { recursive: true, force: true });
  });

  const claudeToolSession = () =>
    makeMinimalSession({
      messages: [
        { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Read it.' }] },
        {
          role: 'assistant' as const,
          parts: [
            {
              kind: 'tool_call' as const,
              id: 'toolu_read1',
              name: 'Read',
              input: { file_path: '/tmp/notes.md', limit: 20 },
            },
            {
              kind: 'tool_call' as const,
              id: 'toolu_grep1',
              name: 'Grep',
              input: { pattern: 'TODO', path: '/tmp', glob: '*.ts' },
            },
            {
              kind: 'tool_call' as const,
              id: 'toolu_mcp1',
              name: 'mcp__acme__do_thing',
              input: { some_key: 1 },
            },
          ],
        },
      ],
    });

  const openCodeToolSession = () =>
    makeMinimalSession({
      sourceTool: 'opencode' as const,
      messages: [
        { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Edit it.' }] },
        {
          role: 'assistant' as const,
          parts: [
            {
              kind: 'tool_call' as const,
              id: 'call_edit1',
              name: 'edit',
              input: { filePath: '/tmp/a.ts', oldString: 'a', newString: 'b', replaceAll: true },
            },
            {
              kind: 'tool_call' as const,
              id: 'call_web1',
              name: 'webfetch',
              input: { url: 'https://example.com', format: 'text' },
            },
          ],
        },
      ],
    });

  function openCodeToolParts(sessionIR: SessionIR) {
    const dbPath = createTestDb();
    const result = new OpenCodeImporter(dbPath).importSession(sessionIR);
    const db = new Database(dbPath);
    const parts = (db.prepare('SELECT data FROM part WHERE session_id = ?').all(result.sessionId) as { data: string }[])
      .map((r) => JSON.parse(r.data))
      .filter((p) => p.type === 'tool');
    db.close();
    return parts;
  }

  function claudeToolBlocks(sessionIR: SessionIR) {
    const dir = join(claudeOutDir, randomUUID());
    mkdirSync(dir, { recursive: true });
    const result = new ClaudeImporter(dir).importSession(sessionIR);
    return readFileSync(result.path!, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'assistant')
      .flatMap((e) => (e.message?.content ?? []) as { type: string; name?: string; input?: Record<string, unknown> }[])
      .filter((b) => b.type === 'tool_use');
  }

  it('renames Claude tools and arguments to the OpenCode spelling', () => {
    const parts = openCodeToolParts(claudeToolSession());

    const read = parts.find((p) => p.tool === 'read');
    expect(read).toBeDefined();
    expect(read.state.input.filePath).toBe('/tmp/notes.md');
    expect(read.state.input.file_path).toBeUndefined();
    // A key that is spelled the same on both sides is left alone.
    expect(read.state.input.limit).toBe(20);

    const grep = parts.find((p) => p.tool === 'grep');
    expect(grep.state.input.include).toBe('*.ts');
    expect(grep.state.input.glob).toBeUndefined();
    expect(grep.state.input.pattern).toBe('TODO');
  });

  it('renames OpenCode tools and arguments to the Claude spelling', () => {
    const blocks = claudeToolBlocks(openCodeToolSession());

    const edit = blocks.find((b) => b.name === 'Edit');
    expect(edit).toBeDefined();
    expect(edit!.input).toEqual({
      file_path: '/tmp/a.ts',
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    });

    // `url` is shared, but OpenCode's `format` has no Claude counterpart and
    // must not be renamed into Claude's `prompt`, which means something else.
    const fetch = blocks.find((b) => b.name === 'WebFetch');
    expect(fetch!.input).toEqual({ url: 'https://example.com', format: 'text' });
  });

  it('leaves tools it does not know untouched', () => {
    const parts = openCodeToolParts(claudeToolSession());
    const mcp = parts.find((p) => p.tool === 'mcp__acme__do_thing');
    expect(mcp).toBeDefined();
    expect(mcp.state.input.some_key).toBe(1);
  });

});
