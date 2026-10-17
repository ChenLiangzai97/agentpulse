# OpenCode session observation

OpenCode v1 SQLite sessions can be observed alongside Claude Code, Codex CLI,
and Copilot CLI. OpenCode is **observe-only**: AgentPulse cannot start, resume,
prompt, or answer permissions/questions for it. BotMux keeps control of its processes
and plugins, including `botmux-ask.js`.

## Enable on the machine containing OpenCode's database

Set in the AgentPulse server environment (or `.env`), then restart the server:

```dotenv
AGENTPULSE_OPENCODE_ENABLED=true
# Optional; defaults to $XDG_DATA_HOME/opencode/opencode.db, or
# ~/.local/share/opencode/opencode.db when XDG_DATA_HOME is unset:
# AGENTPULSE_OPENCODE_DB=/absolute/path/to/opencode.db
# Optional stable identity for this source, useful across path/hostname changes:
# AGENTPULSE_OPENCODE_INSTANCE_ID=my-opencode-source
```

Setting `AGENTPULSE_OPENCODE_DB` also enables observation. Unset both options to
stop observation; imported records remain. Keep instance identity stable across
restarts. Different instances with identical native IDs stay separate.

For a one-time import into the configured AgentPulse database:

```bash
bun scripts/observe-opencode.ts
# Standalone ongoing importer (do not also enable the server observer):
bun scripts/observe-opencode.ts --watch
```

The server polls every three seconds. The first pass imports existing sessions;
subsequent passes read changed sessions, messages and parts using an inclusive
update-time watermark. Restarting replays the source; durable session/part keys
update existing rows instead of adding duplicates. Tool transitions from running
to completed retain their event ID and count once. WebSocket updates carry part
revision timestamps so stale REST responses cannot overwrite newer tool results.

The source connection is read-only and uses short SQLite snapshots that finish
before destination writes, allowing OpenCode's WAL writer to continue. The source
schema is validated before reads. Missing databases or unsupported schemas produce
a warning and retry without taking down AgentPulse. This adapter was verified
against the local v1 schema; OpenCode V2 and other schemas require a separate adapter.

## Collected data and status

- Native session/message/part IDs, title, directory/project, model, parent reference,
  agent, session costs and input/output/reasoning/cache token totals.
- User and assistant text; tool name, call ID, arguments, output/error and final
  status; step-finish cost/token records. Reasoning is omitted.
- BotMux hidden context is stripped from timeline text used by search and summaries.
  Original part data stays in raw payload for inspection. `botmux send` commands and
  their output remain tool evidence.
- Active unfinished assistant messages or pending/running tools are working while
  recently updated. A latest user message without running work is marked waiting.
  Older inactive sessions are idle; idle never implies business completion.
- Source archives are reflected in `isArchived`; an operator archive is preserved.
  Child sessions stay separate and link to their namespaced parent through
  `metadata.opencode.parentSessionId` and `nativeParentId`.

The adapter only reads the configured local source. For a remote host, run the
importer where that source is mounted and configure the intended destination DB;
there is no automatic remote discovery, API/SSE client, or OpenCode plugin installer.
Imported sessions are unassigned to a user, following AgentPulse's local observation
model; enable only on an instance where that is the intended visibility policy.
