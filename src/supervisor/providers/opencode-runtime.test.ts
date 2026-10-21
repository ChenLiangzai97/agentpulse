import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeRuntimePool, readOpenCodeProfile } from "./opencode-runtime.js";

test("profile and bounded resources fail closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "ap-profile-"));
	try {
		await expect(readOpenCodeProfile(join(root, "missing"))).rejects.toThrow("not_configured");
		const path = join(root, "profile.json");
		await writeFile(path, "{}", { mode: 0o644 });
		await expect(readOpenCodeProfile(path)).rejects.toThrow("must_be_private");
		await chmod(path, 0o600);
		await expect(readOpenCodeProfile(path)).rejects.toThrow("not_configured");
		expect(
			() =>
				new OpenCodeRuntimePool({
					executable: "opencode",
					profilePath: path,
					stateDirectory: root,
					maxInstances: 0,
					idleTimeoutMs: 60000,
					stopGraceMs: 100,
				}),
		).toThrow("resource_limits");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// Explicit opt-in: real CLI with a loopback mock, no ambient credentials or source DB.
test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"real isolated CLI lifecycle, permission and question channel",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ap-runtime-"));
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("mock exited");
			line += new TextDecoder().decode(next.value);
		}
		const port = Number(line.trim());
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "p0-fixture-key" },
						models: {
							"fixture-model": {
								name: "Fixture",
								tool_call: true,
								limit: { context: 32768, output: 2048 },
							},
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		const pool = new OpenCodeRuntimePool({
			executable: process.env.AGENTPULSE_OPENCODE_COMMAND || "opencode",
			profilePath,
			stateDirectory: join(root, "instances"),
			maxInstances: 1,
			idleTimeoutMs: 60000,
			stopGraceMs: 1000,
		});
		const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean) => {
			for (let i = 0; i < 120; i++) {
				const value = await read();
				if (ok(value)) return value;
				await Bun.sleep(250);
			}
			throw new Error("condition timeout");
		};
		try {
			const cwd = join(root, "project");
			await mkdir(cwd);
			const runtime = await pool.start({
				instanceId: "instance-test",
				generation: 1,
				sessionId: "pulse-test",
				cwd,
				title: "Runtime fixture",
			});
			expect(runtime.cwd).toBe(cwd);
			expect(runtime.nativeSessionId.startsWith("ses_")).toBe(true);
			await expect(
				pool.start({
					instanceId: "second",
					generation: 1,
					sessionId: "second",
					cwd,
					title: "second",
				}),
			).rejects.toThrow("capacity");
			await runtime.prompt("P0_PERMISSION");
			const permission = await until(
				() => runtime.snapshot(),
				(value) => value.permissions.length > 0,
			);
			const request = permission.permissions[0] as { id: string };
			await runtime.request(`/permission/${request.id}/reply`, { reply: "once" });
			await until(
				() => runtime.snapshot(),
				(value) =>
					JSON.stringify(value.messages).includes("P0_DONE") &&
					(value.status as { type: string }).type === "idle",
			);
			await runtime.prompt("P0_QUESTION");
			const question = await until(
				() => runtime.snapshot(),
				(value) => value.questions.length > 0,
			);
			const pending = question.questions[0] as { id: string };
			await runtime.request(`/question/${pending.id}/reply`, {
				answers: [["Alpha", "Beta"], ["fixture note"]],
			});
			await until(
				() => runtime.snapshot(),
				(value) =>
					value.questions.length === 0 && (value.status as { type: string }).type === "idle",
			);
			await runtime.prompt("P0_ABORT");
			await runtime.abort();
			await runtime.stop();
			expect(pool.get("pulse-test")).toBeUndefined();
			// Native history remains available for reconciliation; credentials are removed.
			expect(
				JSON.parse(await readFile(join(runtime.directory, "manifest.json"), "utf8")).instanceId,
			).toBe("instance-test");
			expect(await Bun.file(join(runtime.directory, "provider.json")).exists()).toBe(false);
		} finally {
			await pool.close();
			mock.kill();
			await mock.exited;
			await rm(root, { recursive: true, force: true });
		}
	},
	120000,
);

