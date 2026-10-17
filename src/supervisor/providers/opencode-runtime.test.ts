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
