import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
/**
 * P2 real-daemon probe (opt-in; requires local OpenCode 1.18.35 + Python 3).
 *
 * Proves the ONE thing this slice can close:
 *   1. A detached run service OWNS a REAL OpenCode process and native turn.
 *   2. Supervisor A (a process) exits WHILE the turn is in flight; the daemon,
 *      OpenCode and the turn survive.
 *   3. A DIFFERENT process B reconnects with the SAME resolver and retrieves
 *      the terminal result of the SAME nativeSessionId/messageID turn.
 *   4. Wrong token / forged start ticks / wrong generation / wrong native id /
 *      service self-report drift / redirect / non-loopback are all refused by
 *      the same resolver + adapter.
 *
 * The model is a deterministic loopback fixture (mock_model.py); OpenCode and
 * every process are real. The script always reclaims only the processes it
 * started, after re-verifying their launch identity (start ticks), and removes
 * its private state root.
 */
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { turnTerminal } from "../../src/supervisor/providers/claim-evidence.js";
import {
	processStartTicks,
	stopRecordedOpenCodeProcess,
} from "../../src/supervisor/providers/opencode-recovery.js";
import {
	connectRunService,
	createRunServiceStore,
	fetchRunServiceIdentity,
	fetchRunServiceMessages,
	requestRunService,
	shutdownRunService,
} from "../../src/supervisor/providers/run-service-connection.js";
import {
	type RunServiceManifest,
	resolveRunService,
} from "../../src/supervisor/providers/run-service-resolver.js";

const instanceId = `p2-real-${crypto.randomUUID().slice(0, 8)}`;
const generation = 7;
const root = await mkdtemp(join(tmpdir(), "ap-p2-real-"));
const runServiceRoot = join(root, "run-service");
const stateDirectory = join(root, "opencode-state");
const cwd = join(root, "project");
const profilePath = join(root, "profile.json");
const evidence: Record<string, unknown> = { instanceId, generation };
const cleanupLog: string[] = [];

let daemonPid: number | null = null;
let daemonStartTicks: string | null = null;
let nativePid: number | null = null;
let nativeStartTicks: string | null = null;
let mockPid: number | null = null;
let mockStartTicks: string | null = null;
let launcherPid: number | null = null;
let launcherStartTicks: string | null = null;
let mockBase = "";
let store: ReturnType<typeof createRunServiceStore> | null = null;

const alive = async (pid: number | null, ticks: string | null) => {
	if (!pid || !ticks) return false;
	return (await processStartTicks(pid)) === ticks;
};
const readJson = async (path: string) =>
	JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
const lastJsonLine = (text: string) => {
	for (const line of text.trim().split("\n").reverse()) {
		try {
			return JSON.parse(line) as Record<string, unknown>;
		} catch {
			// diagnostics may precede the result line
		}
	}
	return null;
};
const stopVerified = async (pid: number | null, ticks: string | null, label: string) => {
	if (!(await alive(pid, ticks))) return `${label}:already_gone`;
	try {
		process.kill(pid as number, "SIGTERM");
	} catch {}
	for (let index = 0; index < 30; index++) {
		if (!(await alive(pid, ticks))) return `${label}:sigterm`;
		await Bun.sleep(100);
	}
	try {
		process.kill(pid as number, "SIGKILL");
	} catch {}
	await Bun.sleep(100);
	return (await alive(pid, ticks)) ? `${label}:still_alive` : `${label}:sigkill`;
};
const procCmdline = async (pid: number) => {
	try {
		return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
	} catch {
		return [];
	}
};

