# P1: protected OpenCode provenance

OpenCode control remains disabled in this phase. A server-owned reservation and
binding are required before a later provider may enable control. Session metadata,
administrator privileges, native IDs and a forged managed-session row cannot grant
control. Existing sessions are backfilled as `legacy_unknown`; observer imports
are marked `external_observer`. Neither origin can become managed.

Negative coverage: bind, prompt, stop, approval, question, resume, retry and fork
HTTP routes; direct control services; Ask stop/resume; Supervisor state/event
reports; MCP prompt/stop/retry. Tests also cover agent-type laundering, foreign
Supervisor bindings, native-ID substitution, generation fencing and CAS rebinding.

Validation:

- SQLite targeted regression: 48 pass, 3 skip, 0 fail.
- Isolated PostgreSQL 14 provenance suite: 7 pass, 0 fail.
- SQLite additive migration replay/backfill/constraints/offline rollback: pass.
- Type checking and architecture checks: pass.

Rollback: revert application code while retaining the additive tables. For an
offline disposable database, `scripts/rollback-opencode-provenance.sql` removes
only the new tables; back up first and reconcile migration journals before a
subsequent forward migration. Never remove observer sessions or events.
