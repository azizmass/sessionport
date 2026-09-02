import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { unlinkSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ClaudeReader } from '../src/readers/claude.js';
import { CodexReader } from '../src/readers/codex.js';
import { OpenCodeReader } from '../src/readers/opencode.js';
import { compactSession } from '../src/render/compact.js';
import { renderJson } from '../src/render/json.js';
import { renderMarkdown } from '../src/render/markdown.js';
import { renderSeed } from '../src/render/seeds.js';
import { createOpenCodeFixture } from './fixtures/gen-fixtures.js';
import { displayTitle } from '../src/ir/normalize.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const OPENCODE_DB = join(FIXTURES, 'opencode-test.db');
const CLAUDE_PROJECTS = join(FIXTURES, 'claude-projects');
const CODEX_ROOT = join(FIXTURES, 'codex-root');

describe('ClaudeReader', () => {
  it('lists sessions from fixture dir', () => {
    const reader = new ClaudeReader(CLAUDE_PROJECTS);
    const sessions = reader.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const s = sessions.find((s) => s.id === 'claude-test');
    expect(s).toBeDefined();
    if (s) {
      expect(s.title).toBeTruthy();
      expect(s.tool).toBe('claude');
    }
  });

  it('titles a session from the first real prompt, past the meta preamble', () => {
    const reader = new ClaudeReader(CLAUDE_PROJECTS);
    const s = reader.listSessions().find((s) => s.id === 'claude-noisy');
    expect(s).toBeDefined();
    expect(s!.title).toBe('Fix the session list titles');
    expect(s!.lastMessage).toBe('Done — titles now fall back sensibly.');
    expect(s!.model).toBe('claude-opus-5');
  });

  it('leaves sessions with no real prompt untitled, with a last message to fall back on', () => {
    const reader = new ClaudeReader(CLAUDE_PROJECTS);
    const s = reader.listSessions().find((s) => s.id === 'claude-blank');
    expect(s).toBeDefined();
    expect(s!.title).toBe('Untitled Session');
    expect(s!.lastMessage).toBeUndefined();
    expect(displayTitle(s!)).toMatch(/^Untitled · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('gives a read session a timestamp label when nothing titleable exists', () => {
    const reader = new ClaudeReader(CLAUDE_PROJECTS);
    expect(reader.readSession('claude-blank').title).toMatch(/^Untitled · /);
    expect(reader.readSession('claude-noisy').title).toBe('Fix the session list titles');
  });

  it('reads a session', () => {
    const reader = new ClaudeReader(CLAUDE_PROJECTS);
    const session = reader.readSession('claude-test');
    expect(session.id).toBe('test-session-001');
    expect(session.sourceTool).toBe('claude');
    expect(session.messages.length).toBe(4);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].parts[0]).toHaveProperty('kind', 'text');
    expect(session.messages[1].parts).toHaveLength(2);
    expect(session.messages[1].parts[1]).toHaveProperty('kind', 'tool_call');
    expect(session.model?.id).toBe('claude-opus-5');
  });

  it('prefers the name Claude gave the session over its first prompt', () => {
    const reader = new ClaudeReader(CLAUDE_PROJECTS);
    const titled = reader.listSessions().find((s) => s.id === 'claude-titled');
    expect(titled?.title).toBe('Refactor the billing adapter');
    // The first prompt is what it would otherwise have fallen back to.
    expect(reader.readSession('claude-titled').title).toBe('Refactor the billing adapter');
  });

  it('flags only the sessions that recorded a plan', () => {
    const reader = new ClaudeReader(CLAUDE_PROJECTS);
    const sessions = reader.listSessions();
    const flagged = sessions.filter((s) => s.hasPlan).map((s) => s.id);
    expect(flagged).toEqual(['claude-plan']);
    // Every other fixture must be a definite false, not undefined.
    for (const s of sessions.filter((s) => s.id !== 'claude-plan')) {
      expect(s.hasPlan).toBe(false);
    }
  });

  it('reads from a file path', () => {
    const reader = new ClaudeReader(CLAUDE_PROJECTS);
    const fp = join(CLAUDE_PROJECTS, 'test-project', 'claude-test.jsonl');
    const session = reader.readFromFile(fp);
    expect(session.id).toBe('test-session-001');
    expect(session.messages.length).toBe(4);
  });
});

describe('CodexReader', () => {
  it('reads a codex session from file', () => {
    const reader = new CodexReader(CODEX_ROOT);
    const fp = join(FIXTURES, 'codex-test.jsonl');
    const session = reader.readFromFile(fp);
    expect(session.id).toBe('test-codex-001');
    expect(session.sourceTool).toBe('codex');
    expect(session.messages.length).toBe(3);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].parts.some((p) => p.kind === 'reasoning')).toBe(true);
    expect(session.messages[1].parts.some((p) => p.kind === 'tool_call')).toBe(true);
    expect(session.model?.provider).toBe('openai');
  });

  it('reads a tool output written as a bare string', () => {
    const dir = join(tmpdir(), 'sessionport-codex-' + randomUUID().slice(0, 8));
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, 'rollout.jsonl');
    // Codex writes a shell tool's output as a list of blocks most of the time and
    // as a plain string sometimes; assuming the list shape threw on the string one.
    writeFileSync(
      fp,
      [
        JSON.stringify({
          timestamp: '2026-07-25T09:13:02.242Z',
          type: 'session_meta',
          payload: { session_id: 'codex-str-001', cwd: '/tmp', model_provider: 'openai' },
        }),
        JSON.stringify({
          timestamp: '2026-07-25T09:13:20.219Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
        }),
        JSON.stringify({
          timestamp: '2026-07-25T09:14:01.000Z',
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: 'ls' },
        }),
        JSON.stringify({
          timestamp: '2026-07-25T09:14:02.000Z',
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'Wall time 11.0 seconds\nOutput:\n' },
        }),
      ].join('\n'),
    );

    const session = new CodexReader(dir).readFromFile(fp);
    const result = session.messages.flatMap((m) => m.parts).find((p) => p.kind === 'tool_result');
    expect(result).toBeDefined();
    expect((result as { content: string }).content).toContain('Wall time 11.0 seconds');
    rmSync(dir, { recursive: true, force: true });
  });

  it('titles a session by the name Codex gave the thread', () => {
    const dir = join(tmpdir(), 'sessionport-codex-' + randomUUID().slice(0, 8));
    mkdirSync(join(dir, 'sessions', '2026', '07', '25'), { recursive: true });
    const rollout = join(dir, 'sessions', '2026', '07', '25', 'rollout-2026-07-25T09-13-02-codex-named-001.jsonl');
    writeFileSync(
      rollout,
      [
        JSON.stringify({
          timestamp: '2026-07-25T09:13:02.242Z',
          type: 'session_meta',
          payload: { session_id: 'codex-named-001', cwd: '/tmp', model_provider: 'openai' },
        }),
        // Codex opens a thread with an environment block. Flattened, it reads as a
        // cwd, a shell and a timezone — which is what ported sessions were named.
        JSON.stringify({
          timestamp: '2026-07-25T09:13:20.219Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '<environment_context>\n <cwd>/tmp</cwd>\n <shell>bash</shell>\n</environment_context>' },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-25T09:13:21.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please look at the deploy' }] },
        }),
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'session_index.jsonl'),
      JSON.stringify({
        id: 'codex-named-001',
        thread_name: 'Verify Kubernetes deployment',
        updated_at: '2026-07-25T09:20:00.000Z',
      }),
    );

    const reader = new CodexReader(dir);
    expect(reader.readSession('codex-named-001').title).toBe('Verify Kubernetes deployment');

    // Without an indexed name, the environment block must still not become the title.
    writeFileSync(join(dir, 'session_index.jsonl'), '');
    expect(new CodexReader(dir).readSession('codex-named-001').title).toBe('please look at the deploy');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('OpenCodeReader', () => {
  beforeAll(() => {
    createOpenCodeFixture(OPENCODE_DB);
  });

  it('lists sessions', () => {
    const reader = new OpenCodeReader(OPENCODE_DB);
    const sessions = reader.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const s = sessions.find((s) => s.id === 'test-opencode-001');
    expect(s).toBeDefined();
    if (s) expect(s.title).toBe('Test OpenCode Session');
  });

  it('reads a session', () => {
    const reader = new OpenCodeReader(OPENCODE_DB);
    const session = reader.readSession('test-opencode-001');
    expect(session.id).toBe('test-opencode-001');
    expect(session.messages.length).toBe(3);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].parts[0]).toHaveProperty('kind', 'text');
    expect(session.messages[1].parts[0]).toHaveProperty('kind', 'reasoning');
    expect(session.messages[1].parts[1]).toHaveProperty('kind', 'tool_call');
    expect(session.model?.id).toBe('glm-5.2');
  });
});