test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"recovery fences the owned process, restores native history and invalidates pending",
	async () => {
		const { recoverOpenCodeHistory, processStartTicks, stopRecordedOpenCodeProcess } = await import(
			"./opencode-recovery.js"
		);
		const { checkOpenCodeProfileHealth } = await import("./opencode-runtime.js");
		const root = await mkdtemp(join(tmpdir(), "ap-recovery-"));
		const stateDirectory = join(root, "instances");
		const cwd = join(root, "project");
		await mkdir(cwd);
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const r = await reader.read();
			if (r.done) throw new Error("mock exited");
			line += new TextDecoder().decode(r.value);
		}
		const path = join(root, "profile.json");
		const profile = {
			model: "p0/fixture-model",
			provider: {
				p0: {
					npm: "@ai-sdk/openai-compatible",
					options: {
						baseURL: `http://127.0.0.1:${Number(line.trim())}/v1`,
						apiKey: "p0-fixture-key",
					},
					models: {
						"fixture-model": {
							name: "Fixture",
							tool_call: true,
							limit: { context: 32768, output: 2048 },
						},
						"missing-model": { name: "Missing", limit: { context: 32768, output: 2048 } },
					},
				},
			},
		};
		await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
		const pool = new OpenCodeRuntimePool({
			executable: process.env.AGENTPULSE_OPENCODE_COMMAND ?? "opencode",
			profilePath: path,
			stateDirectory,
			maxInstances: 1,
			idleTimeoutMs: 60000,
			stopGraceMs: 1000,
		});
		try {
			expect(await checkOpenCodeProfileHealth(path)).toBe("ready");
			profile.provider.p0.options.apiKey = "wrong-fixture-key";
			await writeFile(path, JSON.stringify(profile));
			expect(await checkOpenCodeProfileHealth(path)).toBe("authentication_failed");
			profile.provider.p0.options.apiKey = "p0-fixture-key";
			profile.model = "p0/missing-model";
			await writeFile(path, JSON.stringify(profile));
			expect(await checkOpenCodeProfileHealth(path)).toBe("model_unavailable");
			profile.model = "p0/fixture-model";
			await writeFile(path, JSON.stringify(profile));
			const runtime = await pool.start({
				instanceId: "recovery-fixture",
				generation: 1,
				sessionId: "recovery-session",
				cwd,
				title: "Recovery fixture",
			});
			let sse = 0;
			const unsubscribe = runtime.subscribe(() => sse++);
			await runtime.prompt("P0_PERMISSION");
			for (let i = 0; i < 100; i++) {
				const state = await runtime.snapshot();
				if (state.permissions.length) break;
				await Bun.sleep(100);
			}
			expect((await runtime.snapshot()).permissions.length).toBe(1);
			expect(sse).toBeGreaterThan(0);
			await expect(
				stopRecordedOpenCodeProcess(runtime.directory, { pid: mock.pid, startTicks: "0", cwd }),
			).rejects.toThrow("identity_unverified");
			expect(mock.exitCode).toBeNull();
			expect(await processStartTicks(runtime.pid)).not.toBeNull();
			const recovered: { path: string; body: unknown }[] = [];
			await recoverOpenCodeHistory(stateDirectory, async (_id, path, body) => {
				recovered.push({ path, body });
			});
			expect(recovered.map((item) => item.path)).toEqual(["snapshot", "closed"]);
			const snapshot = recovered[0].body as {
				messages: unknown[];
				permissions: unknown[];
				questions: unknown[];
			};
			expect(JSON.stringify(snapshot.messages)).toContain("P0_PERMISSION");
			expect(JSON.stringify(snapshot.messages)).toContain("prt_");
			expect(snapshot.permissions).toEqual([]);
			expect(snapshot.questions).toEqual([]);
			expect(recovered[1].body).toEqual({ generation: 1, state: "interrupted" });
			unsubscribe();
			await recoverOpenCodeHistory(stateDirectory, async () => {
				throw new Error("must not replay reconciled history");
			});
		} finally {
			await pool.close();
			mock.kill();
			await mock.exited;
			await rm(root, { recursive: true, force: true });
		}
	},
	120000,
);

