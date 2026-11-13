import type { ImportResult } from '../importers/types.js';

/** Quote a path or id only when the shell would otherwise split it. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The one command that continues the session just written. Both Claude and
 * OpenCode list sessions per project, so the directory is part of the answer.
 */
export function activationCommand(target: string, result: ImportResult): string | undefined {
  if (!result.sessionId) return undefined;

  const id = shellQuote(result.sessionId);
  let command: string;
  switch (target) {
    case 'claude':
      command = `claude --resume ${id}`;
      break;
    case 'opencode':
      command = `opencode --session ${id}`;
      break;
    case 'codex':
      command = `codex resume ${id}`;
      break;
    default:
      return undefined;
  }

  return result.cwd ? `cd ${shellQuote(result.cwd)} && ${command}` : command;
}

export function printActivation(target: string, result: ImportResult): void {
  const command = activationCommand(target, result);
  if (command) console.log(`   Activate: ${command}`);
}
