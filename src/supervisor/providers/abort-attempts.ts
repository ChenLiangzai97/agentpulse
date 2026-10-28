/**
 * Tracks in-flight ABORT attempts per native target. A target stays frozen for
 * new deliveries while ANY attempt is unresolved, where "resolved" means BOTH:
 * the native request has responded AND the claim it was aimed at has ended.
 * Claim release alone must never lift the fence (the request may still be in
 * flight and could kill a replacement turn), and a repeated abort is a
 * separate attempt — never collapsed into one boolean.
 */
export interface AbortAttempt {
	attemptId: string;
	claimId: string;
	responded: boolean;
	claimEnded: boolean;
}

export class AbortAttempts {
	private readonly byTarget = new Map<string, Map<string, AbortAttempt>>();

	begin(target: string, attemptId: string, claimId: string, claimEnded = false): void {
		const attempts = this.byTarget.get(target) ?? new Map<string, AbortAttempt>();
		attempts.set(attemptId, { attemptId, claimId, responded: false, claimEnded });
		this.byTarget.set(target, attempts);
	}

	/** Returns true when this response settled (and removed) the attempt. */
	respond(target: string, attemptId: string): boolean {
		const attempt = this.byTarget.get(target)?.get(attemptId);
		if (!attempt) return false;
		attempt.responded = true;
		return this.settle(target, attempt);
	}

	/**
	 * The claim ended. Returns the attempts that became settled NOW, so the
	 * caller can remove exactly their durable records (the tracker no longer
	 * exposes them afterwards).
	 */
	claimEnded(target: string, claimId: string): AbortAttempt[] {
		const attempts = this.byTarget.get(target);
		if (!attempts) return [];
		const settled: AbortAttempt[] = [];
		for (const attempt of attempts.values()) {
			if (attempt.claimId !== claimId) continue;
			attempt.claimEnded = true;
			if (this.settle(target, attempt)) settled.push(attempt);
		}
		return settled;
	}

	/** Returns true when the attempt was settled (and removed) by this call. */
	private settle(target: string, attempt: AbortAttempt): boolean {
		if (!attempt.responded || !attempt.claimEnded) return false;
		const attempts = this.byTarget.get(target);
		attempts?.delete(attempt.attemptId);
		if (attempts && attempts.size === 0) this.byTarget.delete(target);
		return true;
	}

	/** The native request was NEVER sent: drop the attempt, nothing to protect. */
	abandon(target: string, attemptId: string): void {
		const attempts = this.byTarget.get(target);
		attempts?.delete(attemptId);
		if (attempts && attempts.size === 0) this.byTarget.delete(target);
	}

	/**
	 * A VERIFIED terminal observation (after the response) settles only the
	 * attempts that already responded; an attempt whose request never responded
	 * stays UNKNOWN and keeps blocking.
	 */
	settleResponded(target: string): AbortAttempt[] {
		const attempts = this.byTarget.get(target);
		if (!attempts) return [];
		const settled: AbortAttempt[] = [];
		for (const attempt of [...attempts.values()]) {
			if (!attempt.responded) continue;
			// A standalone attempt has no claim whose end could be awaited: the
			// verified terminal observation is its second condition.
			if (attempt.claimId === "") attempt.claimEnded = true;
			if (this.settle(target, attempt)) settled.push(attempt);
		}
		return settled;
	}

	frozen(target: string): boolean {
		return (this.byTarget.get(target)?.size ?? 0) > 0;
	}

	pending(target: string): AbortAttempt[] {
		return [...(this.byTarget.get(target)?.values() ?? [])];
	}
}
