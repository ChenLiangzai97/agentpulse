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

/**
 * ALL leases for a session block STOP — an expired lease is UNKNOWN, not safe
 * (the native call may still be running). Only an accepted terminal result for
 * the same action+token releases it.
 */
export function activeLeases(sessionId: string): string[] {
	return [...leases.entries()]
		.filter(([, lease]) => lease.sessionId === sessionId)
		.map(([actionId]) => actionId);
}

/** Leases past their TTL: they STILL block and need reconciliation. */
export function unknownLeases(): { actionId: string; sessionId: string; expiredMs: number }[] {
	const now = Date.now();
	return [...leases.entries()]
		.filter(([, lease]) => lease.expiresAt <= now)
		.map(([actionId, lease]) => ({
			actionId,
			sessionId: lease.sessionId,
			expiredMs: now - lease.expiresAt,
		}));
}

/** Test/ops helper: drop all leases (control-plane state is in memory). */
export function resetExecutionLeases(): void {
	leases.clear();
}

/** Test/ops helper: force a lease past its TTL (it must STILL block). */
export function expireExecutionLeaseForTests(actionId: string): void {
	const lease = leases.get(actionId);
	if (lease) lease.expiresAt = Date.now() - 1;
}
