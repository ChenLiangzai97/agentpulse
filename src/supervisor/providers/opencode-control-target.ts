/**
 * A6 control addressing (isolated, pure): resolve the runtime for an action by
 * PROVIDER INSTANCE, never by the action's AgentPulse session id — a fork
 * child's action names the child while the runtime is keyed by the parent.
 * A runtime bound to a DIFFERENT native session than the action names is an
 * explicit refusal (multi-session execution is an open item), never misrouted.
 */
export interface ControlTargetRuntime {
	instanceId: string;
	generation: number;
	nativeSessionId: string;
}

export function resolveControlTarget<T extends { runtime: ControlTargetRuntime }>(
	entries: Iterable<T>,
	metadata: Record<string, unknown>,
):
	| { ok: true; entry: T }
	| { ok: false; reason: "binding_mismatch" | "multi_session_unsupported" } {
	for (const entry of entries) {
		if (
			metadata.instanceId === entry.runtime.instanceId &&
			metadata.generation === entry.runtime.generation
		) {
			if (
				typeof metadata.nativeSessionId === "string" &&
				metadata.nativeSessionId !== entry.runtime.nativeSessionId
			)
				return { ok: false, reason: "multi_session_unsupported" };
			return { ok: true, entry };
		}
	}
	return { ok: false, reason: "binding_mismatch" };
}