// Explicit opt-in: real CLI multi-session addressing (A6).
test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"real CLI: one in-flight turn per target; registered child runs in parallel with the parent",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ap-runtime-a6-"));
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("mock exited");
			line += new TextDecoder().decode(next.value);
		}
		const port = Number(line.trim());
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "p0-fixture-key" },
						models: {
							"fixture-model": {
								name: "Fixture",
								tool_call: true,
								limit: { context: 32768, output: 2048 },
							},
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		const pool = new OpenCodeRuntimePool({
			executable: process.env.AGENTPULSE_OPENCODE_COMMAND || "opencode",
			profilePath,
			stateDirectory: join(root, "instances"),
			maxInstances: 1,
			idleTimeoutMs: 60000,
			stopGraceMs: 2000,
		});
		try {
			const cwd = join(root, "project");
			await mkdir(cwd);
			const runtime = await pool.start({
				instanceId: "a6-instance",
				generation: 1,
				sessionId: "a6-parent",
				cwd,
				title: "A6 fixture",
			});
			// 1) Unknown native ids are refused (a bare id never grants execution).
			await expect(runtime.prompt("hi", { nativeSessionId: "ses_unknown" })).rejects.toThrow(
				"opencode_unknown_native_session",
			);
			// 2) A child created natively and REGISTERED via the trusted path is addressable.
			const child = (await runtime.request("/session", { title: "child" })) as { id: string };
			runtime.registerManagedChild(child.id);
			// 3) CONCURRENT same-target attempts: the synchronous pre-claim makes
			//    exactly one win even though both read their baseline concurrently.
			const raced = await Promise.allSettled([
				runtime.prompt("P0_ABORT", { nativeSessionId: child.id }),
				runtime.prompt("P0_ABORT", { nativeSessionId: child.id }),
			]);
			expect(raced.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
			const rejected = raced.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
			expect(String(rejected.reason)).toContain("opencode_session_busy");
			// A SECOND child prompt is still refused while that turn runs.
			await expect(runtime.prompt("again", { nativeSessionId: child.id })).rejects.toThrow(
				"opencode_session_busy",
			);
			// 4) CHILD-FIRST: the parent is a different target and starts its own turn.
			await runtime.prompt("P0_HELLO");
			// 5) No timer frees a claim: past the old 6s window the child turn is
			//    still running, so a second child prompt must still be refused.
			await Bun.sleep(6500);
			await runtime.snapshot();
			await expect(runtime.prompt("again", { nativeSessionId: child.id })).rejects.toThrow(
				"opencode_session_busy",
			);
			await runtime.abort(child.id);
			// 5b) ABORT IS ONLY ACCEPTANCE: right after the accepted abort the
			//     claim is still held; only a later idle snapshot with no
			//     unfinished reply to our message releases it.
			await expect(runtime.prompt("again", { nativeSessionId: child.id })).rejects.toThrow(
				"opencode_session_busy",
			);
			// Two consecutive post-abort non-busy observations are required.
			let quietSeen = 0;
			for (let i = 0; i < 40 && quietSeen < 2; i++) {
				const settled = await runtime.snapshot();
				quietSeen = settled.sessions[child.id]?.type === "busy" ? 0 : quietSeen + 1;
				await Bun.sleep(250);
			}
			// An ABORTED turn whose last step never completes stays UNKNOWN (no
			// reply, no cancellation marker): the claim is held for reconciliation,
			// so a fresh child carries the rest of the scenario.
			const child2 = (await runtime.request("/session", { title: "child2" })) as { id: string };
			runtime.registerManagedChild(child2.id);
			// 6) PARENT-FIRST: parent busy, another child still addressable.
			await runtime.prompt("P0_ABORT");
			await runtime.prompt("P0_ABORT", { nativeSessionId: child2.id });
			for (let i = 0; i < 8; i++) {
				await runtime.snapshot();
				await Bun.sleep(250);
			}
			// 6b) User message landed, reply unfinished: the claim stays held.
			await expect(runtime.prompt("again", { nativeSessionId: child2.id })).rejects.toThrow(
				"opencode_session_busy",
			);
			await runtime.abort();
			await runtime.abort(child2.id);
			await runtime.snapshot();
			await runtime.snapshot();
			await runtime.stop();
			expect(pool.get("a6-parent")).toBeUndefined();
		} finally {
			mock.kill();
			await rm(root, { recursive: true, force: true });
		}
	},
	60000,
);

