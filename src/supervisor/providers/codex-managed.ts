import { realpath } from "node:fs/promises";
import type {
	LaunchRequest,
	ManagedSession,
	ManagedSessionStateInput,
} from "../../shared/types.js";
import {
	forgetCodexRecovery,
	readCodexRecovery,
	saveCodexRecovery,
} from "../services/codex-recovery.js";
import { isUnderAnyRoot, resolveTrustedRoots } from "../services/prelaunch-actions.js";
import type { ReportGate } from "../services/report-gate.js";
import { reportInSessionSafely } from "../services/report-resilience.js";
import { type JsonRpcNotification, findFreePort, spawnServer, waitForServer } from "./codex-rpc.js";
import {
	type LaunchCallbacks,
	type ManagedCodexRuntime,
	buildPrompt,
	extractText,
} from "./codex-shared.js";

const dirtyStates = new Map<string, ManagedSessionStateInput>();
async function reportCodexState(callbacks: LaunchCallbacks, body: ManagedSessionStateInput) {
	dirtyStates.set(body.sessionId, body);
	const result = await callbacks.reportState(body);
	if (dirtyStates.get(body.sessionId) === body) dirtyStates.delete(body.sessionId);
	return result;
}

const pendingApprovals = new Map<
	string,
	{
		sessionId: string;
		requestId: number | string;
		client: import("./codex-rpc.js").RpcClient;
		expiresAt: number;
	}
>();

export function respondManagedApproval(sessionId: string, approvalId: string, decision: string) {
	const pending = pendingApprovals.get(approvalId);
	if (!pending || pending.sessionId !== sessionId || pending.expiresAt < Date.now()) {
		pendingApprovals.delete(approvalId);
		throw new Error("Approval expired; refresh this session.");
	}
	if (!["accept", "decline", "cancel"].includes(decision))
		throw new Error("Invalid approval decision");
	pending.client.respond(pending.requestId, { decision });
	pendingApprovals.delete(approvalId);
}

const runtimes = new Map<string, ManagedCodexRuntime>();

/**
 * F31/D7: best-effort cleanup before a fatal (401 credential-rejected) exit
 * — dispose every managed Codex runtime this process still holds (closes
 * the app-server control channel, kills its process) before the process
 * itself exits.
 */
function disposeAllManagedCodexRuntimes(): void {
	for (const runtime of runtimes.values()) {
		try {
			runtime.dispose();
		} catch (err) {
			console.error("[codex-managed] runtime dispose failed during fatal shutdown:", err);
		}
	}
}

// Log-once per distinct unexpected protocolVersion value so a persistently
// misbehaving app-server doesn't spam logs across every managed launch.
// Module-level and independent of other log-once sets in the codebase (see
// pricing.ts's warnedFallbackModels / event-normalizer.ts's unknown-event set).
const warnedProtocolVersions = new Set<string>();

/** Test hook: forget which values were already warned about. */
export function _resetWarnedProtocolVersionsForTest(): void {
	warnedProtocolVersions.clear();
}

/**
 * Coerce the app-server's `initialize` response into a stored protocol
 * version string. `initResult.protocolVersion` is untyped wire data — when
 * it's missing or not a string, warns once per distinct bad value and falls
 * back to "app-server" (existing behavior). Never throws; the managed
 * launch must proceed regardless of what the app-server reports.
 */
export function resolveProviderProtocolVersion(
	initResult: Record<string, unknown> | null | undefined,
): string {
	const raw = initResult?.protocolVersion;
	if (typeof raw === "string") return raw;

	const key = raw === undefined ? "undefined" : JSON.stringify(raw);
	if (!warnedProtocolVersions.has(key)) {
		warnedProtocolVersions.add(key);
		console.warn(
			`[codex-managed] initialize returned unexpected providerProtocolVersion (${key}); falling back to "app-server".`,
		);
	}
	return "app-server";
}

type ResumeOptions = { resumeThreadId?: string; noPrompt?: boolean };
const launching = new Map<
	string,
	Promise<Awaited<ReturnType<typeof doLaunchManagedCodexRequest>>>
