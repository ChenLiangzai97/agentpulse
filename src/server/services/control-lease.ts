/**
 * Execution leases for the STOP race. A permit is not a one-shot check: the
 * permit registers a short lease BEFORE returning, and STOP must acquire the
 * same in-process mutex and see zero active leases before it may advance the
 * epoch. A permit that lost the race (STOP already advanced) is refused by the
 * transactional epoch check. Single-process control plane by design; leases
 * expire so a crashed supervisor cannot wedge STOP forever.
 */
export const EXECUTION_LEASE_MS = 60_000;

interface Lease {
	sessionId: string;
	epoch: number;
	expiresAt: number;
}

const leases = new Map<string, Lease>();
let tail: Promise<unknown> = Promise.resolve();

/** Serializes permit registration with the STOP transition (single process). */
export function withControlMutex<T>(run: () => Promise<T>): Promise<T> {
	const next = tail.then(run, run);
	tail = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

export function registerExecutionLease(input: {
	actionId: string;
	sessionId: string | null;
	epoch: number;
}): void {
	leases.set(input.actionId, {
		sessionId: input.sessionId ?? "",
		epoch: input.epoch,
		expiresAt: Date.now() + EXECUTION_LEASE_MS,
	});
}

export function releaseExecutionLease(actionId: string): void {
	leases.delete(actionId);
}

/** Active (unexpired) leases for a session, pruning stale entries. */
export function activeLeases(sessionId: string): string[] {
	const now = Date.now();
	const active: string[] = [];
	for (const [actionId, lease] of leases) {
		if (lease.expiresAt <= now) {
			leases.delete(actionId);
			continue;
		}
		if (lease.sessionId === sessionId) active.push(actionId);
	}
	return active;
}

/** Test/ops helper: drop all leases (control-plane state is in memory). */
export function resetExecutionLeases(): void {
	leases.clear();
}
