# OpenCode session observation

OpenCode v1 SQLite sessions can be observed alongside Claude Code, Codex CLI,
and Copilot CLI. OpenCode is **observe-only**: AgentPulse cannot start, resume,
prompt, or answer permissions/questions for it. BotMux keeps control of its processes
and plugins, including `botmux-ask.js`.

## Enable on the machine containing OpenCode's database

The Bash installers (`/setup.sh`, `scripts/setup-hooks.sh`,
`scripts/setup-relay.sh`, `scripts/install-local.sh`) detect an `opencode` executable
or an existing source DB and print onboarding instructions. Detection uses the
installer account's environment and never runs OpenCode, changes plugins, writes
source data, or enables observation automatically. This is the installation-prompt
option: importing all local history remains an explicit operator choice.

First, from the checkout, run as the **same OS account and with the same environment
as the AgentPulse server**:

```bash
bun scripts/observe-opencode.ts --check
# Custom source (absolute path; setting it for this command does not persist it):
AGENTPULSE_OPENCODE_DB=/absolute/path/to/opencode.db bun scripts/observe-opencode.ts --check
```

This checks the v1 table shape and returns JSON with `adapter`, `schemaCompatible`,
SQLite `schemaVersion`, source counts and `observeOnly`. It opens no AgentPulse
destination DB and imports nothing. A missing/unreadable DB or missing required
column exits nonzero without creating or migrating the source. A successful check
means the table shape matches; it is not release or JSON-payload certification.

Set in the AgentPulse **server** environment (`.env.local` for the local installer,
a service EnvironmentFile, or container environment), then restart the **server**:

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
restarts. `scripts/install-local.sh` preserves existing single-line
`AGENTPULSE_OPENCODE_ENABLED`, `AGENTPULSE_OPENCODE_DB` and
`AGENTPULSE_OPENCODE_INSTANCE_ID` entries in `.env.local` during upgrades. Multiline
dotenv values are unsupported by this preservation step. Different instances with identical native IDs stay separate.

For a one-time import into the configured AgentPulse database:

```bash
bun scripts/observe-opencode.ts
# Standalone ongoing importer (do not also enable the server observer):
bun scripts/observe-opencode.ts --watch
```

A supervisor restart alone does not enable this observer. `~` and
`XDG_DATA_HOME` are resolved for the server account, which may differ from the
interactive installer account. In containers, mount the source directory so the
DB and its `-wal`/`-shm` files are accessible; copying only a live `.db` file may
omit committed WAL data. Do not change OpenCode's journal mode for this integration.

The server polls every three seconds. The first pass imports existing sessions;
subsequent passes read changed sessions, messages and parts using an inclusive
update-time watermark. Restarting replays the source; durable session/part keys
update existing rows instead of adding duplicates. Tool transitions from running
to completed retain their event ID and count once. WebSocket updates carry part
revision timestamps so stale REST responses cannot overwrite newer tool results.

The source connection is read-only and uses short SQLite snapshots that finish
before destination writes, allowing OpenCode's WAL writer to continue. The source
schema is validated before reads and revalidated inside the read snapshot when
SQLite's schema version changes. Compatible schema changes trigger a full replay
with fresh statements, including old sessions whose timestamps did not change. Missing databases or unsupported schemas produce
a warning and retry without taking down AgentPulse. Failed connections are closed
and reopened on retry so a repaired or replaced source can recover. A successful
initial/recovery pass logs sessions scanned and events changed (not new-session
count); no transcript content is logged.

## History import and deployment acceptance

There is **no SQL LIMIT, batch cap or recent-only cutoff** in source enumeration.
On a normal v1 database (nonnegative millisecond update timestamps), a first pass
reads all 313 sessions in the reported deployment, including archived and child
sessions, and their messages/parts. Archived sessions may require the dashboard's
archive filter; UI pagination is separate from ingestion. Sessions are committed
individually: progress can appear before the pass finishes. A failure can leave a
partial import; the next pass/restart safely retries existing keys.

This is not an unlimited-memory guarantee: a pass holds source snapshots in memory
and writes destination sessions serially. Large transcripts can make the initial
pass take longer than three seconds; passes never overlap. There is no new
operator-facing import-count limit in this change. Source deletions are not mirrored
as destination deletions. Restart replay restores accidentally deleted destination
history, so disable observation first if intentionally deleting imported records.

Regression coverage uses a synthetic WAL fixture with **313 sessions / 626 messages /
626 text parts**; it checks all sessions import, archives survive and restart creates
no duplicate events. This does not certify the contents of a private deployment.
Validate there by comparing `--check` counts with the initial observer log and the
OpenCode-filtered dashboard (including archives). Do not expect event counts to equal
part counts: reasoning and unsupported part kinds are skipped.

