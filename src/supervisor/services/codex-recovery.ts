import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import type { LaunchRequest } from "../../shared/types.js";

export interface CodexRecovery {
	launch: LaunchRequest;
	threadId: string;
}
function path() {
	return join(
		process.env.AGENTPULSE_STATE_DIR || join(homedir(), ".agentpulse"),
		"codex-recovery.json",
	);
}
export function readCodexRecovery(): Record<string, CodexRecovery> {
	let fd: number;
	try {
		fd = openSync(path(), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
			throw new Error("Invalid Codex recovery store");
		return JSON.parse(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
}
export function saveCodexRecovery(launch: LaunchRequest, threadId: string) {
	const rows = readCodexRecovery();
	rows[launch.launchCorrelationId] = {
		launch: {
			...launch,
			env: {},
			baseInstructions: "",
			taskPrompt: "",
			launchSpec: {} as LaunchRequest["launchSpec"],
			metadata: null,
			providerLaunchMetadata: null,
			routingDecision: null,
			validationSummary: null,
			validationWarnings: [],
			error: null,
		},
		threadId,
	};
	const target = path();
	mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
	writePrivateFileAtomicNoFollow(target, JSON.stringify(rows));
}
export function forgetCodexRecovery(sessionId: string) {
	const rows = readCodexRecovery();
	delete rows[sessionId];
	writePrivateFileAtomicNoFollow(path(), JSON.stringify(rows));
}
