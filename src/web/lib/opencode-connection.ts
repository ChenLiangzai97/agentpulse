import type { Session } from "../../shared/types.js";

export type OpenCodeConnection =
	| { kind: "loading" }
	| { kind: "controllable"; host: string | null }
	| { kind: "notice"; reason: "not_owner" | "observe_only" | "unavailable"; origin: string | null };

/**
 * One source of truth for the OpenCode CONNECTION state. The server-derived
 * capability (a valid trusted binding owned by the viewer) is the only thing
 * that makes a session controllable; managedSession/origin alone never do.
 * send=false is NOT one condition: external/unknown, not_owner and a managed
 * but stopped/offline/invalid binding are different states.
 */
export function openCodeConnection(
	session: Pick<Session, "agentType" | "managedSession" | "controlCapabilities">,
): OpenCodeConnection | null {
	if (session.agentType !== "opencode") return null;
	const caps = session.controlCapabilities;
	if (!caps) return { kind: "loading" };
	if (caps.send) return { kind: "controllable", host: session.managedSession?.hostName ?? null };
	if (caps.reason === "not_owner") return { kind: "notice", reason: "not_owner", origin: caps.origin };
	if (caps.origin !== "agentpulse_launch" || caps.reason === "session_observe_only") {
		return { kind: "notice", reason: "observe_only", origin: caps.origin };
	}
	return { kind: "notice", reason: "unavailable", origin: caps.origin };
}
