# sessionport

**Port AI coding sessions between tools** — Claude Code ↔ OpenCode ↔ Codex.

Export, import, compact, list, inspect, and migrate sessions. Works as a CLI or as a
programmatic TypeScript library.

```
npx sessionport                  # interactive wizard
sp list claude                   # shorthand alias
sessionport export claude <id> --to markdown --mode compacted
sessionport import claude <id> opencode
sessionport inspect opencode <id> --mode compacted
```

## Install

```bash
npm install -g sessionport
```

Or without installing:

```bash
npx sessionport list claude
```

## CLI Commands

### `sessionport list <source>`

List all sessions from a tool.

```bash
sessionport list claude
sessionport list opencode
sessionport list codex
```

### `sessionport export <source> <id>`

Export a session to file.

| Option | Default | Description |
|---|---|---|
| `-t, --to` | `markdown` | Output format: `json`, `markdown`, `opencode`, `claude`, `codex`, `generic` |
| `-m, --mode` | `as-is` | `as-is` (full) or `compacted` (summarized) |
| `-o, --out` | `./export` | Output directory |
| `-q, --quiet` | — | Suppress progress output |

```bash
sessionport export claude <id> --to markdown
sessionport export opencode <id> --to json --mode compacted
sessionport export codex <id> --to codex --out ./backup
```

### `sessionport export-all <source>`

Export every session from a tool at once.

```bash
sessionport export-all claude --to markdown
sessionport export-all opencode --to json --out ./opencode-sessions
```

### `sessionport import <source> <id> <target>`

Import a session directly into another tool's database.

```bash
sessionport import claude <id> opencode
sessionport import opencode <id> claude
sessionport import codex <id> opencode --mode compacted
```

Supports Claude JSONL, OpenCode SQLite (`session`, `message`, `part`, `event`,
`event_sequence` tables), and Codex rollout JSONL.

### `sessionport inspect <source> <id>`

Preview a session as formatted markdown in the terminal.

```bash
sessionport inspect claude <id>
sessionport inspect opencode <id> --mode as-is
```

### `sessionport convert <file>`

Convert a raw session file without scanning source directories.

```bash
sessionport convert session.jsonl --from claude --to markdown
sessionport convert rollout.jsonl --from codex --to json
```

### `sessionport cleanup opencode`

Remove orphaned sessions from OpenCode (sessions with no event history).

```bash
sessionport cleanup opencode          # delete all orphans
sessionport cleanup opencode --dry-run  # list without deleting
```

### Interactive wizard

Run with no arguments to launch the interactive prompt:

```bash
sessionport
```

Walks you through: source tool → pick a session → export/import mode → target → output.

## Modes

| Mode | Description |
|---|---|
| `as-is` | Full fidelity — all messages, tool calls, outputs, reasoning |
| `compacted` | Tool calls → one-liners, tool outputs → `[N lines, ok]`, reasoning truncated, system/meta noise removed |

## Export Targets

| Target | Output | Use case |
|---|---|---|
| `json` | `.session.json` — full IR, machine-readable | Programmatic processing |
| `markdown` | `.md` — readable transcript | Sharing, review, documentation |
| `opencode` | `.seed.md` — context handoff prompt | Paste as first message in OpenCode |
| `claude` | `.seed.md` — context handoff prompt | Paste as first message in Claude Code |
| `codex` | `.seed.md` — context handoff prompt | Paste as first message in Codex CLI |
| `generic` | `.seed.md` — model-agnostic handoff prompt | Paste into any AI chat |

## Import Targets

| Source → Target | Format |
|---|---|
| Claude Code → OpenCode | Writes directly to `~/.local/share/opencode/opencode.db` (event-sourced, all 5 tables) |
| OpenCode → Claude Code | Writes JSONL to `~/.claude/projects/<slug>/<uuid>.jsonl` |
| Claude Code → Codex | Writes rollout JSONL + index to `~/.codex/sessions/` |
| Codex → OpenCode | Writes directly to OpenCode SQLite |
| OpenCode → Codex | Writes rollout JSONL + index |
| Codex → Claude Code | Writes JSONL to Claude projects directory |

## Supported Sources

- **Claude Code** — reads `~/.claude/projects/*/*.jsonl`
- **OpenCode** — reads `~/.local/share/opencode/opencode.db` (SQLite)
- **Codex** — reads `~/.codex/session_index.jsonl` + rollout JSONLs

## Programmatic Usage

```typescript
import { ClaudeReader, OpenCodeReader, CodexReader } from 'sessionport/readers/*';
import { ClaudeImporter, OpenCodeImporter, CodexImporter } from 'sessionport/importers/*';
import { compactSession } from 'sessionport/render/*';
import { renderJson, renderMarkdown, renderSeed } from 'sessionport/render/*';

// Read
const reader = new ClaudeReader();
const sessions = reader.listSessions();
const session = reader.readSession(sessions[0].id);

// Compact
const compacted = compactSession(session);

// Export
const json = renderJson(compacted);
const md = renderMarkdown(session, { compacted: false });
const seed = renderSeed(session, 'opencode');

// Import into OpenCode
const importer = new OpenCodeImporter();
const result = importer.importSession(session);
// { target: 'opencode', sessionId: 'ses_...', path: '...', messageCount: 42 }
```

## ID Generators

```typescript
import {
  opencodeSessionId, opencodeMessageId, opencodePartId, opencodeEventId, opencodeSlug,
  claudeUuid, claudeProjectSlug,
  codexSessionId, codexTurnId, codexCallId, codexToolCallId,
} from 'sessionport/importers/*';
```

## Architecture

```
source (native format)
  └─ reader ──> SessionIR (canonical model)
                   ├─ compactor ──> SessionIR (compacted)
                   └─ renderers ──> json / markdown / seed prompts
```

The **Intermediate Representation (SessionIR)** normalizes all tool formats into:

```
Session → Message[] (role: user/assistant/system)
         → Part[] (text / reasoning / tool_call / tool_result / file / agent)
```

### Database Safety

- OpenCode imports create a backup at `opencode.db.sessionport-backup` before writing.
- Full transactional insert — if any event fails, nothing is committed.
- Cleans up orphaned sessions that have no event history via `sessionport cleanup opencode`.

## npm Publishing

```bash
# 1. Build and test
npm run build && npm test

# 2. Bump version
npm version patch  # or minor / major

# 3. Publish
npm publish
```

Requires an npm account and login (`npm login`).

## License

MIT
