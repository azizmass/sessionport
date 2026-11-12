import type { SessionIR } from '../ir/types.js';

export interface ImportResult {
  target: string;
  sessionId?: string;
  path?: string;
  /** Directory the target tool must be opened from to see the session. */
  cwd?: string;
  messageCount: number;
}

export interface Importer<T = unknown> {
  readonly target: string;
  importSession(session: SessionIR, options?: T): ImportResult;
}