## Schema compatibility policy

| Source change | Policy |
| --- | --- |
| Existing v1 table and JSON shapes | Current adapter; verified with repository fixtures. The reported v1.15.11 installation must still pass local diagnostics and transcript spot checks. |
| Additive columns / extra JSON fields | Required columns remain usable; extra fields are ignored. Schema changes trigger replay. |
| Missing/renamed required table or column | Reject before destination writes in that pass; warn, reopen and retry. Never migrate the OpenCode DB. |
| Changed column meaning, timestamp units or JSON payloads with the same table shape | Structural diagnostics cannot detect all semantic changes. Pin the known-working OpenCode release and validate fixtures before upgrading. |
| OpenCode V2 or another breaking format | Unsupported until a separate adapter and sanitized fixtures are reviewed; no claim of automatic forward compatibility. |

SQLite `PRAGMA schema_version` is a local DDL change counter, **not** OpenCode's
product/schema version or migration count. Twenty migrations do not imply v20.
Before an OpenCode upgrade: retain a consistent SQLite backup with OpenCode's usual
backup procedure, record the working release, run `--check` after upgrade and inspect
sample prompts/tools/cost/tokens. If semantics changed, disable observation (unset
both opt-in variables), keep the known-working release and add fixtures plus the
new adapter before reenabling. Never point an old OpenCode binary at a migrated DB
without upstream-supported rollback guidance.

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


## Control channel feasibility (proposal, not implemented)

A separate control adapter is feasible using OpenCode's HTTP server and SSE instead
of writing SQLite. Official server documentation, checked 2026-10-17:
[OpenCode Server](https://opencode.ai/docs/server/).

| Needed capability | Documented server surface to evaluate |
| --- | --- |
| Identify live server and API contract | `GET /global/health`, `GET /doc` |
| Create / continue a native session | `POST /session`, then `POST /session/:id/message` or `/prompt_async` |
| History and status reconciliation | `GET /session/:id/message`, `GET /session/status` |
| Stop work | `POST /session/:id/abort` |
| Permission decisions | `POST /session/:id/permissions/:permissionID` (check installed contract) |
| Live updates | `GET /event` or `/global/event` (SSE) |

These are current documentation capabilities, not evidence every endpoint exists
in v1.15.11. Verify the installed `/doc` and sanitized request/event fixtures before
implementation. Questions/BotMux-specific approval mechanisms need their own
capability checks; the SQLite observer cannot reconstruct a live reply handle.

Proposed integration boundaries:

1. Run an explicit per-host OpenCode connection in the supervisor, with localhost
   HTTP/SSE and credentials stored on that host. Keep the existing authenticated
   supervisor transport and owner checks between hosts and AgentPulse. OpenCode
   supports Basic auth via `OPENCODE_SERVER_PASSWORD`; keep that API private.
2. Bind the dashboard session to supervisor ID, stable source instance ID, native
   session ID and live server generation. Connect to the actual TUI/BotMux server
   that owns active work. TUI ports can be random; starting `opencode serve`
   separately starts another server and is not proof of owning an existing request.
3. Add explicit capabilities (send/create/abort/permissions/questions), exposing
   controls only after endpoint and version checks. Do not add OpenCode to
   `LAUNCHABLE_AGENT_TYPES` until launch, reconnect and control contracts are tested.
4. Approval cards must retain native request ID, session, owning server generation,
   tool/context, available choices and expiry. Require an explicit decision, reject
   stale cards, enforce owner checks and record the result. Never infer permission
   to approve from a stored tool row or silently enable persistent permissions.
5. On reconnect, fetch current status, history and pending approvals before restoring
   controls. SSE must not be assumed to provide durable replay. Reconcile by native
   IDs; do not blindly resend prompts whose delivery outcome is unknown. If the
   installed API cannot enumerate pending requests, mark old cards unavailable and
   require resolution in OpenCode until new live requests arrive.
6. Keep SQLite observation as a fallback. API events and observed parts need the same
   native message/part identity to avoid duplicate transcript and worklog entries.
   Preserve BotMux plugin ownership and test concurrent clients, host isolation,
   duplicate replies, expired requests and process restarts before enabling control.

The architecture above is an AgentPulse design proposal inferred from documented
interfaces. This onboarding change supplies no HTTP/SSE control client, remote
OpenCode import forwarding, permission reply implementation or automatic V2 adapter.
