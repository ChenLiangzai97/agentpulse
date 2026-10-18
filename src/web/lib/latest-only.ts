/**
 * Guards async loads against stale-response races: only the most recently
 * started load may apply its value (a slow response for an earlier date can
 * never overwrite a newer one). Pure logic — no React, no network.
 */
export function createStaleLoadGuard<T>(apply: (value: T) => void): {
	load: (fetch: () => Promise<T>) => Promise<void>;
} {
	let epoch = 0;
	return {
		async load(fetch) {
			const mine = ++epoch;
			try {
				const value = await fetch();
				if (mine === epoch) apply(value);
			} catch {
				// network errors leave the previous state untouched
			}
		},
	};
}
