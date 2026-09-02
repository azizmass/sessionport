/**
 * Tool vocabularies differ between tools. Claude Code calls its file reader `Read`
 * and passes `file_path`; OpenCode calls the same tool `read` and passes `filePath`.
 * A ported session that keeps the source spelling shows up in the target as an
 * unrecognised tool with unreadable arguments — the call is preserved but the UI
 * cannot render it, because it looks its arguments up by the names it expects.
 *
 * So a tool call is translated on the way in: the name to the target's spelling,
 * and the argument keys that genuinely mean the same thing on both sides. Keys with
 * no counterpart are left exactly as they were, and a tool this table does not know
 * — an MCP tool, a plugin, anything newer than this file — passes through untouched.
 * Guessing a mapping is worse than leaving the original.
 */

export type ToolVocabulary = 'claude' | 'opencode';

interface ToolSpec {
  claude: string;
  opencode: string;
  /** Argument names that differ but mean the same thing, written claude → opencode. */
  args?: Record<string, string>;
  /** Other spellings the same tool has gone by, accepted on the way in. */
  aliases?: string[];
}

// Every entry here was checked against real sessions from both tools rather than
// from documentation, so the argument names are the ones actually written to disk.
const TOOLS: ToolSpec[] = [
  { claude: 'Read', opencode: 'read', args: { file_path: 'filePath' } },
  { claude: 'Write', opencode: 'write', args: { file_path: 'filePath' } },
  {
    claude: 'Edit',
    opencode: 'edit',
    args: {
      file_path: 'filePath',
      old_string: 'oldString',
      new_string: 'newString',
      replace_all: 'replaceAll',
    },
    aliases: ['MultiEdit'],
  },
  // command / description / timeout are spelled the same on both sides.
  { claude: 'Bash', opencode: 'bash' },
  { claude: 'Glob', opencode: 'glob' },
  // Claude filters matched files with `glob`, OpenCode with `include`.
  { claude: 'Grep', opencode: 'grep', args: { glob: 'include' } },
  { claude: 'TodoWrite', opencode: 'todowrite' },
  // `url` is shared. Claude's `prompt` and OpenCode's `format` are not the same
  // thing, so neither is renamed into the other.
  { claude: 'WebFetch', opencode: 'webfetch' },
  { claude: 'WebSearch', opencode: 'websearch' },
  { claude: 'Agent', opencode: 'task', aliases: ['Task'] },
  { claude: 'AskUserQuestion', opencode: 'question' },
];

interface Resolved {
  spec: ToolSpec;
  from: ToolVocabulary;
}

const BY_NAME = new Map<string, Resolved>();
for (const spec of TOOLS) {
  BY_NAME.set(spec.claude.toLowerCase(), { spec, from: 'claude' });
  for (const alias of spec.aliases ?? []) BY_NAME.set(alias.toLowerCase(), { spec, from: 'claude' });
  // The OpenCode spelling wins where the two collide only in case, which is the
  // normal situation: `read` and `Read` are the same tool seen from either side.
  BY_NAME.set(spec.opencode.toLowerCase(), { spec, from: 'opencode' });
}

function renameKeys(input: Record<string, unknown>, rename: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[rename.get(key) ?? key] = value;
  }
  return out;
}

export interface TranslatedTool {
  name: string;
  input: unknown;
}

/**
 * Render a tool call in the target tool's vocabulary. Unknown tools, and inputs that
 * are not keyed objects, come back unchanged.
 */
export function translateToolCall(name: string, input: unknown, target: ToolVocabulary): TranslatedTool {
  const resolved = BY_NAME.get(name.toLowerCase());
  if (!resolved) return { name, input };

  const { spec } = resolved;
  const targetName = target === 'claude' ? spec.claude : spec.opencode;

  if (!spec.args || !input || typeof input !== 'object' || Array.isArray(input)) {
    return { name: targetName, input };
  }

  const pairs = Object.entries(spec.args);
  const rename = new Map(target === 'claude' ? pairs.map(([c, o]) => [o, c] as const) : pairs);
  return { name: targetName, input: renameKeys(input as Record<string, unknown>, rename) };
}

/** The name alone, for callers that have no arguments to translate. */
export function translateToolName(name: string, target: ToolVocabulary): string {
  return translateToolCall(name, undefined, target).name;
}

/**
 * Both Claude and OpenCode require a tool call's input to be a keyed object — Claude
 * rejects the whole session with `tool_use.input: Input should be an object` — while
 * Codex writes its `exec` input as a bare code string. A JSON object arrives parsed;
 * anything else is wrapped rather than dropped.
 */
export function toolInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fall through to the wrapped form
      }
    }
    return trimmed.length > 0 ? { input: raw } : {};
  }
  if (raw === undefined || raw === null) return {};
  return { input: raw };
}
