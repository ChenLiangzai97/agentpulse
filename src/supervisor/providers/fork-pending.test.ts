import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOrReportFork, type ForkRecord } from "./fork-pending.js";

const identity = { actionId: "action-1", instanceId: "instance-1", generation: 3 };
const snapshot = {
	version: 1 as const,
	instanceId: "instance-1",
	nativeSessionId: "ses_parent",
	messages: [{ nativeId: "msg_1", contentHash: "h" }],
	forkPointMessageId: null,
};

async function harness(directory: string, over: Partial<Parameters<typeof executeOrReportFork>[0]> = {}) {
	const calls = { forks: 0, reports: [] as ForkRecord[], registered: [] as string[] };
	const attempt = {
		directory,
		identity,
		claimToken: "token-1",
		forkPointMessageId: null as string | null,
		capture: async () => snapshot,
		fork: async () => {
			calls.forks += 1;
			return { id: "ses_child" };
		},
		report: async (record: ForkRecord) => {
			calls.reports.push(record);
			return { token: record.claimToken };
		},
		register: (id: string) => calls.registered.push(id),
		...over,
	};
	return { attempt, calls };
}

test("crash AFTER the native fork but BEFORE the created record: never fork twice", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fork-ledger-"));
	try {
		// Simulate the crash window: the intent record is on disk, the native
		// fork may have happened. Recovery must refuse, not fork again.
		await writeFile(
			join(directory, "fork-action-1.json"),
			JSON.stringify({
				version: 1,
				...identity,
				claimToken: "token-1",
				phase: "intent",
			}),
		);
		const { attempt, calls } = await harness(directory);
		await expect(executeOrReportFork(attempt)).rejects.toThrow("opencode_fork_outcome_unknown");
		expect(calls.forks).toBe(0);
		expect(calls.reports).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a corrupt ledger fails closed instead of forking again", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fork-ledger-"));
	try {
		await writeFile(join(directory, "fork-action-1.json"), "{not json");
		const { attempt, calls } = await harness(directory);
		await expect(executeOrReportFork(attempt)).rejects.toThrow("opencode_fork_ledger_corrupt");
		expect(calls.forks).toBe(0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a ledger bound to another instance/generation is not trusted", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fork-ledger-"));
	try {
		await writeFile(
			join(directory, "fork-action-1.json"),
			JSON.stringify({
				version: 1,
				actionId: "action-1",
				instanceId: "instance-1",
				generation: 99,
				claimToken: "t",
				phase: "done",
				childNativeSessionId: "ses_child",
			}),
		);
		const { attempt, calls } = await harness(directory);
		await expect(executeOrReportFork(attempt)).rejects.toThrow("opencode_fork_ledger_corrupt");
		expect(calls.forks).toBe(0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("lost report then restart: re-report the SAME child and keep the original token", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fork-ledger-"));
	try {
		const { attempt, calls } = await harness(directory, {
			report: async (record) => {
				calls.reports.push(record);
				if (calls.reports.length === 1) throw new Error("network_lost");
				return { token: record.claimToken };
			},
		});
		await expect(executeOrReportFork(attempt)).rejects.toThrow("network_lost");
		expect(calls.forks).toBe(1);
		// Restarted supervisor re-claims with a NEW token.
		const second = await harness(directory, {
			claimToken: "token-2",
			report: async (record) => {
				calls.reports.push(record);
				return { token: record.claimToken };
			},
		});
		const outcome = await executeOrReportFork(second.attempt);
		expect(outcome).toBe("reported");
		expect(calls.forks).toBe(1);
		expect(calls.reports.map((record) => record.claimToken)).toEqual(["token-1", "token-1"]);
		expect(calls.reports.map((record) => record.childNativeSessionId)).toEqual([
			"ses_child",
			"ses_child",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a repeated claim after commit replays and re-registers the SAME child", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fork-ledger-"));
	try {
		const first = await harness(directory);
		expect(await executeOrReportFork(first.attempt)).toBe("forked");
		expect(first.calls.forks).toBe(1);
		const second = await harness(directory, { claimToken: "token-2" });
		expect(await executeOrReportFork(second.attempt)).toBe("replayed");
		expect(second.calls.forks).toBe(0);
		expect(second.calls.reports[0]?.childNativeSessionId).toBe("ses_child");
		expect(second.calls.reports[0]?.claimToken).toBe("token-1");
		expect(second.calls.registered).toEqual(["ses_child"]);
		// The completion record is kept for the life of the instance.
		expect(await readdir(directory)).toEqual(["fork-action-1.json"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a requested fork point is refused rather than silently full-forking", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fork-ledger-"));
	try {
		const { attempt, calls } = await harness(directory, { forkPointMessageId: "msg_2" });
		await expect(executeOrReportFork(attempt)).rejects.toThrow("opencode_fork_point_unsupported");
		expect(calls.forks).toBe(0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("REAL process crash right after the native fork: recovery refuses, never forks twice", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fork-ledger-"));
	try {
		const fixture = join(import.meta.dir, "__fixtures__", "fork-crash.ts");
		const child = Bun.spawn(["bun", fixture, directory, "native-fork.marker"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await child.exited;
		expect(exitCode).toBe(9); // died inside the fork callback
		const { attempt, calls } = await harness(directory, {
			identity: { actionId: "action-1", instanceId: "instance-1", generation: 1 },
		});
		await expect(executeOrReportFork(attempt)).rejects.toThrow("opencode_fork_outcome_unknown");
		// No second native fork, and the crashed run's marker is still there.
		expect(calls.forks).toBe(0);
		expect(await readdir(directory)).toContain("native-fork.marker");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("REAL HTTP 500 from the result endpoint keeps the record; retry over HTTP succeeds", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fork-ledger-"));
	let status = 500;
	const received: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			received.push(await request.json());
			return new Response("boom", { status });
		},
	});
	try {
		const endpoint = `http://127.0.0.1:${server.port}/fork-result`;
		const attempt = {
			directory,
			identity,
			claimToken: "token-1",
			forkPointMessageId: null,
			capture: async () => snapshot,
			fork: async () => ({ id: "ses_child" }),
			report: async (record: ForkRecord) => {
				const res = await fetch(endpoint, { method: "POST", body: JSON.stringify(record) });
				if (!res.ok) throw new Error(`report_${res.status}`);
				return { token: record.claimToken };
			},
			register: () => {},
		};
		await expect(executeOrReportFork(attempt)).rejects.toThrow("report_500");
		// The durable record survived the server failure.
		const { readForkRecord } = await import("./fork-pending.js");
		const record = await readForkRecord(directory, identity);
		expect(record?.phase).toBe("created");
		expect(record?.childNativeSessionId).toBe("ses_child");
		status = 200;
		const outcome = await executeOrReportFork({ ...attempt, claimToken: "token-2" });
		expect(outcome).toBe("reported");
		expect(received).toHaveLength(2);
		expect((received[1] as ForkRecord).claimToken).toBe("token-1");
		expect(await readForkRecord(directory, identity)).toMatchObject({ phase: "done" });
	} finally {
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
});
