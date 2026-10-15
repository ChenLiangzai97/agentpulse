import {
	constants,
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import type { ManagedSessionEventInput } from "../../shared/types.js";

interface Delivery {
	sessionId: string;
	events: ManagedSessionEventInput[];
}
/** A private disk queue: acknowledgements can be lost, so events carry stable delivery IDs. */
export function createManagedOutbox(
	home: string,
	send: (sessionId: string, events: ManagedSessionEventInput[]) => Promise<void>,
) {
	const parent = join(home, ".agentpulse");
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (lstatSync(parent).isSymbolicLink())
		throw new Error("Refusing a symlinked AgentPulse state directory");
	const directory = join(parent, "managed-outbox");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let flushing: Promise<void> | null = null;
	const flush = (): Promise<void> => {
		if (flushing) return flushing;
		flushing = (async () => {
			for (const name of readdirSync(directory)
				.filter((n) => /^[0-9a-f-]+\.json$/.test(n))
				.sort()) {
				const path = join(directory, name);
				const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				let delivery: Delivery;
				try {
					const stat = fstatSync(fd);
					if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
						throw new Error("Invalid managed outbox entry");
					delivery = JSON.parse(readFileSync(fd, "utf8"));
				} finally {
					closeSync(fd);
				}
				try {
					await send(delivery.sessionId, delivery.events);
				} catch (error) {
					const status = (error as { status?: number }).status;
					// A terminal ownership/deletion failure must not block other sessions' queued messages.
					if (status !== 403 && status !== 404) throw error;
					console.error("[managed-outbox] removed delivery for an unavailable session");
				}
				unlinkSync(path);
			}
		})().finally(() => {
			flushing = null;
		});
		return flushing;
	};
	return {
		flush,
		async enqueue(sessionId: string, events: ManagedSessionEventInput[]) {
			if (!events.length) return;
			const deliveryId = crypto.randomUUID();
			const delivery: Delivery = {
				sessionId,
				events: events.map((event, index) => ({
					...event,
					deliveryId: event.deliveryId ?? `${deliveryId}:${index}`,
					occurredAt: event.occurredAt ?? new Date().toISOString(),
				})),
			};
			writePrivateFileAtomicNoFollow(
				join(directory, `${Date.now().toString(16)}-${deliveryId}.json`),
				JSON.stringify(delivery),
			);
			// Keep accepting native notifications during a network outage; retry on the next tick.
			try {
				await flush();
			} catch (error) {
				const status = (error as { status?: number }).status;
				if (status === 401 || status === 403) throw error;
				console.error("[managed-outbox] delivery deferred until connection recovers");
			}
		},
	};
}
