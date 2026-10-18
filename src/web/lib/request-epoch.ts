/**
 * Request-epoch guard for async loaders whose responses may land after the
 * context moved on (A→B tab switch). Every begin() invalidates all previous
 * guards; success, failure AND finally paths must check isCurrent() before
 * touching state — a late 404 must not navigate B away, a late success must
 * not overwrite B's detail, a late finally must not clear B's loading flag.
 * Pure logic — no React, no network.
 */
export function createRequestEpoch() {
	let epoch = 0;
	return {
		/** Starts a new request; returns its currency checker. */
		begin(): () => boolean {
			const mine = ++epoch;
			return () => mine === epoch;
		},
		/**
		 * Invalidates every in-flight guard WITHOUT starting a new request —
		 * used when the context goes away (tab switch to a non-session page,
		 * unmount) so a late response finds nothing current to touch.
		 */
		invalidate(): void {
			epoch++;
		},
	};
}
