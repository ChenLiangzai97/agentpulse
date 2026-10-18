/**
 * Isolated prototype (NOT wired to the main path): the fork copy-mapper per
 * docs/OPENCODE_FORK_DESIGN.md §C — trust chain from the EXECUTION-TIME parent
 * snapshot (captured by the supervisor in the fork window, never the central
 * mirror) to the child's INITIAL snapshot.
 *
 * Rules:
 *  - expected parent prefix = all messages BEFORE the fork point (exclusive),
 *    or the whole list when no point was given;
 *  - position-by-position matching: message hash, then per-part (index + kind
 *    + tool name + hash);
 *  - FIRST ambiguity or prefix break STOPS inference — no matching across
 *    gaps; mappings are kept only up to the stop;
 *  - inherited occurrence times come from the PARENT events (never the fork
 *    day).
 */
export interface SnapshotPart {
	kind: "text" | "tool";
	/** Content hash (any stable hasher; identical content → identical hash). */
	hash: string;
	toolName?: string;
}

export interface SnapshotMessage {
	nativeId: string;
	parts: SnapshotPart[];
	/** The ORIGINAL occurrence time of this message (from the parent events). */
	occurredAt: string;
}

export interface PartMapping {
	childIndex: number;
	parentIndex: number;
}

export interface MessageMapping {
	childNativeId: string;
	parentNativeId: string;
	parts: PartMapping[];
	/** Inherited from the parent message — not the fork moment. */
	occurredAt: string;
}

export interface MappingResult {
	mappings: MessageMapping[];
	/** Index in the child snapshot where inference stopped (null = full). */
	stoppedAt: number | null;
	/** Why inference stopped, when it did. */
	stopReason?:
		| "hash_mismatch"
		| "part_shape_mismatch"
		| "part_hash_mismatch"
		| "child_longer_than_prefix";
}

function messageHash(message: SnapshotMessage): string {
	return message.parts.map((p) => `${p.kind}:${p.toolName ?? ""}:${p.hash}`).join("|");
}

export function mapForkCopies(input: {
	parentSnapshot: SnapshotMessage[];
	forkPointMessageId?: string | null;
	childInitialSnapshot: SnapshotMessage[];
}): MappingResult {
	const parent = input.parentSnapshot;
	let expected = parent;
	if (input.forkPointMessageId) {
		const point = parent.findIndex((m) => m.nativeId === input.forkPointMessageId);
		if (point === -1) return { mappings: [], stoppedAt: 0, stopReason: "hash_mismatch" }; // fork point not in the pinned snapshot: refuse everything
		expected = parent.slice(0, point); // native semantics: exclude the point and everything after
	}
	const child = input.childInitialSnapshot;
	const mappings: MessageMapping[] = [];
	for (let i = 0; i < child.length; i++) {
		const expectedMessage = expected[i];
		if (!expectedMessage) return { mappings, stoppedAt: i, stopReason: "child_longer_than_prefix" };
		// Shape FIRST so a differing part count reports precisely; the
		// message-level hash (kind+tool+content concat) then catches any
		// content/tool divergence.
		if (child[i].parts.length !== expectedMessage.parts.length)
			return { mappings, stoppedAt: i, stopReason: "part_shape_mismatch" };
		if (messageHash(child[i]) !== messageHash(expectedMessage))
			return { mappings, stoppedAt: i, stopReason: "hash_mismatch" };
		const parts: PartMapping[] = [];
		for (let p = 0; p < child[i].parts.length; p++) {
			const cp = child[i].parts[p];
			const pp = expectedMessage.parts[p];
			if (cp.kind !== pp.kind || cp.toolName !== pp.toolName || cp.hash !== pp.hash)
				return { mappings, stoppedAt: i, stopReason: "part_hash_mismatch" };
			parts.push({ childIndex: p, parentIndex: p });
		}
		mappings.push({
			childNativeId: child[i].nativeId,
			parentNativeId: expectedMessage.nativeId,
			parts,
			occurredAt: expectedMessage.occurredAt,
		});
	}
	if (child.length < expected.length)
		// The child's initial snapshot is SHORTER than the pinned prefix: the
		// prefix broke — keep what matched, stop.
		return { mappings, stoppedAt: child.length, stopReason: "child_longer_than_prefix" };
	return { mappings, stoppedAt: null };
}
