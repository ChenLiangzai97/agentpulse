import { describe, expect, test } from "bun:test";
import { openCodeConnection } from "./opencode-connection.js";

const caps = (c: Record<string, unknown>) => ({
	origin: "agentpulse_launch",
	send: false,
	interrupt: false,
	stop: false,
	respondPermission: false,
	answerQuestion: false,
	reason: null,
	...c,
}) as never;

describe("openCodeConnection", () => {
	test("only opencode gets a connection model", () => {
		expect(openCodeConnection({ agentType: "codex_cli", managedSession: null })).toBeNull();
	});
	test("capabilities not loaded -> loading (no conclusion)", () => {
		expect(openCodeConnection({ agentType: "opencode", managedSession: null })).toEqual({ kind: "loading" });
	});
	test("send=true -> controllable with host", () => {
		expect(
			openCodeConnection({
				agentType: "opencode",
				managedSession: { hostName: "dev" } as never,
				controlCapabilities: caps({ send: true }),
			}),
		).toEqual({ kind: "controllable", host: "dev" });
	});
	test("external -> observe-only notice", () => {
		expect(
			openCodeConnection({
				agentType: "opencode",
				managedSession: null,
				controlCapabilities: caps({ origin: "external_observer", reason: "session_observe_only" }),
			}),
		).toEqual({ kind: "notice", reason: "observe_only", origin: "external_observer" });
	});
	test("not_owner -> permission notice", () => {
		expect(
			openCodeConnection({
				agentType: "opencode",
				managedSession: null,
				controlCapabilities: caps({ reason: "not_owner" }),
			}),
		).toEqual({ kind: "notice", reason: "not_owner", origin: "agentpulse_launch" });
	});
	test("managed but send=false -> unavailable notice", () => {
		expect(
			openCodeConnection({
				agentType: "opencode",
				managedSession: null,
				controlCapabilities: caps({ reason: "provider_binding_invalid" }),
			}),
		).toEqual({ kind: "notice", reason: "unavailable", origin: "agentpulse_launch" });
	});
});
