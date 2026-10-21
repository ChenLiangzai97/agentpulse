import { describe, expect, test } from "bun:test";
import { resolveControlTarget } from "./opencode-control-target.js";

const entry = (instanceId: string, generation: number, nativeSessionId: string) => ({
	runtime: { instanceId, generation, nativeSessionId },
});
const entries = [entry("inst-parent", 3, "ses_parent")];

describe("A6 control addressing", () => {
	test("parent action (same instance/generation/native id) resolves", () => {
		const out = resolveControlTarget(entries, {
			instanceId: "inst-parent",
			generation: 3,
			nativeSessionId: "ses_parent",
		});
		expect(out.ok).toBe(true);
	});

	test("fork CHILD action on the same instance is explicitly refused, never misrouted", () => {
		const out = resolveControlTarget(entries, {
			instanceId: "inst-parent",
			generation: 3,
			nativeSessionId: "ses_child",
		});
		expect(out).toEqual({ ok: false, reason: "multi_session_unsupported" });
	});

	test("wrong instance or generation is a binding mismatch", () => {
		expect(
			resolveControlTarget(entries, {
				instanceId: "other",
				generation: 3,
				nativeSessionId: "ses_parent",
			}),
		).toEqual({ ok: false, reason: "binding_mismatch" });
		expect(
			resolveControlTarget(entries, {
				instanceId: "inst-parent",
				generation: 4,
				nativeSessionId: "ses_parent",
			}),
		).toEqual({ ok: false, reason: "binding_mismatch" });
	});

	test("missing nativeSessionId metadata keeps the legacy parent behaviour", () => {
		const out = resolveControlTarget(entries, { instanceId: "inst-parent", generation: 3 });
		expect(out.ok).toBe(true);
	});
});
