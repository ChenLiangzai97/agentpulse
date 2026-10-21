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
			// USER MESSAGE ONLY IS NOT COMPLETION: the parent turn is left running
			// (no abort, no reply yet) — its claim must survive every snapshot.
			// 6) PARENT-FIRST: parent busy, child still addressable immediately.
			await runtime.prompt("P0_ABORT");
			await runtime.prompt("P0_ABORT", { nativeSessionId: child.id });
			for (let i = 0; i < 8; i++) {
				await runtime.snapshot();
				await Bun.sleep(250);
			}
			// 6b) A LOST/RESENT delivery outcome is unknown: the claim stays held
			//     even though the turn's user message has landed.
			await expect(runtime.prompt("again", { nativeSessionId: child.id })).rejects.toThrow(
				"opencode_session_busy",
			);
			await runtime.abort();
			await runtime.abort(child.id);
			// Two post-abort observations are required before the claim settles.
			for (let i = 0; i < 40; i++) {
				await runtime.snapshot();
				await Bun.sleep(250);
				if (i >= 1) break;
			}
			// 5c) STALE SNAPSHOT: one STARTED before a claim must not settle it,
			//     even though it returns after the claim with an idle status.
			const stale = runtime.snapshot();
			await runtime.prompt("P0_ABORT", { nativeSessionId: child.id });
			await stale;
			await expect(runtime.prompt("again", { nativeSessionId: child.id })).rejects.toThrow(
				"opencode_session_busy",
			);
			await runtime.abort(child.id);
			// 5d) STALE SNAPSHOT AROUND ABORT: a snapshot started before the abort
			//     cannot prove termination.
			const beforeAbort = runtime.snapshot();
			await runtime.abort(child.id);
			await beforeAbort;
			await expect(runtime.prompt("again", { nativeSessionId: child.id })).rejects.toThrow(
				"opencode_session_busy",
			);
			await runtime.snapshot();
			await runtime.snapshot();
			await runtime.prompt("P0_HELLO", { nativeSessionId: child.id });
			await runtime.stop();
			expect(pool.get("a6-parent")).toBeUndefined();
		} finally {
			mock.kill();
			await rm(root, { recursive: true, force: true });
		}
	},
	60000,
);
