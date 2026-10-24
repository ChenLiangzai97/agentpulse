# Managed runtime and interaction implementation checkpoint

P2 connects a capability-gated `managed_opencode` launch to a dedicated authenticated
1.18.35 server. Protected reservation/generation fields are issued only after a
Supervisor claims a new validated launch. External/legacy session controls stay
forbidden. Client executable/server/environment/model/policy overrides never reach
the runtime. Host-local private profiles and sanitized real model health implement
the approved credential-file fallback.

P3 adds SSE-triggered GET reconciliation, native part upserts, verified read-only
child sessions and owned-process recovery. Recovery uses Linux pidfd/start time/cwd/
config identity; it never adopts an arbitrary process. Local native history is
retained, restarted native interactions are invalidated, and ambiguous prompts are
not retried. Late history can update a closed generation without enabling controls.

P4 adds durable interaction rows, revision checks, atomic answer claims and strict
once/reject permissions. Stop/interrupt/answers bypass prompt locks. Bounded prompt
queues wait for idle in submission order; busy/pending native instances are not
reaped as idle. The web UI renders structured multiple-choice/free-text questions.

Validation at this checkpoint: real-CLI lifecycle/health/recovery and service
integration tests use only the checked-in loopback mock and fake credentials;
PostgreSQL also passed the real managed-provider integration. Scoped existing
regression: 98 pass, 1 opt-in skip, 0 fail. Type/architecture checks and production
build are recorded separately. P5 browser, fault and combined acceptance remains
in progress; this checkpoint does not claim final acceptance.
