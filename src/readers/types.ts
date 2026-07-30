import type { SessionIR } from '../ir/types.js';

export interface SessionSummary {
  id: string;
  title: string;
  tool: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  path: string;
}

export interface Reader {
  readonly tool: string;
  listSessions(): SessionSummary[];
  readSession(id: string): SessionIR;
}
