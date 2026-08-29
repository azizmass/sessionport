import { existsSync, readFileSync } from 'fs';
import type { SessionIR } from './types.js';

/** A plan as Claude Code recorded it when leaving plan mode. */
export interface PlanIR {
  /** The plan body, as markdown. */
  text: string;
  /** Heading of the plan, for titling the exported session or file. */
  title: string;
  /** Where Claude Code kept the plan on disk, when it said. */
  filePath?: string;
  /** When the plan was proposed. */
  timestamp: number;
  /** Message the plan was proposed in. */
  messageId: string;
}

/**
 * Claude Code emits a plan as the input of the tool call that leaves plan mode.
 * Older sessions use the snake_case spelling.
 */
const PLAN_TOOLS = new Set(['exitplanmode', 'exit_plan_mode']);

function planInput(raw: unknown): { plan?: string; planFilePath?: string } {
  if (typeof raw === 'string') {
    try {
      return planInput(JSON.parse(raw));
    } catch {
      return { plan: raw };
    }
  }
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  return {
    plan: typeof o.plan === 'string' ? o.plan : undefined,
    planFilePath: typeof o.planFilePath === 'string' ? o.planFilePath : undefined,
  };
}

/** First markdown heading, else the first non-empty line. */
export function planTitle(text: string, fallback: string, maxLen = 80): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.replace(/^#{1,6}\s+/, '').trim();
    if (!heading) continue;
    return heading.length > maxLen ? heading.slice(0, maxLen) + '…' : heading;
  }
  return fallback;
}

/**
 * Every plan in a session, oldest first. A session can hold several: each
 * revision of a plan is proposed with its own tool call.
 */
export function extractPlans(session: SessionIR): PlanIR[] {
  const plans: PlanIR[] = [];

  for (const msg of session.messages) {
    for (const part of msg.parts) {
      if (part.kind !== 'tool_call') continue;
      if (!PLAN_TOOLS.has(part.name.toLowerCase())) continue;

      const { plan, planFilePath } = planInput(part.input);
      // The tool call carries the plan text; fall back to the file it names,
      // which survives on disk for sessions whose input was not recorded.
      let text = plan ?? '';
      if (!text.trim() && planFilePath && existsSync(planFilePath)) {
        try {
          text = readFileSync(planFilePath, 'utf-8');
        } catch {
          // unreadable — treated as a plan with no body below
        }
      }
      if (!text.trim()) continue;

      plans.push({
        text: text.trim(),
        title: planTitle(text, session.title),
        filePath: planFilePath,
        timestamp: msg.timestamp,
        messageId: msg.id,
      });
    }
  }

  return plans;
}

/** The plans to export: every revision, or just the one that was settled on. */
export function selectPlans(plans: PlanIR[], all = false): PlanIR[] {
  if (all || plans.length === 0) return plans;
  return [plans[plans.length - 1]];
}
