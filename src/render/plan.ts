import type { PlanIR } from '../ir/plan.js';
import type { SessionIR, MessageIR } from '../ir/types.js';
import { formatSessionTime } from '../ir/normalize.js';

export interface PlanRenderOptions {
  /** Number the plans as revisions — used when a session holds more than one. */
  revisions?: boolean;
}

function provenance(session: SessionIR, plan: PlanIR): string {
  const when = formatSessionTime(plan.timestamp || session.updatedAt);
  return `Ported from the ${session.sourceTool} session "${session.title}" (plan made ${when}).`;
}

/** The plan as a standalone markdown document, with a line saying where it came from. */
export function renderPlanMarkdown(
  session: SessionIR,
  plans: PlanIR[],
  options?: PlanRenderOptions,
): string {
  const lines: string[] = [];
  const multiple = options?.revisions ?? plans.length > 1;

  lines.push(provenance(session, plans[0]));
  if (session.cwd) lines.push(`Working directory: \`${session.cwd}\``);
  lines.push('');

  plans.forEach((plan, i) => {
    if (multiple) {
      lines.push(`<!-- revision ${i + 1} of ${plans.length} -->`);
      lines.push('');
    }
    lines.push(plan.text);
    lines.push('');
    if (multiple && i < plans.length - 1) {
      lines.push('---');
      lines.push('');
    }
  });

  return lines.join('\n');
}

/**
 * A session carrying nothing but the plan, ready for an importer. The plan
 * arrives as the user's opening message so the target tool treats it as the
 * brief to work from rather than as something it already said.
 */
export function planSession(
  session: SessionIR,
  plans: PlanIR[],
  options?: PlanRenderOptions,
): SessionIR {
  if (plans.length === 0) {
    throw new Error('No plan to export.');
  }

  const latest = plans[plans.length - 1];
  const timestamp = latest.timestamp || session.updatedAt || Date.now();

  const message: MessageIR = {
    id: `msg_plan_${timestamp}`,
    role: 'user',
    timestamp,
    parts: [{ kind: 'text', text: renderPlanMarkdown(session, plans, options) }],
  };

  return {
    id: `${session.id}_plan`,
    sourceTool: session.sourceTool,
    sourcePath: session.sourcePath,
    title: latest.title,
    cwd: session.cwd,
    model: session.model,
    createdAt: plans[0].timestamp || timestamp,
    updatedAt: timestamp,
    messages: [message],
    metadata: {
      plan: true,
      planCount: plans.length,
      originalSessionId: session.id,
      originalTitle: session.title,
      ...(latest.filePath ? { planFilePath: latest.filePath } : {}),
    },
  };
}
