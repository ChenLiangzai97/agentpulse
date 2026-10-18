/**
 * Isolated prototype (NOT wired to the main path): binding-as-authority
 * lookup per docs/OPENCODE_FORK_DESIGN.md §A1. The provider instance stays
 * the PROCESS authority (its session_id is the originating parent); a child
 * session's control authority comes from ITS binding row — instance id,
 * native session id and generation all checked against the live instance.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { providerInstances, sessionControlBindings, sessions } from "../../db/schema/index.js";

export interface BindingAuthority {
	instanceId: string;
	generation: number;
	nativeSessionId: string;
	supervisorId: string;
}

export async function bindingAuthorityForSession(
	sessionId: string,
): Promise<{ ok: true; authority: BindingAuthority } | { ok: false; reason: string }> {
	const [session] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	if (!session || session.agentType !== "opencode")
		return { ok: false, reason: "not_opencode_session" };
	const [binding] = await getDb()
		.select()
		.from(sessionControlBindings)
		.where(eq(sessionControlBindings.sessionId, sessionId));
	if (
		!binding ||
		binding.origin !== "agentpulse_launch" ||
		!binding.instanceId ||
		!binding.nativeSessionId ||
		!binding.generation
	)
		return { ok: false, reason: "no_valid_binding" };
	const [instance] = await getDb()
		.select()
		.from(providerInstances)
		.where(and(eq(providerInstances.id, binding.instanceId)));
	if (!instance || instance.agentType !== "opencode")
		return { ok: false, reason: "instance_missing" };
	if (!["reserved", "running"].includes(instance.state))
		return { ok: false, reason: "instance_not_live" };
	if (instance.generation !== binding.generation)
		return { ok: false, reason: "generation_mismatch" };
	return {
		ok: true,
		authority: {
			instanceId: instance.id,
			generation: instance.generation,
			nativeSessionId: binding.nativeSessionId,
			supervisorId: instance.supervisorId,
		},
	};
}
