import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedSessionEventInput } from "../../shared/types.js";
import { createManagedOutbox } from "./managed-outbox.js";

test("a restart replays unacknowledged events with the original identity and timestamp", async () => {
	const home = mkdtempSync(join(tmpdir(), "ap-outbox-"));
	let first: ManagedSessionEventInput[] = [];
	try {
		const queue = createManagedOutbox(home, async (_, events) => {
			first = events;
			throw new Error("offline");
		});
		await queue.enqueue("native-session", [
			{ eventType: "ManagedAgentMessage", category: "assistant_message", content: "hello" },
		]);
		const directory = join(home, ".agentpulse", "managed-outbox");
		expect(readdirSync(directory)).toHaveLength(1);
		expect(statSync(join(directory, readdirSync(directory)[0])).mode & 0o077).toBe(0);
		const replayed: ManagedSessionEventInput[][] = [];
		const restarted = createManagedOutbox(home, async (sessionId, events) => {
			expect(sessionId).toBe("native-session");
			replayed.push(events);
		});
		await restarted.flush();
		expect(replayed[0][0].deliveryId).toBe(first[0].deliveryId);
		expect(replayed[0][0].occurredAt).toBe(first[0].occurredAt);
		expect(readdirSync(directory)).toHaveLength(0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