describe('Compactor', () => {
  const reader = new ClaudeReader(CLAUDE_PROJECTS);
  let session: ReturnType<typeof reader.readSession>;

  beforeAll(() => {
    session = reader.readSession('claude-test');
  });

  it('compacts reasoning', () => {
    const compacted = compactSession(session, { reasoningMaxChars: 20 });
    const reasoning = compacted.messages.find((m) =>
      m.parts.some((p) => p.kind === 'reasoning'),
    );
    expect(reasoning).toBeDefined();
    const rp = reasoning!.parts.find((p) => p.kind === 'reasoning');
    if (rp && rp.kind === 'reasoning') {
      expect(rp.text).toContain('[reasoning truncated');
    }
  });

  it('compacts tool results', () => {
    const compacted = compactSession(session, { includeToolOutput: false });
    const tr = compacted.messages.find((m) =>
      m.parts.some((p) => p.kind === 'tool_result'),
    );
    expect(tr).toBeDefined();
    const tp = tr!.parts.find((p) => p.kind === 'tool_result');
    if (tp && tp.kind === 'tool_result') {
      expect(tp.content).not.toContain('def auth');
    }
  });

  it('retains full text in compacted mode', () => {
    const compacted = compactSession(session);
    const textParts = compacted.messages.flatMap((m) =>
      m.parts.filter((p) => p.kind === 'text'),
    );
    expect(textParts.length).toBeGreaterThan(0);
  });
});

