/**
 * Isolated prototype (NOT wired to the main path): binding RESOLUTION helper
 * per docs/OPENCODE_FORK_DESIGN.md §A1 — it answers "which instance/native
 * session/generation does this session's binding address", nothing more.
 *
 * THIS IS NOT AUTHORIZATION: it performs no Actor, owner, request-supervisor
 * or scope checks. The main path MUST layer the full authorization stack
 * (actor + ownership + supervisor identity + source validation) on top of
 * this lookup before any control decision. The real-DB tests here prove
 * resolution behavior only — they do NOT constitute an acceptance that
 * child sessions are controllable.
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