>();
export async function launchManagedCodexRequest(
	launch: LaunchRequest,
	callbacks: LaunchCallbacks,
	options: ResumeOptions = {},
) {
	const pending = launching.get(launch.launchCorrelationId);
	if (pending) return pending;
	const task = doLaunchManagedCodexRequest(launch, callbacks, options);
	launching.set(launch.launchCorrelationId, task);
	try {
		return await task;
	} finally {
		launching.delete(launch.launchCorrelationId);
	}
}
export function codexApprovalPolicy(policy: LaunchRequest["approvalPolicy"]) {
	switch (policy) {
		case "auto":
			return "never";
		case "manual":
		case "suggest":
			return "on-request";
		case "untrusted":
		case "on-failure":
			return policy;
		default:
			return undefined;
	}
}
async function doLaunchManagedCodexRequest(
	launch: LaunchRequest,
	callbacks: LaunchCallbacks,
	options: ResumeOptions,
) {
	if (process.env.AGENTPULSE_SUPERVISOR_DRY_RUN === "true") {
		const threadId = crypto.randomUUID();
		const desiredState = await reportCodexState(callbacks, {
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			agentType: "codex_cli",
			cwd: launch.cwd,
			model: launch.model ?? null,
			managedState: "managed",
			providerThreadId: threadId,
			correlationSource: "session_id",
			providerSyncState: "synced",
			providerThreadTitle: `dry-run-${launch.launchCorrelationId.slice(0, 8)}`,
			lastProviderSyncAt: new Date().toISOString(),
			providerProtocolVersion: "dry-run",
		});
		await callbacks.reportEvents([
			{
				eventType: "ManagedSessionStart",
				category: "system_event",
				content: "Managed Codex dry-run session started.",
				rawPayload: { threadId },
			},
		]);
		return {
			pid: 0,
			metadata: { mode: "dry-run", threadId },
			runtime: {
				sessionId: launch.launchCorrelationId,
				threadId,
				url: "dry-run",
				client: null,
				serverProcess: null,
				currentThreadTitle: desiredState.session.displayName,
				protocolVersion: "dry-run",
				activeTurnId: null,
				intentionalClose: false,
				syncTitle: async () => {},
				dispose: () => {},
			} satisfies ManagedCodexRuntime,
		};
	}

	if (runtimes.has(launch.launchCorrelationId))
		return {
			pid: runtimes.get(launch.launchCorrelationId)?.serverProcess?.pid ?? 0,
			metadata: {},
			runtime: runtimes.get(launch.launchCorrelationId)!,
		};
	const port = await findFreePort();
	const url = `ws://127.0.0.1:${port}`;
	const serverProcess = await spawnServer(url);
	const client = await waitForServer(url).catch((error) => {
		serverProcess.kill();
		throw error;
	});
	try {
		const initResult = await client.request<Record<string, unknown>>("initialize", {
			clientInfo: {
				name: "agentpulse-supervisor",
				title: "AgentPulse Supervisor",
				version: "0.1.0",
			},
			capabilities: {
				experimentalApi: true,
			},
		});

		client.notify("initialized");
		if (options.resumeThreadId) {
			const saved = await client.request<{ thread: { cwd: string } }>("thread/read", {
				threadId: options.resumeThreadId,
				includeTurns: false,
			});
			if ((await realpath(saved.thread.cwd)) !== (await realpath(launch.cwd)))
				throw new Error("Native thread belongs to a different working directory");
		}
		const started = await client.request<{
			thread: { id: string; cwd: string; status: unknown; source: string };
		}>(options.resumeThreadId ? "thread/resume" : "thread/start", {
			...(options.resumeThreadId ? { threadId: options.resumeThreadId } : {}),
			approvalPolicy: codexApprovalPolicy(launch.approvalPolicy),
			sandbox: launch.sandboxMode === "default" ? undefined : (launch.sandboxMode ?? undefined),
			cwd: launch.cwd,
			experimentalRawEvents: false,
			persistExtendedHistory: true,
			sessionStartSource: "startup",
		});
		const threadId = started.thread.id;

		const bootstrap = await reportCodexState(callbacks, {
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			agentType: "codex_cli",
			cwd: launch.cwd,
			model: launch.model ?? null,
			status: options.noPrompt ? "idle" : "active",
			managedState: "managed",
			providerSessionId: threadId,
			providerThreadId: threadId,
			correlationSource: "session_id",
			providerProtocolVersion: resolveProviderProtocolVersion(initResult),
			providerCapabilitySnapshot: initResult,
			providerSyncState: "pending",
			metadata: {
				managedCodexUrl: url,
			},
		});

		async function syncTitle(title: string) {
			await reportCodexState(callbacks, {
				sessionId: launch.launchCorrelationId,
				launchRequestId: launch.id,
				providerSessionId: threadId,
				providerThreadId: threadId,
				managedState: "managed",
				desiredThreadTitle: title,
				providerSyncState: "pending",
				providerSyncError: null,
			});

			await client.request("thread/name/set", { threadId, name: title });
			await client.waitForNotification(
				"thread/name/updated",
				(notification) => {
					const params = notification.params as { threadId?: string; threadName?: string };
					return params.threadId === threadId && params.threadName === title;
				},
				5_000,
			);

			await reportCodexState(callbacks, {
				sessionId: launch.launchCorrelationId,
				launchRequestId: launch.id,
				providerSessionId: threadId,
				providerThreadId: threadId,
				managedState: "managed",
				desiredThreadTitle: title,
				providerThreadTitle: title,
				providerSyncState: "synced",
				providerSyncError: null,
				lastProviderSyncAt: new Date().toISOString(),
			});
		}

		await syncTitle(bootstrap.session.displayName || launch.launchCorrelationId.slice(0, 8)).catch(
			(error) => console.warn("[codex-managed] title sync deferred:", error.message),
		);

		const runtime: ManagedCodexRuntime = {
			sessionId: launch.launchCorrelationId,
			threadId,
			url,
			client,
			serverProcess,
			currentThreadTitle: bootstrap.session.displayName || launch.launchCorrelationId.slice(0, 8),
			protocolVersion: resolveProviderProtocolVersion(initResult),
			activeTurnId: null,
			intentionalClose: false,
			syncTitle: async (title: string) => {
				await syncTitle(title);
				runtime.currentThreadTitle = title;
			},
			dispose: () => {
				runtime.intentionalClose = true;
				try {
					client.close();
				} catch {}
				try {
					serverProcess.kill();
				} catch {}
				if (runtimes.get(launch.launchCorrelationId)?.client === client)
					runtimes.delete(launch.launchCorrelationId);
			},
		};

		client.onRequest(async (rpcRequest) => {
			if (
				!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
					rpcRequest.method,
				)
			) {
				throw new Error("This native approval kind is unsupported; use the local interface.");
			}
			const params = (rpcRequest.params ?? {}) as Record<string, unknown>;
			if (params.threadId !== threadId) throw new Error("Request belongs to a different thread");
			const approvalId = crypto.randomUUID();
			const expiresAt = Date.now() + 10 * 60_000;
			pendingApprovals.set(approvalId, {
				sessionId: launch.launchCorrelationId,
				requestId: rpcRequest.id,
				client,
				expiresAt,
			});
			setTimeout(() => {
				if (!pendingApprovals.has(approvalId)) return;
				try {
					client.respond(rpcRequest.id, { decision: "cancel" });
				} catch {}
				pendingApprovals.delete(approvalId);
			}, 10 * 60_000).unref();
			try {
				await callbacks.reportEvents([
					{
						eventType: "NativeApprovalRequested",
						category: "system_event",
						content: String(params.reason ?? params.command ?? "Agent requests permission"),
						rawPayload: {
							approvalId,
							method: rpcRequest.method,
							params,
							expiresAt: new Date(expiresAt).toISOString(),
						},
					},
				]);
			} catch (error) {
				pendingApprovals.delete(approvalId);
				throw error;
			}
		});

		client.onNotification(async (notification) => {
			// F25/D6: in-session reporting (reportState/reportEvents) can now
			// reject with a 403 session_not_owned, a 401 (credential revoked or
			// rotated, F31/D7), or any other non-2xx, mid-session. Logged and
			// isolated so a rejection here can never become an unhandled
			// rejection or skip later notification branches — except a 401,
			// which is fatal (see reportInSessionSafely).
			await reportInSessionSafely(
				"codex-managed",
				launch.launchCorrelationId,
				"notification",
				() => handleManagedCodexNotification(notification, launch, runtime, threadId, callbacks),
				() => {
					disposeAllManagedCodexRuntimes();
					process.exit(1);
				},
			);
		});

		client.onClose(async (error) => {
			serverProcess.kill();
			for (const [id, pending] of pendingApprovals)
				if (pending.client === client) pendingApprovals.delete(id);
			if (runtime.intentionalClose) {
				if (runtimes.get(launch.launchCorrelationId)?.client === client)
					runtimes.delete(launch.launchCorrelationId);
				return;
			}
			// F25/D6: same in-session-reporting hazard as the notification
			// handler above — the control channel is already gone, so there's
			// nothing more useful to do than log (or, for a 401, exit) and
			// finish tearing the runtime down.
			await reportInSessionSafely(
				"codex-managed",
				launch.launchCorrelationId,
				"degraded-state",
				() =>
					reportCodexState(callbacks, {
						sessionId: launch.launchCorrelationId,
						launchRequestId: launch.id,
						managedState: "degraded",
						providerSyncState: "failed",
						providerSyncError: error?.message ?? "Codex control channel closed",
					}),
				() => {
					disposeAllManagedCodexRuntimes();
					process.exit(1);
				},
			);
			if (runtimes.get(launch.launchCorrelationId)?.client === client)
				runtimes.delete(launch.launchCorrelationId);
		});

		runtimes.set(launch.launchCorrelationId, runtime);
		saveCodexRecovery(launch, threadId);

		await callbacks.reportEvents([
			{
				eventType: "ManagedSessionStart",
				category: "system_event",
				content: "Managed Codex session started.",
				rawPayload: { url, threadId },
			},
		]);

		if (options.noPrompt)
			return {
				pid: serverProcess.pid ?? 0,
				metadata: { threadId, mode: "managed_codex" },
				runtime,
			};
		const prompt = buildPrompt(launch);
		await callbacks.reportEvents([
			{ eventType: "ManagedUserPrompt", category: "prompt", content: prompt },
		]);
		const turn = await client.request<{ turn: { id: string } }>("turn/start", {
			threadId,
			input: [{ type: "text", text: prompt }],
			cwd: launch.cwd,
			model: launch.model ?? undefined,
		});
		runtime.activeTurnId = turn.turn.id;

		return {
			pid: serverProcess.pid ?? 0,
			metadata: {
				mode: "managed_codex",
				threadId,
				url,
			},
			runtime,
		};
	} catch (error) {
		client.close();
		serverProcess.kill();
		if (runtimes.get(launch.launchCorrelationId)?.client === client)
			runtimes.delete(launch.launchCorrelationId);
		throw error;
	}
}

