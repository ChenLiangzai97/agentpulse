/** Evidence captured in the controlled window before a native fork. */
export type ForkSnapshot = {
	version: 1;
	instanceId: string;
	nativeSessionId: string;
	messages: { nativeId: string; contentHash: string }[];
	forkPointMessageId: string | null;
};
