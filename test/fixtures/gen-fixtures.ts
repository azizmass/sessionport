import { existsSync } from 'fs';
import Database from 'better-sqlite3';

/**
 * OpenCode 2's schema: the legacy event-sourced tables are gone and the current
 * conversation is projected into `session_v2` + `session_message`.
 */
export function createOpenCodeV2Fixture(dbPath: string): void {
  if (existsSync(dbPath)) return;

  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
      icon_url TEXT, icon_url_override TEXT, icon_color TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_initialized INTEGER, time_active INTEGER DEFAULT 0 NOT NULL,
      time_archived INTEGER, sandboxes TEXT NOT NULL, commands TEXT
    );
    CREATE TABLE IF NOT EXISTS session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT,
      parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT,
      version TEXT NOT NULL, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      revert TEXT, permission TEXT, agent TEXT, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_busy INTEGER, time_idle INTEGER, time_viewed INTEGER,
      idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER,
      time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_sequence (
      aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT
    );
  `);

  const now = Date.now();
  db.prepare(
    `INSERT INTO project (id, worktree, vcs, sandboxes, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('proj-v2', '/home/user/project', 'git', '[]', now - 60000, now);

  db.prepare(
    `INSERT INTO session_v2
       (id, project_id, slug, directory, title, version, model, agent,
        tokens_input, tokens_output, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'ses_v2fixture',
    'proj-v2',
    'v2-session',
    '/home/user/project',
    'Test OpenCode v2 Session',
    '2.2.5',
    JSON.stringify({ id: 'glm-5.2', providerID: 'opencode-go' }),
    'build',
    300,
    60,
    now - 60000,
    now,
  );

  const insertMessage = db.prepare(
    'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  insertMessage.run(
    'msg_v2_001',
    'ses_v2fixture',
    'user',
    1,
    now - 50000,
    now,
    JSON.stringify({
      time: { created: now - 50000 },
      text: 'How does authentication work?',
      files: [],
      agents: [],
    }),
  );

  insertMessage.run(
    'msg_v2_002',
    'ses_v2fixture',
    'assistant',
    2,
    now - 40000,
    now,
    JSON.stringify({
      time: { created: now - 40000, completed: now - 38000 },
      agent: 'build',
      model: { id: 'glm-5.2', providerID: 'opencode-go' },
      content: [
        { type: 'reasoning', text: 'Let me look at the auth setup.' },
        { type: 'text', text: 'Reading the file.' },
        {
          type: 'tool',
          id: 'call_v2_001',
          name: 'bash',
          executed: false,
          state: {
            status: 'completed',
            input: { command: 'cat auth.py' },
            content: [{ type: 'text', text: 'def auth(): pass\n' }],
            metadata: { truncated: false },
          },
          time: { created: now - 40000, completed: now - 39000 },
        },
      ],
      tokens: { input: 300, output: 60, reasoning: 10, cache: { read: 0, write: 0 } },
      cost: 0,
      finish: 'tool-calls',
    }),
  );

  insertMessage.run(
    'msg_v2_003',
    'ses_v2fixture',
    'user',
    3,
    now - 30000,
    now,
    JSON.stringify({
      time: { created: now - 30000 },
      text: 'Implement the auth function please.',
      files: [],
      agents: [],
    }),
  );

  // A session too new to have a title: the list must fall back to its last text.
  db.prepare(
    `INSERT INTO session_v2
       (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'ses_v2untitled',
    'proj-v2',
    'v2-untitled',
    '/home/user/project',
    'New session - 2026-01-01T00:00:00.000Z',
    '2.2.5',
    now - 20000,
    now - 10000,
  );

  insertMessage.run(
    'msg_v2_004',
    'ses_v2untitled',
    'user',
    1,
    now - 10000,
    now,
    JSON.stringify({
      time: { created: now - 10000 },
      text: 'Explain the billing adapter.',
      files: [],
      agents: [],
    }),
  );

  db.close();
}

export function createOpenCodeFixture(dbPath: string): void {
  if (existsSync(dbPath)) return;

  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'proj-001',
      workspace_id TEXT, parent_id TEXT,
      slug TEXT NOT NULL DEFAULT 'test',
      directory TEXT NOT NULL DEFAULT '/home/user/project',
      path TEXT, title TEXT NOT NULL DEFAULT 'Test OpenCode Session',
      version TEXT NOT NULL DEFAULT '1.0', metadata TEXT,
      cost REAL DEFAULT 0,
      tokens_input INTEGER DEFAULT 500, tokens_output INTEGER DEFAULT 100,
      tokens_reasoning INTEGER DEFAULT 0,
      tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0,
      agent TEXT, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_compacting INTEGER, time_archived INTEGER,
      summary_additions INTEGER, summary_deletions INTEGER,
      summary_files INTEGER, summary_diffs TEXT,
      share_url TEXT, revert TEXT, permission TEXT
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  const now = Date.now();
  const sid = 'test-opencode-001';

  db.prepare(`INSERT INTO session (id,project_id,slug,directory,title,version,model,time_created,time_updated)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    sid, 'proj-test', 'test-session', '/home/user/project',
    'Test OpenCode Session', '1.0',
    JSON.stringify({ providerID: 'opencode-go', modelID: 'glm-5.2', variant: 'max' }),
    now - 60000, now,
  );

  const m1 = 'msg-oc-001', m2 = 'msg-oc-002', m3 = 'msg-oc-003';

  db.prepare(`INSERT INTO message VALUES (?,?,?,?,?)`).run(m1, sid, now - 50000, now - 50000,
    JSON.stringify({ role: 'user', parentID: null, time: { created: now - 50000 }, model: { providerID: 'opencode-go', modelID: 'glm-5.2' }, tokens: { input: 100, output: 0 }, finish: null }));
  db.prepare(`INSERT INTO message VALUES (?,?,?,?,?)`).run(m2, sid, now - 40000, now - 40000,
    JSON.stringify({ role: 'assistant', parentID: m1, time: { created: now - 40000, completed: now - 38000 }, model: { providerID: 'opencode-go', modelID: 'glm-5.2' }, tokens: { total: 500, input: 200, output: 300 }, finish: 'end_turn' }));
  db.prepare(`INSERT INTO message VALUES (?,?,?,?,?)`).run(m3, sid, now - 30000, now - 30000,
    JSON.stringify({ role: 'user', parentID: m2, time: { created: now - 30000 }, model: { providerID: 'opencode-go', modelID: 'glm-5.2' }, tokens: { total: 150, input: 150, output: 0 }, finish: null }));

  db.prepare(`INSERT INTO part VALUES (?,?,?,?,?,?)`).run('prt-oc-001', m1, sid, now - 50000, now - 50000,
    JSON.stringify({ type: 'text', text: 'How does authentication work?' }));
  db.prepare(`INSERT INTO part VALUES (?,?,?,?,?,?)`).run('prt-oc-002', m2, sid, now - 40000, now - 40000,
    JSON.stringify({ type: 'reasoning', text: 'Let me think about the auth setup.' }));
  db.prepare(`INSERT INTO part VALUES (?,?,?,?,?,?)`).run('prt-oc-003', m2, sid, now - 39000, now - 39000,
    JSON.stringify({ type: 'tool', tool: 'bash', callID: 'call-oc-001', state: { status: 'completed', input: { command: 'cat auth.py' }, output: 'def auth(): pass\n' } }));
  db.prepare(`INSERT INTO part VALUES (?,?,?,?,?,?)`).run('prt-oc-004', m2, sid, now - 38000, now - 38000,
    JSON.stringify({ type: 'text', text: 'The auth module has a basic structure.' }));
  db.prepare(`INSERT INTO part VALUES (?,?,?,?,?,?)`).run('prt-oc-005', m3, sid, now - 30000, now - 30000,
    JSON.stringify({ type: 'text', text: 'Implement the auth function please.' }));

  db.close();
}