// Explicit opt-in: REAL native fork + real crash, then recovery refusal.
test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"real CLI: crash right after the native fork leaves an intent that refuses to re-fork",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ap-native-fork-"));
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("mock exited");
			line += new TextDecoder().decode(next.value);
		}
		const port = Number(line.trim());
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "p0-fixture-key" },
						models: {
							"fixture-model": {
								name: "Fixture",
								tool_call: true,
								limit: { context: 32768, output: 2048 },
							},
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		const cwd = join(root, "project");
		const stateDirectory = join(root, "state");
		const marker = join(root, "native-child.json");
		const instanceId = "native-fork-instance";
		const actionId = "native-fork-action";
		try {
			const child = Bun.spawn(
				[
					"bun",
					join(import.meta.dir, "__fixtures__", "native-fork-crash.ts"),
					cwd,
					profilePath,
					stateDirectory,
					instanceId,
					actionId,
					marker,
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
			expect(await child.exited).toBe(9);
			const { child: childNative, parent } = JSON.parse(await readFile(marker, "utf8"));
			expect(childNative.startsWith("ses_")).toBe(true);
			// The ledger holds an INTENT for exactly this action/instance.
			const ledgerDirectory = join(stateDirectory, "fork-ledger", instanceId);
			const record = JSON.parse(
				await readFile(join(ledgerDirectory, `fork-${actionId}.json`), "utf8"),
			);
			expect(record.phase).toBe("intent");
			// Recovery refuses: the native fork may have happened, so forking
			// again could duplicate it. No report, no new fork.
			const { executeOrReportFork } = await import("./fork-pending.js");
			let forks = 0;
			await expect(
				executeOrReportFork({
					directory: ledgerDirectory,
					identity: { actionId, instanceId, generation: 1 },
					nativeSessionId: parent,
					claimToken: "recovery-token",
					forkPointMessageId: null,
					capture: async () => {
						throw new Error("must_not_capture");
					},
					fork: async () => {
						forks += 1;
						return { id: "ses_should_not_exist" };
					},
					report: async () => {
						throw new Error("must_not_report");
					},
					register: () => {},
				}),
			).rejects.toThrow("opencode_fork_outcome_unknown");
			expect(forks).toBe(0);
		} finally {
			mock.kill();
			await rm(root, { recursive: true, force: true });
		}
	},
	120000,
);

// Explicit opt-in: REAL native copyOf fork truncates the child history.
test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"real CLI: fork with a messageID copies only the prefix up to that message",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ap-copyof-"));
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("mock exited");
			line += new TextDecoder().decode(next.value);
		}
		const port = Number(line.trim());
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "p0-fixture-key" },
						models: {
							"fixture-model": {
								name: "Fixture",
								tool_call: true,
								limit: { context: 32768, output: 2048 },
							},
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		const pool = new OpenCodeRuntimePool({
			executable: process.env.AGENTPULSE_OPENCODE_COMMAND || "opencode",
			profilePath,
			stateDirectory: join(root, "instances"),
			maxInstances: 1,
			idleTimeoutMs: 60000,
			stopGraceMs: 1000,
		});
		const cwd = join(root, "project");
		await mkdir(cwd);
		const runtime = await pool.start({
			instanceId: "copyof-instance",
			generation: 1,
			sessionId: "copyof-parent",
			cwd,
			title: "copyOf fixture",
		});
		const messageList = async (nativeId: string) =>
			runtime.request<{ info: { id: string; role: string; parentID?: string } }[]>(
				`/session/${encodeURIComponent(nativeId)}/message`,
			);
		const waitTurn = async () => {
			for (let i = 0; i < 160; i++) {
				const snapshot = await runtime.snapshot();
				const assistants = (snapshot.messages as { info?: Record<string, unknown> }[]).filter(
					(message) => message.info?.role === "assistant",
				);
				const last = assistants.at(-1)?.info as
					| { time?: { completed?: unknown }; finish?: unknown }
					| undefined;
				if (
					(snapshot.status as { type?: string })?.type !== "busy" &&
					last?.time?.completed &&
					last?.finish !== "tool-calls"
				)
					return;
				await Bun.sleep(150);
			}
			throw new Error("turn timeout");
		};
		try {
			for (const text of ["P0_HELLO", "P0_HELLO", "P0_HELLO"]) {
				await runtime.prompt(text);
				await waitTurn();
				await runtime.snapshot(); // settle the claim
			}
			const parentMessages = await messageList(runtime.nativeSessionId);
			const users = parentMessages.filter((message) => message.info.role === "user");
			expect(users.length).toBe(3);
			const forkPoint = users[1]?.info.id;
			const snapshot = await runtime.captureForkSnapshot(forkPoint ?? null);
			expect(snapshot.messages.some((message) => message.nativeId === forkPoint)).toBe(true);
			const child = await runtime.forkSession(undefined, { messageID: forkPoint });
			const childMap = await runtime.captureChildMap(child.id, snapshot);
			const childMessages = await messageList(child.id);
			// EXECUTION-TIME copy map: child[i] <-> parent prefix[i], with the
			// parent's ORIGINAL occurrence time carried over (no id lookup).
			expect(childMap.pairs.length).toBe(childMessages.length);
			expect(childMap.pairs.map((pair) => pair.childNativeId)).toEqual(
				childMessages.map((message) => message.info.id),
			);
			expect(childMap.pairs.map((pair) => pair.parentNativeId)).toEqual(
				parentMessages.slice(0, childMessages.length).map((message) => message.info.id),
			);
			expect(childMap.pairs[0]?.parentOccurredAt).toBe(
				new Date(
					Number(
						(parentMessages[0]?.info as { time?: { created?: number } }).time?.created ?? 0,
					),
				).toISOString(),
			);
			// copyOf EVIDENCE: the native fork point is EXCLUSIVE and ids are
			// REMAPPED — the child keeps only the history BEFORE the named
			// message (so a 3-turn parent forked at user #2 keeps 1 user turn),
			// and none of the parent's message ids survive.
			expect(childMessages.length).toBeLessThan(parentMessages.length);
			const childUsers = childMessages.filter((message) => message.info.role === "user");
			expect(childUsers.length).toBe(1);
			const parentIds = new Set(parentMessages.map((message) => message.info.id));
			expect(childMessages.some((message) => parentIds.has(message.info.id))).toBe(false);
			await runtime.stop();
		} finally {
			mock.kill();
			await rm(root, { recursive: true, force: true });
		}
	},
	120000,
);


