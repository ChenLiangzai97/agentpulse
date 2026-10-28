/** Prefix-mapper tests: execution-time snapshot input, ambiguity stops,
 * original-time inheritance (per docs/OPENCODE_FORK_DESIGN.md §C). */
import { describe, expect, test } from "bun:test";
import { type SnapshotMessage, mapForkCopies } from "./fork-prefix-mapper.js";

const msg = (
	nativeId: string,
	parts: Array<[string, string?]>,
	occurredAt = "2026-10-16 05:00:00",
): SnapshotMessage => ({
	nativeId,
	parts: parts.map(([hash, toolName]) =>
		toolName ? { kind: "tool" as const, hash, toolName } : { kind: "text" as const, hash },
	),
	occurredAt,
});

const parent: SnapshotMessage[] = [
	msg("p1", [["alpha"]]),
	msg("p2", [["beta"]]),
	msg("p3", [["bash-run", "bash"]]),
	msg("p4", [["gamma"]]),
];

describe("fork prefix mapper", () => {
	test("full copy maps message+parts and inherits ORIGINAL occurrence times", () => {
		const child: SnapshotMessage[] = [
			msg("c1", [["alpha"]]),
			msg("c2", [["beta"]]),
			msg("c3", [["bash-run", "bash"]]),
			msg("c4", [["gamma"]]),
		];
		const result = mapForkCopies({
			parentSnapshot: parent,
			forkPointMessageId: null,
			childInitialSnapshot: child,
		});
		expect(result.stoppedAt).toBeNull();
		expect(result.mappings.map((m) => `${m.childNativeId}->${m.parentNativeId}`)).toEqual([
			"c1->p1",
			"c2->p2",
			"c3->p3",
			"c4->p4",
		]);
		// times come from the PARENT events, never the fork moment
		expect(result.mappings[0].occurredAt).toBe(parent[0].occurredAt);
		expect(result.mappings[2].parts).toEqual([{ childIndex: 0, parentIndex: 0 }]);
	});

	test("fork point is EXCLUSIVE: copies before it map, the point and after do not exist in the expectation", () => {
		const child: SnapshotMessage[] = [msg("c1", [["alpha"]]), msg("c2", [["beta"]])];
		const result = mapForkCopies({
			parentSnapshot: parent,
			forkPointMessageId: "p3",
			childInitialSnapshot: child,
		});
		expect(result.stoppedAt).toBeNull();
		expect(result.mappings.map((m) => m.parentNativeId)).toEqual(["p1", "p2"]);
	});

	test("a hash mismatch STOPS inference — no matching across the gap", () => {
		const child: SnapshotMessage[] = [
			msg("c1", [["alpha"]]),
			msg("c2", [["TAMPERED"]]),
			msg("c3", [["bash-run", "bash"]]), // would match p3 — must NOT be reached across the gap
		];
		const result = mapForkCopies({
			parentSnapshot: parent,
			forkPointMessageId: null,
			childInitialSnapshot: child,
		});
		expect(result.stoppedAt).toBe(1);
		expect(result.stopReason).toBe("hash_mismatch");
		expect(result.mappings.map((m) => m.parentNativeId)).toEqual(["p1"]);
	});

	test("a changed tool name is caught at the MESSAGE level; part shape mismatch stops", () => {
		// The message hash folds in kind+toolName+content, so a renamed tool
		// surfaces as hash_mismatch before per-part checks (defense in depth).
		const wrongTool: SnapshotMessage[] = [
			msg("c1", [["alpha"]]),
			msg("c2", [["beta"]]),
			msg("c3", [["bash-run"]]),
		];
		expect(
			mapForkCopies({
				parentSnapshot: parent,
				forkPointMessageId: null,
				childInitialSnapshot: wrongTool,
			}).stopReason,
		).toBe("hash_mismatch");
		const missingPart: SnapshotMessage[] = [
			msg("c1", [["alpha"]]),
			msg("c2", [["beta"], ["extra"]]),
		];
		expect(
			mapForkCopies({
				parentSnapshot: parent,
				forkPointMessageId: null,
				childInitialSnapshot: missingPart,
			}).stopReason,
		).toBe("part_shape_mismatch");
	});

	test("child longer or shorter than the pinned prefix stops conservatively", () => {
		const longer: SnapshotMessage[] = [
			...parent.map((m, i) =>
				msg(
					`c${i + 1}`,
					m.parts.map((p) => (p.toolName ? [p.hash, p.toolName] : [p.hash])),
					m.occurredAt,
				),
			),
			msg("c5", [["new-turn"]]),
		];
		const r1 = mapForkCopies({
			parentSnapshot: parent,
			forkPointMessageId: null,
			childInitialSnapshot: longer,
		});
		expect(r1.stopReason).toBe("child_longer_than_prefix");
		expect(r1.mappings.length).toBe(4); // the matched prefix is kept, the extra tail unmapped
		const shorter: SnapshotMessage[] = [msg("c1", [["alpha"]])];
		const r2 = mapForkCopies({
			parentSnapshot: parent,
			forkPointMessageId: null,
			childInitialSnapshot: shorter,
		});
		expect(r2.stopReason).toBe("child_longer_than_prefix");
		expect(r2.mappings.map((m) => m.parentNativeId)).toEqual(["p1"]);
	});

	test("fork point absent from the pinned snapshot refuses everything", () => {
		const child: SnapshotMessage[] = [msg("c1", [["alpha"]])];
		const result = mapForkCopies({
			parentSnapshot: parent,
			forkPointMessageId: "msg_nonexistent",
			childInitialSnapshot: child,
		});
		expect(result.mappings).toEqual([]);
		expect(result.stoppedAt).toBe(0);
		expect(result.stopReason).toBe("hash_mismatch");
	});
});
