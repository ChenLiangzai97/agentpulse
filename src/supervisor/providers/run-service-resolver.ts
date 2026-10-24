/**
 * ONE reconnection resolver for a detached run service (P2 prototype).
 *
 * Reconnecting is never "the PID is alive": the resolver requires the manifest
 * binding (instance id, generation, native session), the SAME process identity
 * (/proc start ticks — PID reuse refused), a loopback-only address, a private
 * token file, and an authenticated /identity response that agrees with BOTH the
 * manifest and the caller's expectation.
 */
export interface RunServiceManifest {
	version: 1;
	instanceId: string;
	generation: number;
	nativeSessionId: string;
	pid: number;
	startTicks: string | null;
	url: string;
	tokenPath: string;
}

export type ResolveFailure =
	| "manifest_invalid"
	| "not_loopback"
	| "identity_mismatch"
	| "process_gone_or_reused"
	| "token_unreadable"
	| "authentication_failed"
	| "transport_failed";

export interface ResolveDeps {
	startTicks(pid: number): Promise<string | null>;
	readToken(path: string): Promise<string>;
	fetchIdentity(
		url: string,
		token: string,
	): Promise<{ status: number; body: unknown }>;
}

const isLoopback = (url: string) => {
	try {
		const parsed = new URL(url);
		return (
			parsed.protocol === "http:" &&
			parsed.hostname === "127.0.0.1" &&
			parsed.username === "" &&
			parsed.password === ""
		);
	} catch {
		return false;
	}
};

const validManifest = (m: unknown): m is RunServiceManifest => {
	const value = m as Partial<RunServiceManifest> | null;
	return Boolean(
		value &&
			value.version === 1 &&
			typeof value.instanceId === "string" &&
			typeof value.generation === "number" &&
			typeof value.nativeSessionId === "string" &&
			typeof value.pid === "number" &&
			(value.startTicks === null || typeof value.startTicks === "string") &&
			typeof value.url === "string" &&
			typeof value.tokenPath === "string",
	);
};

export async function resolveRunService(
	rawManifest: unknown,
	expected: { instanceId: string; generation: number; nativeSessionId: string },
	deps: ResolveDeps,
): Promise<
	| { ok: true; identity: Record<string, unknown> }
	| { ok: false; reason: ResolveFailure }
> {
	if (!validManifest(rawManifest)) return { ok: false, reason: "manifest_invalid" };
	const manifest = rawManifest;
	if (!isLoopback(manifest.url)) return { ok: false, reason: "not_loopback" };
	if (
		manifest.instanceId !== expected.instanceId ||
		manifest.generation !== expected.generation ||
		manifest.nativeSessionId !== expected.nativeSessionId
	)
		return { ok: false, reason: "identity_mismatch" };
	// PROCESS identity: start ticks must exist AND match (never PID alone).
	const ticks = await deps.startTicks(manifest.pid);
	if (!manifest.startTicks || ticks === null || ticks !== manifest.startTicks)
		return { ok: false, reason: "process_gone_or_reused" };
	let token: string;
	try {
		token = (await deps.readToken(manifest.tokenPath)).trim();
	} catch {
		return { ok: false, reason: "token_unreadable" };
	}
	if (!token) return { ok: false, reason: "token_unreadable" };
	let response: { status: number; body: unknown };
	try {
		response = await deps.fetchIdentity(manifest.url, token);
	} catch {
		return { ok: false, reason: "transport_failed" };
	}
	if (response.status === 401 || response.status === 403)
		return { ok: false, reason: "authentication_failed" };
	if (response.status !== 200) return { ok: false, reason: "transport_failed" };
	const identity = (response.body ?? {}) as Record<string, unknown>;
	// The SERVICE's own answer must agree with the manifest AND the expectation.
	if (
		identity.instanceId !== manifest.instanceId ||
		identity.generation !== manifest.generation ||
		identity.nativeSessionId !== manifest.nativeSessionId ||
		identity.pid !== manifest.pid ||
		identity.startTicks !== manifest.startTicks
	)
		return { ok: false, reason: "identity_mismatch" };
	return { ok: true, identity };
}
