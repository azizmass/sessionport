import { homedir } from 'os';
import { join } from 'path';

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

export function opencodeDbPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

export function codexDir(): string {
  return join(homedir(), '.codex');
}

export function codexIndexPath(): string {
  return join(codexDir(), 'session_index.jsonl');
}