// Explicit opt-in: durable unsettled claims survive a runtime restart.
test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"real CLI: an in-flight claim survives a restart as an unsettled record",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ap-unsettled-"));
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("mock exited");
			line += new TextDecoder().decode(next.value);
		}
		const port = Number(line.trim());
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "p0-fixture-key" },
						models: {
							"fixture-model": { name: "Fixture", tool_call: true, limit: { context: 32768, output: 2048 } },
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		const cwd = join(root, "project");
		await mkdir(cwd);
		const stateDirectory = join(root, "state");
		const instanceId = "unsettled-instance";
		const makePool = () =>
			new OpenCodeRuntimePool({
				executable: process.env.AGENTPULSE_OPENCODE_COMMAND || "opencode",
				profilePath,
				stateDirectory,
				maxInstances: 1,
				idleTimeoutMs: 60000,
				stopGraceMs: 1000,
			});
		try {
			const first = await makePool().start({
				instanceId,
				generation: 1,
				sessionId: "unsettled-session",
				cwd,
				title: "unsettled",
			});
			// A COMPLETED claim leaves no durable record.
			await first.prompt("P0_HELLO");
			const { readdir } = await import("node:fs/promises");
			for (let i = 0; i < 120; i++) {
				await first.snapshot();
				const records = await readdir(join(stateDirectory, "claims", instanceId));
				if (records.length === 0) break;
				await Bun.sleep(100);
			}
			expect(await readdir(join(stateDirectory, "claims", instanceId))).toEqual([]);
			// An IN-FLIGHT claim is persisted and survives the stop.
			await first.prompt("P0_ABORT");
			const oldNative = first.nativeSessionId;
			await first.stop();
			const second = await makePool().start({
				instanceId,
				generation: 1,
				sessionId: "unsettled-session-2",
				cwd,
				title: "unsettled restarted",
			});
			const claims = second.unsettledClaims();
			expect(claims.map((claim) => claim.nativeSessionId)).toContain(oldNative);
			// The stale native id is NOT addressable from the new runtime, and the
			// record stays visible for reconciliation (never silently dropped).
			await expect(second.prompt("x", { nativeSessionId: oldNative })).rejects.toThrow(
				"opencode_unknown_native_session",
			);
			expect(second.unsettledClaims().length).toBe(1);
			await second.stop();
		} finally {
			mock.kill();
			await rm(root, { recursive: true, force: true });
		}
	},
	120000,
);


