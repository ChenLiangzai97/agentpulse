# FIXED: origin-instance STOP settled as failed (opencode_process_interrupted)

Evidence (fixture, real STOP, commit 71d5453 run):
- `control_actions` row: type=stop, status=**failed**, error=`opencode_process_interrupted`
- `session_control_bindings`: `stop_state=**stopping**`, `stop_epoch=1`
- page correctly shows 当前不可发送 and no composer (UI consistent)

## Code path
`src/server/services/opencode-managed.ts:1174 interruptOpenCodeInstance(supervisorId, instanceId, generation, state)`:
- bumps `provider_instances.generation = generation + 1`
- fails **every** queued/running action of the origin session (line ~1212-1225), including the
  in-flight stop action, before the supervisor's stop-result can settle it.

So the intentional stop is indistinguishable from a crash at settle time: the action's epoch is
now stale and/or the row is already failed. The page's "unavailable" is then derived from the
binding's `stopping` state, so UI stays consistent while the stop bookkeeping is wrong.

## Required fix (do NOT blanket-convert interrupted to success)
1. In the intentional-stop path (`state === "stopped"`), EXCLUDE the authorized in-flight stop
   action from the mass-fail; keep the crash path (`state === "interrupted"`) failing everything.
2. Let its stop-result settle against the **action's own recorded epoch/token** (the action
   carries controlEpoch + claimToken), not the bumped current generation; CAS on token +
   action status.
3. If no result arrives, the action stays running until lease expiry (no bypass).
4. Regressions: origin stop -> succeeded + binding stopped; unexpected exit -> failed; stale
   token/epoch rejected; child stop does not kill the parent.

## Fix (implemented)
`interruptOpenCodeInstance` now excludes exactly ONE authorized in-flight stop from the
mass-fail when `state === "stopped"`: same session, action_type=stop, queued/running,
claimed by this supervisor, metadata instanceId/generation matching the ended instance,
controlEpoch === the protected binding's current stopEpoch, and a non-empty claimToken —
all checked in the SAME transaction. The crash path (`state === "interrupted"`) still fails
every running action. The result guard is unchanged: the route still requires the action
epoch to equal the binding stopEpoch; expiry remains UNKNOWN/stopping (no auto-success).

Verified on a fresh fixture build: real STOP -> action succeeded, binding stopped(epoch=1),
page 当前不可发送 with no composer. 25 unit tests (stop-state / final / provenance) pass;
child-stop-not-killing-parent remains from the fork slice (12/12).
