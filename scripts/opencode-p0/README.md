# OpenCode P0 protocol probes

These scripts exercise a **real local OpenCode 1.18.35 server** using a deterministic
loopback-only OpenAI-compatible model fixture. They do not use live model keys,
edit AgentPulse runtime code, connect to BotMux servers, or install a provider.
The model fixture drives actual native bash/permission/question tools; it does not
mock OpenCode's API, pending request lists, event stream, or process restarts.

Requirements: Python 3 stdlib, git, local OpenCode 1.18.35. Resolve `opencode` from
PATH or `~/.opencode/bin/opencode`, or set `P0_OPENCODE_BIN`. The installed SDK
reference used in this capture was 1.18.34; it is not assumed to be the CLI contract.

Run from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python scripts/opencode-p0/run.py
python scripts/opencode-p0/verify_fixtures.py
```

The runner creates private disposable XDG config/data/cache/state/tmp directories,
starts its own loopback authenticated server and local model fixture, creates only
synthetic sessions, and closes/cleans its owned processes/directories in `finally`.
It refuses to overwrite an existing `/tmp/agentpulse-opencode-p0-state.json`; inspect
that manifest and verify process identities before manually cleaning a previously
interrupted run. Do not kill arbitrary port occupants. Positive-control plugin
loading may need the executable's normal package-dependency resolution; first cold
runs can take longer than cached runs. Diagnostic failures are retained in stdout,
so redirect the run to a private temporary log when diagnosing startup issues.

Exports go to `src/supervisor/providers/__fixtures__/opencode-1.18.35/`:

- `openapi.json`: complete `/doc` captured from the binary (162 paths).
- `hello.json`: session creation, directory and actual model reply.
- `interactions.json`, `sse.json`: tool permission (including same-server/same-project new-session always inheritance) and multi-question replies/rejections.
- `isolation.json`: global/project singular/plural directories + explicit plugin,
  with positive loading controls and a cold `--pure` negative control.
- `credentials.json`: private-file injection, missing/invalid key, missing model and success.
- `recovery.json`: busy request abort, SSE reconnect, process-restart invalidation,
  old request 404 and repeated messageID behavior.
- `lifecycle.json`: auth, port collision fallback, directory context and owned stop.
- `manifest.json`: versions, limitations and SHA-256 hashes of exported fixtures.

Private root/home paths, transient endpoint ports, test keys/passwords and native
request/session/message/part IDs are normalized. No real credentials are read or
exported. The full spec includes both legacy routes and `/api` routes; these probes
verify the legacy-compatible `/session`, `/permission`, `/question`, `/event`
family. They make no claim that `/api` has identical persistence semantics.

Known contract constraints captured by the probes:

1. Native pending permission/question state is lost on **OpenCode process restart**;
   old replies return 404, while old tool parts can remain running. A reconnected
   client can still GET a pending request if the server process did not restart.
2. Replaying identical `messageID` with a text part makes one message with **two
   text parts**. Automatic retries must reconcile delivery/parts, not assume idempotence.
3. `/provider` may report connected for an absent/invalid key. A configured-key
   precheck and an actual model health request are separate checks.
4. `--port 0` prefers 4096 if free, otherwise chooses another port; parse the actual
   owned server's address and verify its identity instead of assuming port 0 means
   a freshly selected ephemeral port.
5. Native `always` auto-authorizes matching tools in a new session of the same
   server/project context. It is not session-only. Phase two must expose only
   once/reject on the web; always is explicitly excluded.
6. A server directory query can change context. Directory context is not an access
   control boundary; the provider must pin and authorize its session directory.

Run `verify_fixtures.py` offline to check schemas, captured outcomes, hashes and
redaction without starting any service. These are P0 assets only; P1 still needs
independent reviewer approval before application implementation starts.
