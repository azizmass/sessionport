import type { SessionIR } from '../ir/types.js';

export function renderJson(session: SessionIR): string {
  return JSON.stringify(session, null, 2);
}