try {
	await mkdir(cwd, { recursive: true, mode: 0o700 });
	await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

	// 1. Deterministic loopback model fixture (the ONLY mock).
	const mock = Bun.spawn(["python3", join(import.meta.dir, "mock_model.py")], {
		stdout: "pipe",
		stderr: "ignore",
	});
	mockPid = mock.pid;
	mockStartTicks = await processStartTicks(mock.pid);
	const reader = mock.stdout.getReader();
	let mockLine = "";
	while (!mockLine.includes("\n")) {
		const chunk = await reader.read();
		if (chunk.done) throw new Error("mock_exited");
		mockLine += new TextDecoder().decode(chunk.value);
	}
	mockBase = `http://127.0.0.1:${Number(mockLine.trim())}`;
	evidence.mock = { pid: mockPid, startTicks: mockStartTicks, base: mockBase };

	await writeFile(
		profilePath,
		JSON.stringify({
			model: "p2/fixture-model",
			provider: {
				p2: {
					npm: "@ai-sdk/openai-compatible",
					options: { baseURL: `${mockBase}/v1`, apiKey: "p0-fixture-key" },
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

	// 2. Supervisor A's launcher starts the REAL daemon detached and exits.
	const launcher = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "p2-real-launcher.ts"),
			runServiceRoot,
			instanceId,
			String(generation),
			cwd,
			profilePath,
			stateDirectory,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	launcherPid = launcher.pid;
	launcherStartTicks = await processStartTicks(launcher.pid);
	const launcherOut = await new Response(launcher.stdout).text();
	const launcherErr = await new Response(launcher.stderr).text();
	const launcherCode = await launcher.exited;
	if (launcherCode !== 0) throw new Error(`launcher_failed:${launcherErr.trim()}`);
	const launched = lastJsonLine(launcherOut);
	if (typeof launched?.launchedPid !== "number") throw new Error("launcher_no_pid");
	daemonPid = launched.launchedPid;
	daemonStartTicks =
		typeof launched.startTicks === "string"
			? launched.startTicks
			: await processStartTicks(daemonPid);
	evidence.launcher = {
		pid: launcherPid,
		startTicks: launcherStartTicks,
		exitCode: launcherCode,
		daemonPid,
		daemonStartTicks,
	};

	// 3. Wait for the service-authored protected manifest (or a reported startup
	//    failure), then authenticate through the shared resolver.
	const runStore = createRunServiceStore(runServiceRoot);
	store = runStore;
	const statusPath = join(stateDirectory, "daemon-status.json");
	let manifest: RunServiceManifest | null = null;
	for (let index = 0; index < 600 && !manifest; index++) {
		try {
			manifest = await runStore.readManifest(instanceId);
			break;
		} catch {
			let daemonStatus: Record<string, unknown> | null = null;
			try {
				daemonStatus = await readJson(statusPath);
			} catch {}
			if (daemonStatus?.phase === "failed")
				throw new Error(`daemon_startup_failed:${String(daemonStatus.error)}`);
			if (!(await alive(daemonPid, daemonStartTicks)))
				throw new Error("daemon_exited_before_manifest");
			await Bun.sleep(100);
		}
	}
	if (!manifest) throw new Error("manifest_timeout");
	if (manifest.pid !== daemonPid) throw new Error("manifest_pid_mismatch");
	if (manifest.startTicks !== daemonStartTicks) throw new Error("manifest_start_ticks_mismatch");
	const expected = {
		instanceId,
		generation: manifest.generation,
		nativeSessionId: manifest.nativeSessionId,
	};
	const initial = await connectRunService(runServiceRoot, instanceId, expected);
	if (!initial.ok) throw new Error(`initial_connect_refused:${initial.reason}`);
	const token = await runStore.readToken(instanceId);
	const daemonStatus = await readJson(statusPath).catch(() => null);
	let instanceDirectory =
		typeof daemonStatus?.instanceDirectory === "string" ? daemonStatus.instanceDirectory : null;
	if (!instanceDirectory) {
		for (const name of await readdir(stateDirectory)) {
			if (!/^instance-[A-Za-z0-9_-]+$/.test(name)) continue;
			const candidate = join(stateDirectory, name);
			if (await Bun.file(join(candidate, "manifest.json")).exists()) {
				instanceDirectory = candidate;
				break;
			}
		}
	}
	if (!instanceDirectory) throw new Error("native_instance_directory_missing");
	// The pool's own private instance manifest is the authority for the native pid.
	const runtimeManifest = await readJson(join(instanceDirectory, "manifest.json"));
	nativePid = Number(runtimeManifest.pid);
	nativeStartTicks =
		typeof runtimeManifest.startTicks === "string" ? runtimeManifest.startTicks : null;
	if (!(await alive(nativePid, nativeStartTicks))) throw new Error("native_opencode_not_alive");
	const nativeCmdline = await procCmdline(nativePid as number);
	if (!nativeCmdline.includes("serve") || !nativeCmdline.includes("--pure"))
		throw new Error("native_opencode_identity_mismatch");
	evidence.daemon = {
		pid: daemonPid,
		startTicks: daemonStartTicks,
		url: manifest.url,
		nativeSessionId: manifest.nativeSessionId,
		nativePid,
		nativeStartTicks,
		instanceDirectory: basename(instanceDirectory),
		nativeFlags: ["serve", "--pure"],
	};
	evidence.identity = initial.identity;

	// 4. Supervisor A delivers the turn and exits WHILE it is in flight.
	const supervisorA = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "p2-real-supervisor.ts"),
			"--role",
			"a",
			"--root",
			runServiceRoot,
			"--instance",
			instanceId,
			"--generation",
			String(generation),
			"--native",
			manifest.nativeSessionId,
			"--timeout",
			"25000",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const aOut = await new Response(supervisorA.stdout).text();
	const aErr = await new Response(supervisorA.stderr).text();
	const aCode = await supervisorA.exited;
	const aResult = lastJsonLine(aOut);
	if (aCode !== 0 || aResult?.ok !== true)
		throw new Error(`supervisor_a_failed:${String(aResult?.error ?? aErr.trim())}`);
	evidence.supervisorA = { ...aResult, exitCode: aCode };
	const messageID = String(aResult.messageID);

	// A is GONE. The daemon, its OpenCode child and the SAME turn must still be
	// in flight right now (not "after it finished").
	const viewAfterA = await fetchRunServiceMessages(manifest.url, token, { timeoutMs: 5000 });
	const afterA = (viewAfterA.body ?? {}) as {
		messages?: unknown[];
		status?: { type?: string };
	};
	// The model request may land a tick after the native turn becomes busy.
	let modelRequestStarted = false;
	for (let index = 0; index < 40 && !modelRequestStarted; index++) {
		const mockState = (await (await fetch(`${mockBase}/__state`)).json()) as {
			abort_started?: boolean;
		};
		modelRequestStarted = mockState.abort_started === true;
		if (!modelRequestStarted) await Bun.sleep(50);
	}
	const survivors = {
		daemonAlive: await alive(daemonPid, daemonStartTicks),
		nativeAlive: await alive(nativePid, nativeStartTicks),
		modelRequestStarted,
		status: afterA.status?.type,
		turnTerminal: turnTerminal(afterA.messages ?? [], messageID),
		userMessagePresent: (afterA.messages ?? []).some(
			(item) =>
				(item as { info?: { id?: unknown; role?: unknown } }).info?.id === messageID &&
				(item as { info?: { role?: unknown } }).info?.role === "user",
		),
	};
	evidence.survivedSupervisorExit = survivors;
	if (!survivors.daemonAlive) throw new Error("daemon_died_with_supervisor");
	if (!survivors.nativeAlive) throw new Error("native_opencode_died_with_supervisor");
	if (!survivors.userMessagePresent) throw new Error("turn_message_missing_after_a_exit");
	if (survivors.turnTerminal) throw new Error("turn_finished_before_a_exit");
	if (survivors.status !== "busy")
		throw new Error(`turn_not_busy_after_a_exit:${survivors.status}`);

	// 5. Supervisor B is a SEPARATE process: same resolver, same turn, until the
	//    real runtime reports the terminal assistant step.
	const supervisorB = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "p2-real-supervisor.ts"),
			"--role",
			"b",
			"--root",
			runServiceRoot,
			"--instance",
			instanceId,
			"--generation",
			String(generation),
			"--native",
			manifest.nativeSessionId,
			"--message-id",
			messageID,
			"--timeout",
			"30000",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const bOut = await new Response(supervisorB.stdout).text();
	const bErr = await new Response(supervisorB.stderr).text();
	const bCode = await supervisorB.exited;
	const bResult = lastJsonLine(bOut);
	evidence.supervisorB = { ...bResult, exitCode: bCode };
	if (bCode !== 0 || bResult?.ok !== true)
		throw new Error(`supervisor_b_failed:${String(bResult?.error ?? bErr.trim())}`);
	const terminal = bResult.terminal as Record<string, unknown> | undefined;
	const assistant = terminal?.assistant as Record<string, unknown> | undefined;
	if (terminal?.connectedWhileInFlight !== true)
		throw new Error("supervisor_b_connected_after_finish");
	if (terminal?.messageID !== messageID) throw new Error("supervisor_b_wrong_message");
	if (terminal?.sameNativeSessionId !== true) throw new Error("supervisor_b_wrong_native");
	if (assistant?.parentID !== messageID) throw new Error("terminal_not_for_same_turn");
	if (assistant.completedAt === null) throw new Error("terminal_missing_runtime_time");
	if (typeof terminal?.text !== "string" || !terminal.text.includes("P0_DONE"))
		throw new Error("terminal_missing_runtime_content");
	evidence.sameTurn = {
		nativeSessionId:
			(terminal.identity as Record<string, unknown>).nativeSessionId === manifest.nativeSessionId,
		messageID: terminal.messageID === messageID,
		assistantParentID: assistant.parentID === messageID,
		terminalFromRuntime: true,
	};

	// 6. Negative cases: SAME resolver + SAME adapter.
	const realDeps = {
		startTicks: (pid: number) => processStartTicks(pid),
		readToken: () => runStore.readToken(instanceId),
		fetchIdentity: (url: string, bearer: string) =>
			fetchRunServiceIdentity(url, bearer, { timeoutMs: 5000 }),
	};
	const refusals: Record<string, unknown> = {};
	refusals.wrongToken = await resolveRunService(manifest, expected, {
		...realDeps,
		readToken: async () => "wrong-token",
	});
	refusals.wrongTokenHttp = await fetchRunServiceIdentity(manifest.url, "wrong-token", {
		timeoutMs: 5000,
	});
	refusals.forgedStartTicks = await resolveRunService(
		{ ...manifest, startTicks: "0" },
		expected,
		realDeps,
	);
	refusals.wrongGeneration = await resolveRunService(
		manifest,
		{ ...expected, generation: generation + 1 },
		realDeps,
	);
	refusals.wrongNativeSession = await resolveRunService(
		manifest,
		{ ...expected, nativeSessionId: "ses_forged" },
		realDeps,
	);
	refusals.nonLoopback = await resolveRunService(
		{ ...manifest, url: "http://10.255.255.1:9" },
		expected,
		realDeps,
	);
	try {
		await fetchRunServiceIdentity("http://10.255.255.1:9", token);
		refusals.nonLoopbackAdapter = "ACCEPTED";
	} catch (error) {
		refusals.nonLoopbackAdapter = (error as Error).message;
	}
	try {
		await requestRunService(manifest.url, token, {
			path: "http://10.255.255.1:9/identity",
			timeoutMs: 1000,
		});
		refusals.retargetedPath = "ACCEPTED";
	} catch (error) {
		refusals.retargetedPath = (error as Error).message;
	}

	// A loopback service that ANSWERS but drifts from the manifest must fail
	// identity comparison (the service's self-report is never trusted alone).
	const drifted = createServer((request, response) => {
		if (request.headers.authorization !== `Basic ${btoa(`agentpulse:${token}`)}`) {
			response.writeHead(401).end();
			return;
		}
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ ...initial.identity, nativeSessionId: "ses_service_drift" }));
	});
	await new Promise<void>((resolve) => drifted.listen(0, "127.0.0.1", resolve));
	const driftedPort = (drifted.address() as { port: number }).port;
	refusals.serviceSelfReportDrift = await resolveRunService(
		{ ...manifest, url: `http://127.0.0.1:${driftedPort}` },
		expected,
		realDeps,
	);
	await new Promise<void>((resolve) => drifted.close(() => resolve()));

	const redirect = createServer((_request, response) => {
		response.writeHead(302, { Location: "http://10.255.255.1:9/identity" }).end();
	});
	await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
	const redirectPort = (redirect.address() as { port: number }).port;
	try {
		await fetchRunServiceIdentity(`http://127.0.0.1:${redirectPort}`, token, {
			timeoutMs: 2000,
		});
		refusals.redirect = "ACCEPTED";
	} catch (error) {
		refusals.redirect = (error as Error).message;
	}
	await new Promise<void>((resolve) => redirect.close(() => resolve()));

	evidence.refusals = refusals;
	if ((refusals.wrongToken as { reason?: string }).reason !== "authentication_failed")
		throw new Error("wrong_token_not_refused");
	if ((refusals.wrongTokenHttp as { status?: number }).status !== 401)
		throw new Error("wrong_token_http_not_401");
	if ((refusals.forgedStartTicks as { reason?: string }).reason !== "process_gone_or_reused")
		throw new Error("forged_start_ticks_not_refused");
	if ((refusals.wrongGeneration as { reason?: string }).reason !== "identity_mismatch")
		throw new Error("wrong_generation_not_refused");
	if ((refusals.wrongNativeSession as { reason?: string }).reason !== "identity_mismatch")
		throw new Error("wrong_native_not_refused");
	if ((refusals.nonLoopback as { reason?: string }).reason !== "not_loopback")
		throw new Error("non_loopback_not_refused");
	if (refusals.nonLoopbackAdapter !== "run_service_not_loopback")
		throw new Error("non_loopback_adapter_not_refused");
	if (refusals.retargetedPath !== "run_service_invalid_path")
		throw new Error("retargeted_path_not_refused");
	if ((refusals.serviceSelfReportDrift as { reason?: string }).reason !== "identity_mismatch")
		throw new Error("service_drift_not_refused");
	if (refusals.redirect !== "run_service_redirect_refused") throw new Error("redirect_not_refused");

	evidence.ok = true;
} catch (error) {
	evidence.ok = false;
	evidence.error = error instanceof Error ? error.message : String(error);
} finally {
	// Authenticated shutdown first (the service stops its OWN OpenCode child).
	if (store && (await alive(daemonPid, daemonStartTicks))) {
		try {
			const current = await store.readManifest(instanceId);
			const currentToken = await store.readToken(instanceId);
			const response = await shutdownRunService(current.url, currentToken, {
				timeoutMs: 5000,
			});
			cleanupLog.push(`shutdown:${response.status}`);
		} catch (error) {
			cleanupLog.push(`shutdown_error:${(error as Error).message}`);
		}
		for (let index = 0; index < 50; index++) {
			if (!(await alive(daemonPid, daemonStartTicks))) break;
			await Bun.sleep(100);
		}
	}
	if (await alive(daemonPid, daemonStartTicks))
		cleanupLog.push(await stopVerified(daemonPid, daemonStartTicks, "daemon"));
	else if (daemonPid) cleanupLog.push("daemon:gone_after_shutdown");

	// The native child is a child of the DAEMON. If the daemon could not stop it,
	// reclaim it only after verifying pid+start ticks+cwd+cmdline+env.
	try {
		const candidates: string[] = [];
		for (const name of await readdir(stateDirectory).catch(() => [] as string[])) {
			if (/^instance-[A-Za-z0-9_-]+$/.test(name)) candidates.push(join(stateDirectory, name));
		}
		for (const directory of candidates) {
			let runtimeManifest: Record<string, unknown>;
			try {
				runtimeManifest = await readJson(join(directory, "manifest.json"));
			} catch {
				continue;
			}
			const pid = Number(runtimeManifest.pid);
			const ticks =
				typeof runtimeManifest.startTicks === "string" ? runtimeManifest.startTicks : null;
			if (!(await alive(pid, ticks))) continue;
			try {
				await stopRecordedOpenCodeProcess(directory, {
					pid,
					startTicks: ticks,
					cwd: String(runtimeManifest.cwd ?? ""),
				});
				cleanupLog.push(`native:identity_verified_stop:${pid}`);
			} catch (error) {
				cleanupLog.push(`native_stop_error:${(error as Error).message}`);
				const flags = await procCmdline(pid);
				if (flags.includes("serve") && flags.includes("--pure"))
					cleanupLog.push(await stopVerified(pid, ticks, "native"));
				else cleanupLog.push(`native:identity_unverified_skipped:${pid}`);
			}
		}
	} catch (error) {
		cleanupLog.push(`native_reap_error:${(error as Error).message}`);
	}
	if (nativePid)
		cleanupLog.push(
			(await alive(nativePid, nativeStartTicks)) ? "native:still_alive" : "native:gone",
		);

	if (await alive(mockPid, mockStartTicks))
		cleanupLog.push(await stopVerified(mockPid, mockStartTicks, "mock"));
	if (await alive(launcherPid, launcherStartTicks))
		cleanupLog.push(await stopVerified(launcherPid, launcherStartTicks, "launcher"));
	const leak = cleanupLog.some((entry) => entry.includes("still_alive"));
	if (leak) {
		cleanupLog.push("root_kept_for_live_process");
	} else {
		await rm(root, { recursive: true, force: true });
		cleanupLog.push("root_removed");
	}
	evidence.cleanup = cleanupLog;
	if (leak) {
		evidence.ok = false;
		evidence.error = evidence.error ?? "cleanup_left_live_process";
	}
}

await writeFile(
	join(import.meta.dir, "p2-real-evidence.json"),
	`${JSON.stringify(evidence, null, 1)}\n`,
);
console.log(JSON.stringify(evidence, null, 1));
if (evidence.ok !== true) {
	throw new Error(String(evidence.error ?? "p2_real_probe_failed"));
}
