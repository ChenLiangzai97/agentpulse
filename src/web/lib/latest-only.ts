/**
 * Guards async loads against stale-response races. Two dimensions must both
 * hold before a value is applied:
 *  1. recency — only the most recently STARTED load wins (a slow response for
 *     an earlier request can never overwrite a newer one), and
 *  2. identity — the load's identity token (e.g. the date it was issued for)
 *     must still be the CURRENT identity. This closes the completion-race:
 *     an action started on date A that finishes after the user switched to B
 *     would otherwise refresh A's data over B even though it started last.
 * Pure logic — no React, no network.
 */
export function createStaleLoadGuard<T, I>(
	apply: (value: T) => void,
): {
	setIdentity: (identity: I) => void;
	load: (identity: I, fetch: () => Promise<T>) => Promise<void>;
} {
	let epoch = 0;
	let currentIdentity: I | undefined;
	let hasIdentity = false;
	return {
		setIdentity(identity) {
			currentIdentity = identity;
			hasIdentity = true;
			epoch++; // invalidate everything in flight for the previous identity
		},
		async load(identity, fetch) {
			const mine = ++epoch;
			try {
				const value = await fetch();
				if (mine !== epoch) return;
				if (hasIdentity && identity !== currentIdentity) return;
				apply(value);
			} catch {
				// network errors leave the previous state untouched
			}
		},
	};
}
