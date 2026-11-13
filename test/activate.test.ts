import { describe, it, expect } from 'vitest';
import { activationCommand } from '../src/cli/activate.js';
import type { ImportResult } from '../src/importers/types.js';

function result(overrides: Partial<ImportResult> = {}): ImportResult {
  return { target: 'claude', sessionId: 'abc-123', cwd: '/tmp/project', messageCount: 1, ...overrides };
}

describe('activation command', () => {
  it('opens each target on the imported session from its directory', () => {
    expect(activationCommand('claude', result())).toBe(
      'cd /tmp/project && claude --resume abc-123',
    );
    expect(activationCommand('opencode', result())).toBe(
      'cd /tmp/project && opencode --session abc-123',
    );
    expect(activationCommand('codex', result())).toBe('cd /tmp/project && codex resume abc-123');
  });

  it('quotes paths the shell would split', () => {
    expect(activationCommand('claude', result({ cwd: '/tmp/my project' }))).toBe(
      "cd '/tmp/my project' && claude --resume abc-123",
    );
  });

  it('omits cd when the importer has no directory', () => {
    expect(activationCommand('opencode', result({ cwd: undefined }))).toBe(
      'opencode --session abc-123',
    );
  });

  it('has nothing to activate for an export target', () => {
    expect(activationCommand('markdown', result())).toBeUndefined();
  });
});
