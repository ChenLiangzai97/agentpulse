/** Evidence captured in the controlled window before a native fork. */
export type ForkSnapshot = {
	version: 1;
	instanceId: string;
	nativeSessionId: string;
	messages: { nativeId: string; contentHash: string; occurredAt: string }[];
	forkPointMessageId: string | null;
};

/** Execution-time copy map: parent message -> child message (prefix order). */
export type ForkChildMap = {
	version: 1;
	forkPointMessageId: string | null;
	pairs: { parentNativeId: string; childNativeId: string; parentOccurredAt: string }[];
};