// Explicit opt-in: claim records fail CLOSED.
test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"real CLI: an unreadable claim record quarantines the instance",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ap-quarantine-"));
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("mock exited");
			line += new TextDecoder().decode(next.value);
		}
		const port = Number(line.trim());
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "p0-fixture-key" },
						models: {
							"fixture-model": { name: "Fixture", tool_call: true, limit: { context: 32768, output: 2048 } },
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		const cwd = join(root, "project");
		await mkdir(cwd);
		const stateDirectory = join(root, "state");
		const instanceId = "quarantine-instance";
		const claimsDir = join(stateDirectory, "claims", instanceId);
		await mkdir(claimsDir, { recursive: true });
		await writeFile(join(claimsDir, "broken.json"), "{not json");
		const pool = new OpenCodeRuntimePool({
			executable: process.env.AGENTPULSE_OPENCODE_COMMAND || "opencode",
			profilePath,
			stateDirectory,
			maxInstances: 1,
			idleTimeoutMs: 60000,
			stopGraceMs: 1000,
		});
		try {
			const runtime = await pool.start({
				instanceId,
				generation: 1,
				sessionId: "quarantine-session",
				cwd,
				title: "quarantine",
			});
			// FAIL CLOSED: even the bound session cannot execute until the claim
			// state is reconciled — no silent fail-open.
			await expect(runtime.prompt("P0_HELLO")).rejects.toThrow("opencode_claims_quarantine");
			// The unreadable record was kept for audit.
			const { readdir } = await import("node:fs/promises");
			expect(await readdir(claimsDir)).toContain("broken.json");
			await runtime.stop();
		} finally {
			mock.kill();
			await rm(root, { recursive: true, force: true });
		}
	},
	120000,
);

test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"real CLI: abort is mirrored into the durable claim record",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ap-abort-record-"));
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("mock exited");
			line += new TextDecoder().decode(next.value);
		}
		const port = Number(line.trim());
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "p0-fixture-key" },
						models: {
							"fixture-model": { name: "Fixture", tool_call: true, limit: { context: 32768, output: 2048 } },
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		const cwd = join(root, "project");
		await mkdir(cwd);
		const stateDirectory = join(root, "state");
		const instanceId = "abort-record-instance";
		const claimsDir = join(stateDirectory, "claims", instanceId);
		const pool = new OpenCodeRuntimePool({
			executable: process.env.AGENTPULSE_OPENCODE_COMMAND || "opencode",
			profilePath,
			stateDirectory,
			maxInstances: 1,
			idleTimeoutMs: 60000,
			stopGraceMs: 1000,
		});
		try {
			const runtime = await pool.start({
				instanceId,
				generation: 1,
				sessionId: "abort-record-session",
				cwd,
				title: "abort record",
			});
			await runtime.prompt("P0_ABORT");
			const { readdir } = await import("node:fs/promises");
			const [recordName] = await readdir(claimsDir);
			expect(recordName).toBeTruthy();
			await runtime.abort();
			await Bun.sleep(300);
			const record = JSON.parse(await readFile(join(claimsDir, String(recordName)), "utf8"));
			// The abort attempt is part of the durable evidence, not just a message id.
			expect(record.abortRequested).toBe(true);
			expect(record.kind).toBe("prompt");
			expect(record.nativeSessionId).toBe(runtime.nativeSessionId);
			await runtime.stop();
		} finally {
			mock.kill();
			await rm(root, { recursive: true, force: true });
		}
	},
	120000,
);
