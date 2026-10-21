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

	begin(target: string, attemptId: string, claimId: string): void {
		const attempts = this.byTarget.get(target) ?? new Map<string, AbortAttempt>();
		attempts.set(attemptId, { attemptId, claimId, responded: false, claimEnded: false });
		this.byTarget.set(target, attempts);
	}

	respond(target: string, attemptId: string): void {
		const attempt = this.byTarget.get(target)?.get(attemptId);
		if (!attempt) return;
		attempt.responded = true;
		this.settle(target, attempt);
	}

	/** The claim ended; attempts bound to it may settle if they responded. */
	claimEnded(target: string, claimId: string): void {
		const attempts = this.byTarget.get(target);
		if (!attempts) return;
		for (const attempt of attempts.values()) {
			if (attempt.claimId !== claimId) continue;
			attempt.claimEnded = true;
			this.settle(target, attempt);
		}
	}

	private settle(target: string, attempt: AbortAttempt): void {
		if (!attempt.responded || !attempt.claimEnded) return;
		const attempts = this.byTarget.get(target);
		attempts?.delete(attempt.attemptId);
		if (attempts && attempts.size === 0) this.byTarget.delete(target);
	}

	/** The native request was NEVER sent: drop the attempt, nothing to protect. */
	abandon(target: string, attemptId: string): void {
		const attempts = this.byTarget.get(target);
		attempts?.delete(attemptId);
		if (attempts && attempts.size === 0) this.byTarget.delete(target);
	}

	frozen(target: string): boolean {
		return (this.byTarget.get(target)?.size ?? 0) > 0;
	}

	pending(target: string): AbortAttempt[] {
		return [...(this.byTarget.get(target)?.values() ?? [])];
	}
}
