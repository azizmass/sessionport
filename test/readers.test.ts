import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { ClaudeReader } from '../src/readers/claude.js';
import { CodexReader } from '../src/readers/codex.js';
import { OpenCodeReader } from '../src/readers/opencode.js';
import { compactSession } from '../src/render/compact.js';
import { renderJson } from '../src/render/json.js';
import { renderMarkdown } from '../src/render/markdown.js';
import { renderSeed } from '../src/render/seeds.js';
import { createOpenCodeFixture } from './fixtures/gen-fixtures.js';

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