export async function promptManagedCodexSession(
	sessionId: string,
	prompt: string,
	callbacks: LaunchCallbacks,
) {
	const runtime = runtimes.get(sessionId);
	if (!runtime?.client) throw new Error("Session disconnected. Resume it before sending.");
	if (runtime.activeTurnId) throw new Error("Agent is still working; wait for the current turn.");
	runtime.activeTurnId = "starting";
	try {
		await callbacks.reportEvents([
			{ eventType: "ManagedUserPrompt", category: "prompt", content: prompt },
		]);
		const result = await runtime.client.request<{ turn: { id: string } }>("turn/start", {
			threadId: runtime.threadId,
			input: [{ type: "text", text: prompt }],
		});
		runtime.activeTurnId = result.turn.id;
		await reportCodexState(callbacks, {
			sessionId,
			status: "active",
			managedState: "managed",
		}).catch(() => console.error("[codex-managed] state sync deferred"));
	} catch (error) {
		// A timed-out start may already be executing. Keep the turn busy until its terminal notification.
		if (!(error instanceof Error && error.message.includes("outcome may be unknown")))
			runtime.activeTurnId = null;
		throw error;
	}
}

/**
 * F25: extracted from the inline `client.onNotification` callback so the
 * caller can wrap the whole dispatch in one try/catch. Each branch may call
 * `callbacks.reportState`/`reportEvents`, which now carry an ownership guard
 * (session_not_owned) and can reject mid-session.
 */