describe('Renderers', () => {
  const reader = new ClaudeReader(CLAUDE_PROJECTS);
  let session: ReturnType<typeof reader.readSession>;

  beforeAll(() => {
    session = reader.readSession('claude-test');
  });

  it('renders JSON', () => {
    const json = renderJson(session);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe('test-session-001');
    expect(parsed.messages).toHaveLength(4);
  });

  it('renders markdown', () => {
    const md = renderMarkdown(session);
    expect(md).toContain('test-session-001');
    expect(md).toContain('claude-opus-5');
    expect(md).toContain('What is the authentication flow?');
  });

  it('renders compacted markdown', () => {
    const compacted = compactSession(session);
    const md = renderMarkdown(compacted, { compacted: true });
    expect(md).toContain('compacted');
  });

  it('renders seed for opencode', () => {
    const seed = renderSeed(session, 'opencode');
    expect(seed).toContain('Context Handoff');
    expect(seed).toContain('claude');
    expect(seed).toContain('opencode');
  });

  it('renders seed for claude', () => {
    const seed = renderSeed(session, 'claude');
    expect(seed).toContain('Context Handoff');
    expect(seed).toContain('claude');
  });

  it('renders seed for codex', () => {
    const seed = renderSeed(session, 'codex');
    expect(seed).toContain('Context Handoff');
    expect(seed).toContain('codex');
  });

  it('renders seed for generic', () => {
    const seed = renderSeed(session, 'generic');
    expect(seed).toContain('Context Handoff');
    expect(seed).toContain('generic');
  });
});
