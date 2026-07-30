import { existsSync } from 'fs';
import Database from 'better-sqlite3';

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
