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

## Managed control (OpenCode 1.18.35)

OpenCode is now launchable **only** through `managed_opencode` on a capable
Supervisor. Imported, legacy and BotMux sessions remain permanently observe-only;
adding the agent type to the launch list never grants an existing session control.
The server authorizes a protected launch reservation, native binding and generation,
not ordinary session metadata. Binding an external session is forbidden, including
for administrators. Existing observer IDs and deduplication keys are unchanged.

The current runtime requires Linux, OpenCode CLI 1.18.35 and `/usr/bin/python3`
with Linux pidfd support. Other versions/platforms do not advertise the capability.
Each launch uses an authenticated loopback server, `--pure`, dedicated XDG/HOME/temp
folders and a private model profile. Launch arguments cannot supply a server URL,
executable, environment, model or permission override. No default OpenCode database,
plugins, auth file or BotMux process is adopted.

Configure the target Supervisor's private `~/.agentpulse/supervisor.json`:

```json
{
  "opencodeCommand": "/opt/opencode/bin/opencode",
  "opencodeProfilePath": "/home/operator/.agentpulse/opencode-profile.json",
  "opencodeMaxInstances": 2,
  "opencodeMaxQueuedLaunches": 4,
  "opencodeIdleTimeoutMs": 1800000,
  "opencodeStopGraceMs": 5000
}
```

The profile is a dedicated mode-0600 file on the target host, for example:

```json
{
  "model": "private/model-name",
  "provider": {
    "private": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://provider.example/v1",
        "apiKey": "replace-on-target-host"
      },
      "models": {
        "model-name": {
          "name": "Private model",
          "tool_call": true,
          "limit": { "context": 32768, "output": 2048 }
        }
      }
    }
  }
}
```

Restart the Supervisor after changing its configuration. Hosts → OpenCode shows
sanitized health and resource limits and offers a real model health check. A health
check uses a minimal model request and can incur provider usage. Registry membership
alone is not evidence of working credentials. Missing configuration, authentication
failure, missing model and transport failures have separate health states. Remote
key entry is deliberately unavailable: configure/replace/delete the dedicated file
on the target host; keys never enter launch metadata, control actions or outboxes.

The session page offers message submission, interrupt, stop, once/reject permissions
and structured question answers. `always` is rejected by the service and provider,
and has no web button. Requests persist independently of the timeline; revisions,
expiry and atomic answer claims prevent stale or concurrent answers. Pending
permissions/questions and busy native sessions prevent idle reclamation. Capacity
includes starting processes; excess launches fail explicitly. Per-session prompt
queues are bounded at four; stop/interrupt/answers have priority and bypass prompt
locks.

SSE wakes reconciliation; periodic GET snapshots recover missed events. Native part
IDs update the same event, preserving tool counts and final output. Child sessions
are checked against the native parent tree, displayed separately and remain
observe-only. Root interaction cards include verified descendants' requests.

A main-server disconnect is reconciled from the running native server. After a
Supervisor crash, recovery verifies the recorded process using pidfd, start time,
working directory, `--pure` and the dedicated config path before terminating it.
It imports only that instance's own SQLite history and invalidates its generation
and pending cards. A recycled or unverifiable PID is never signalled. Native process
restart does **not** resume pending interactions; prompt transport errors are never
blindly retried. Stopped/interrupted runtime state is not business completion.
Private native history remains on the Supervisor for reconciliation/audit; the
transient credential copy is removed on normal stop.

Verification uses the checked-in P0 protocol fixtures and opt-in real-CLI tests with
a loopback deterministic provider and fake credentials:

```bash
python3 scripts/opencode-p0/verify_fixtures.py
bun --no-env-file test src/server/services/opencode-control-provenance.test.ts
AGENTPULSE_OPENCODE_RUNTIME_TEST=1 AGENTPULSE_OPENCODE_COMMAND=/opt/opencode/bin/opencode \
  bun --no-env-file test src/supervisor/providers/opencode-runtime.test.ts \
  src/server/services/opencode-control-provenance.test.ts
```

SQLite and PostgreSQL additive migrations are 0012 (provenance) and 0013
(interactions). For application rollback retain the additive tables. The offline
rollback script removes only these tables and requires a backup plus migration
journal reconciliation before a later forward upgrade.