async function handleManagedCodexNotification(
	notification: JsonRpcNotification,
	launch: LaunchRequest,
	runtime: ManagedCodexRuntime,
	threadId: string,
	callbacks: LaunchCallbacks,
) {
	if (notification.method === "thread/name/updated") {
		const params = notification.params as { threadId?: string; threadName?: string };
		if (params.threadId === threadId && params.threadName) {
			runtime.currentThreadTitle = params.threadName;
			await reportCodexState(callbacks, {
				sessionId: launch.launchCorrelationId,
				launchRequestId: launch.id,
				providerSessionId: threadId,
				providerThreadId: threadId,
				managedState: "managed",
				desiredThreadTitle: params.threadName,
				providerThreadTitle: params.threadName,
				providerSyncState: "synced",
				lastProviderSyncAt: new Date().toISOString(),
			});
		}
		return;
	}

	if (notification.method === "item/completed") {
		const params = notification.params as Record<string, unknown>;
		const item = (params.item ?? null) as Record<string, unknown> | null;
		const itemType = typeof item?.type === "string" ? item.type : "";
		const text = extractText(item);
		if ((itemType === "agentMessage" || itemType === "exitedReviewMode") && text.trim()) {
			await callbacks.reportEvents([
				{
					eventType: "ManagedAgentMessage",
					category: "assistant_message",
					content: text.trim(),
					rawPayload: { notification },
				},
			]);
		}
		return;
	}

	if (notification.method === "warning") {
		const params = notification.params as { message?: string };
		if (params.message) {
			await callbacks.reportEvents([
				{
					eventType: "ManagedWarning",
					category: "system_event",
					content: params.message,
					rawPayload: { notification },
				},
			]);
		}
		return;
	}

	if (notification.method === "turn/started") {
		const params = notification.params as { turn?: { id?: string } };
		runtime.activeTurnId = params.turn?.id ?? runtime.activeTurnId;
	}
	if (notification.method === "turn/completed") {
		runtime.activeTurnId = null;
		await reportCodexState(callbacks, {
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			managedState: "managed",
			status: "idle",
		});
	}
}

