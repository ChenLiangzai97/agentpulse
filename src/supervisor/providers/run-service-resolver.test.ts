import { expect, test } from "bun:test";
import {
	type ResolveDeps,
	type RunServiceManifest,
	resolveRunService,
} from "./run-service-resolver.js";

const manifest: RunServiceManifest = {
	version: 1,
	instanceId: "i-1",
	generation: 2,
	nativeSessionId: "ses_1",
	pid: 111,
	startTicks: "42",
	url: "http://127.0.0.1:7777",
	tokenPath: "/tmp/token",
};
const expected = { instanceId: "i-1", generation: 2, nativeSessionId: "ses_1" };
const identity = {
	instanceId: "i-1",
	generation: 2,
	nativeSessionId: "ses_1",
	pid: 111,
	startTicks: "42",
};
const deps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({
	startTicks: async () => "42",
	readToken: async () => "secret",
	fetchIdentity: async () => ({ status: 200, body: identity }),
	...over,
});

test("a fully matching manifest resolves", async () => {
	const result = await resolveRunService(manifest, expected, deps());
	expect(result.ok).toBe(true);
});

test("a wrong token is refused", async () => {
	const result = await resolveRunService(
		manifest,
		expected,
		deps({ fetchIdentity: async () => ({ status: 401, body: {} }) }),
	);
	expect(result).toEqual({ ok: false, reason: "authentication_failed" });
});

test("forged start ticks (PID reuse) are refused", async () => {
	const result = await resolveRunService(
		manifest,
		expected,
		deps({ startTicks: async () => "99" }),
	);
	expect(result).toEqual({ ok: false, reason: "process_gone_or_reused" });
	const missing = await resolveRunService(
		{ ...manifest, startTicks: null },
		expected,
		deps(),
	);
	expect(missing).toEqual({ ok: false, reason: "process_gone_or_reused" });
});

test("wrong generation / native identity are refused", async () => {
	expect((await resolveRunService(manifest, { ...expected, generation: 3 }, deps())).ok).toBe(false);
	expect(
		(await resolveRunService(manifest, { ...expected, nativeSessionId: "ses_2" }, deps())).ok,
	).toBe(false);
	// The SERVICE answering with a different identity is refused too.
	const drifted = await resolveRunService(
		manifest,
		expected,
		deps({ fetchIdentity: async () => ({ status: 200, body: { ...identity, nativeSessionId: "ses_x" } }) }),
	);
	expect(drifted).toEqual({ ok: false, reason: "identity_mismatch" });
});

test("non-loopback addresses are refused", async () => {
	const result = await resolveRunService(
		{ ...manifest, url: "http://10.0.0.5:7777" },
		expected,
		deps(),
	);
	expect(result).toEqual({ ok: false, reason: "not_loopback" });
});

test("an unreadable token file is refused", async () => {
	const result = await resolveRunService(
		manifest,
		expected,
		deps({ readToken: async () => Promise.reject(new Error("EACCES")) }),
	);
	expect(result).toEqual({ ok: false, reason: "token_unreadable" });
});
