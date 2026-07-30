import type { SessionIR } from '../ir/types.js';

export interface ImportResult {
  target: string;
  sessionId?: string;
  path?: string;
  messageCount: number;
}

export interface Importer<T = unknown> {
  readonly target: string;
  importSession(session: SessionIR, options?: T): ImportResult;
}