export async function stopManagedCodexSession(sessionId: string) {
	const runtime = runtimes.get(sessionId);
	if (!runtime) {
		if (readCodexRecovery()[sessionId]) {
			forgetCodexRecovery(sessionId);
			return;
		}
		throw new Error("Managed Codex runtime is not available on this supervisor.");
	}

	if (runtime.client && runtime.activeTurnId) {
		try {
			await runtime.client.request("turn/interrupt", {
				threadId: runtime.threadId,
				turnId: runtime.activeTurnId,
			});
		} catch {
			// Fall through to cleanup even if interrupt fails.
		}
	}

	forgetCodexRecovery(sessionId);
	runtime.dispose();
}

export async function reconcileManagedCodexTitles(
	managedSessions: ManagedSession[],
	reportState: LaunchCallbacks["reportState"],
) {
	for (const row of managedSessions) {
		const dirty = dirtyStates.get(row.sessionId);
		if (!dirty) continue;
		try {
			await reportState(dirty);
			if (dirtyStates.get(row.sessionId) === dirty) dirtyStates.delete(row.sessionId);
		} catch {
			/* retry after connectivity recovers */
		}
	}

	for (const managedSession of managedSessions) {
		const runtime = runtimes.get(managedSession.sessionId);
		if (!runtime || !managedSession.desiredThreadTitle) continue;
		if (runtime.currentThreadTitle === managedSession.desiredThreadTitle) continue;
		try {
			await runtime.syncTitle(managedSession.desiredThreadTitle);
		} catch (error) {
			await reportState({
				sessionId: managedSession.sessionId,
				launchRequestId: managedSession.launchRequestId,
				providerSessionId: runtime.threadId,
				providerThreadId: runtime.threadId,
				managedState: "degraded",
				desiredThreadTitle: managedSession.desiredThreadTitle,
				providerThreadTitle: runtime.currentThreadTitle,
				providerSyncState: "failed",
				providerSyncError: error instanceof Error ? error.message : "Rename sync failed",
			});
		}
	}
}

const recovering = new Set<string>();
/** Restore local bindings only; never replay a prompt whose execution outcome is unknown. */
export async function recoverManagedCodexSessions(
	rows: ManagedSession[],
	gate: ReportGate,
	trustedRoots: string[],
) {
	const saved = readCodexRecovery();
	for (const row of rows) {
		if (
			runtimes.has(row.sessionId) ||
			recovering.has(row.sessionId) ||
			["stopped", "completed", "failed"].includes(row.managedState)
		)
			continue;
		const entry = saved[row.sessionId];
		if (!entry || entry.threadId !== row.providerThreadId) continue;
		recovering.add(row.sessionId);
		try {
			const cwd = await realpath(entry.launch.cwd);
			if (!isUnderAnyRoot(cwd, await resolveTrustedRoots(trustedRoots))) continue;
			if (!gate.noteCwd(row.sessionId, cwd) || gate.verdict(row.sessionId, cwd) !== "send")
				continue;
			await launchManagedCodexRequest(
				entry.launch,
				{
					reportState: (body) => gate.reportState(body),
					reportEvents: (events) => gate.reportEvents(row.sessionId, events),
				},
				{ resumeThreadId: entry.threadId, noPrompt: true },
			);
		} catch (error) {
			console.error(
				"[codex-managed] recovery deferred:",
				error instanceof Error ? error.message : error,
			);
		} finally {
			recovering.delete(row.sessionId);
		}
	}
}
