import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { ClaudeReader } from '../src/readers/claude.js';
import { extractPlans, selectPlans, planTitle } from '../src/ir/plan.js';
import { planSession, renderPlanMarkdown } from '../src/render/plan.js';
import type { SessionIR } from '../src/ir/types.js';

const CLAUDE_PROJECTS = join(import.meta.dirname, 'fixtures', 'claude-projects');

function planSessionFixture(): SessionIR {
  return new ClaudeReader(CLAUDE_PROJECTS).readSession('claude-plan');
}

describe('planTitle', () => {
  it('uses the first markdown heading', () => {
    expect(planTitle('# Refactor auth\n\nbody', 'fallback')).toBe('Refactor auth');
  });

  it('falls back to the first non-empty line', () => {
    expect(planTitle('\n\nrewrite the parser\nmore', 'fallback')).toBe('rewrite the parser');
  });

  it('falls back to the given title for an empty plan', () => {
    expect(planTitle('   \n', 'fallback')).toBe('fallback');
  });

  it('truncates a long heading', () => {
    const title = planTitle('# ' + 'a'.repeat(120), 'fallback', 20);
    expect(title).toHaveLength(21);
    expect(title).toMatch(/…$/);
  });
});

describe('extractPlans', () => {
  it('finds every plan revision, oldest first', () => {
    const plans = extractPlans(planSessionFixture());
    expect(plans).toHaveLength(2);
    expect(plans[0].title).toBe('Refactor auth');
    expect(plans[1].title).toBe('Refactor auth, take two');
    expect(plans[0].timestamp).toBeLessThan(plans[1].timestamp);
  });

  it('keeps the plan file path when the tool call named one', () => {
    const plans = extractPlans(planSessionFixture());
    expect(plans[0].filePath).toBe('/home/aziz/.claude/plans/refactor-auth.md');
    expect(plans[1].filePath).toBeUndefined();
  });

  it('returns nothing for a session that never used plan mode', () => {
    const session = new ClaudeReader(CLAUDE_PROJECTS).readSession('claude-test');
    expect(extractPlans(session)).toEqual([]);
  });
});

describe('selectPlans', () => {
  it('keeps only the final revision by default', () => {
    const plans = extractPlans(planSessionFixture());
    expect(selectPlans(plans).map((p) => p.title)).toEqual(['Refactor auth, take two']);
  });

  it('keeps every revision when asked', () => {
    const plans = extractPlans(planSessionFixture());
    expect(selectPlans(plans, true)).toHaveLength(2);
  });

  it('handles a session with no plan', () => {
    expect(selectPlans([])).toEqual([]);
  });
});

describe('renderPlanMarkdown', () => {
  it('states where the plan came from and keeps the body verbatim', () => {
    const session = planSessionFixture();
    const plans = selectPlans(extractPlans(session));
    const md = renderPlanMarkdown(session, plans);
    expect(md).toMatch(/^Ported from the claude session/);
    expect(md).toContain('# Refactor auth, take two');
    expect(md).toContain('2. Move session checks behind it');
    expect(md).not.toContain('revision 1 of');
  });

  it('marks revisions when several plans are exported', () => {
    const session = planSessionFixture();
    const md = renderPlanMarkdown(session, extractPlans(session));
    expect(md).toContain('<!-- revision 1 of 2 -->');
    expect(md).toContain('<!-- revision 2 of 2 -->');
  });
});

describe('planSession', () => {
  it('builds a one-message session titled after the plan', () => {
    const session = planSessionFixture();
    const plans = selectPlans(extractPlans(session));
    const ir = planSession(session, plans);

    expect(ir.title).toBe('Refactor auth, take two');
    expect(ir.messages).toHaveLength(1);
    expect(ir.messages[0].role).toBe('user');
    expect(ir.messages[0].parts[0]).toMatchObject({ kind: 'text' });
    expect(ir.metadata).toMatchObject({ plan: true, planCount: 1, originalSessionId: session.id });
    expect(ir.cwd).toBe(session.cwd);
  });

  it('refuses to build a session with no plan', () => {
    expect(() => planSession(planSessionFixture(), [])).toThrow(/No plan/);
  });
});
