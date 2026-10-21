/**
 * Test fixture: performs the native fork (marker file) and dies IMMEDIATELY
 * afterwards, before the ledger can record the created child. Used to prove
 * the recovery path never forks twice across a real process crash.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeOrReportFork } from "../fork-pending.js";

const [directory, marker] = process.argv.slice(2);
await executeOrReportFork({
	directory,
	identity: { actionId: "action-1", instanceId: "instance-1", generation: 1 },
	claimToken: "token-1",
	forkPointMessageId: null,
	capture: async () => ({
		version: 1 as const,
		instanceId: "instance-1",
		nativeSessionId: "ses_parent",
		messages: [],
		forkPointMessageId: null,
	}),
	fork: async () => {
		await writeFile(join(directory, marker), "forked");
		process.exit(9);
	},
	report: async () => {},
	register: () => {},
});
