import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFileSyncNoFollow } from "../../shared/private-file.js";
import type { ControlAction, LaunchRequest } from "../../shared/types.js";
import type { SupervisorConfig } from "../config.js";
import { isUnderAnyRoot, resolveTrustedRoots } from "../services/prelaunch-actions.js";
import type { LaunchCallbacks } from "./claude-shared.js";
import {
	readOwnedOpenCodeChildren,
	readOwnedOpenCodeHistory,
	recoverOpenCodeHistory,
} from "./opencode-recovery.js";
import { executeOrReportFork, reportForkWithTokenFallback } from "./fork-pending.js";
import type { ForkChildMap, ForkSnapshot } from "./fork-snapshot.js";
import { OpenCodeRuntimePool } from "./opencode-runtime.js";

export function createManagedOpenCodeProvider(
	config: SupervisorConfig,
	home: string,
	deps: {
		request: (path: string, options?: RequestInit) => Promise<unknown>;
		verdict: (sessionId: string) => string;
		/** Authenticated server channel for the fork RESULT (never a bare id). */
		reportForkResult?: (
			actionId: string,
			body: {
				claimToken: string;
				childNativeSessionId: string;
				parentSnapshot: ForkSnapshot;
				childMap?: ForkChildMap;
			},
		) => Promise<unknown>;
	},
) {
	const pool = new OpenCodeRuntimePool({
		executable: config.capabilities.executables?.opencode?.resolvedPath ?? "opencode",
		profilePath: config.opencodeProfilePath ?? "",
		stateDirectory: join(home, ".agentpulse", "opencode"),
		maxInstances: config.opencodeMaxInstances ?? 2,
		idleTimeoutMs: config.opencodeIdleTimeoutMs ?? 1800000,
		stopGraceMs: config.opencodeStopGraceMs ?? 5000,
	});
	const active = new Map<
		string,
		{ runtime: NonNullable<ReturnType<typeof pool.get>>; polling: boolean }
	>();
	const closingRuntime = new Map<string, NonNullable<ReturnType<typeof pool.get>>>();
	const interruptEpoch = new Map<string, number>();
	const promptQueues = new Map<string, Promise<void>>();
	const closed = new Map<string, { generation: number; state: "stopped" | "interrupted" }>();
	let recovering: Promise<void> | undefined;
	const recover = () =>
		(recovering ??= recoverOpenCodeHistory(
			join(home, ".agentpulse", "opencode"),
			(id, path, body, context) =>
				path === "snapshot" && deps.verdict(context.sessionId) !== "send"
					? Promise.resolve()
					: post(`/opencode/${id}/${path}`, body),
		).finally(() => {
			recovering = undefined;
		}));
	const prefix = `/supervisors/${config.id}`;
	const post = (path: string, body: unknown) =>
		deps.request(prefix + path, { method: "POST", body: JSON.stringify(body) });
	async function flushClosed() {
		for (const [id, body] of closed) {
			const runtime = closingRuntime.get(id);
			if (runtime && deps.verdict(runtime.sessionId) === "send") {
				const messages = readOwnedOpenCodeHistory(runtime.directory, runtime.nativeSessionId);
				await post(`/opencode/${id}/snapshot`, {
					generation: body.generation,
					nativeSessionId: runtime.nativeSessionId,
					messages,
					children: readOwnedOpenCodeChildren(
						runtime.directory,
						runtime.nativeSessionId,
						runtime.cwd,
					),
					permissions: [],
					questions: [],
					status: { type: "interrupted" },
				});
			}
			await post(`/opencode/${id}/closed`, body);
			if (runtime)
				writePrivateFileSyncNoFollow(
					join(runtime.directory, "reconciled.json"),
					JSON.stringify({ at: new Date().toISOString(), state: body.state }),
				);
			closingRuntime.delete(id);
			closed.delete(id);
		}
	}
	async function poll() {
		for (const [id, entry] of active) {
			if (entry.polling) continue;
			entry.polling = true;
			try {
				if (deps.verdict(id) !== "send") {
					await stop(id);
					continue;
				}
				const snapshot = await entry.runtime.snapshot();
				if (deps.verdict(id) !== "send") continue;
				await post(`/opencode/${entry.runtime.instanceId}/snapshot`, {
					...snapshot,
					generation: entry.runtime.generation,
					nativeSessionId: entry.runtime.nativeSessionId,
				});
			} catch (error) {
				if (error instanceof Error && error.message === "opencode_process_interrupted") {
					writePrivateFileSyncNoFollow(
						join(entry.runtime.directory, "closed.json"),
						JSON.stringify({ generation: entry.runtime.generation, state: "interrupted" }),
					);
					closingRuntime.set(entry.runtime.instanceId, entry.runtime);
					closed.set(entry.runtime.instanceId, {
						generation: entry.runtime.generation,
						state: "interrupted",
					});
					active.delete(id);
					await entry.runtime.stop();
				}
			} finally {
				entry.polling = false;
			}
		}
		await flushClosed();
	}
	async function stop(sessionId: string) {
		const entry = active.get(sessionId);
		if (!entry) throw new Error("opencode_process_not_owned");
		try {
			await entry.runtime.abort();
		} catch {}
		// Preserve local native history; stopped is a runtime state, never business completion.
		await entry.runtime.stop();
		active.delete(sessionId);
		writePrivateFileSyncNoFollow(
			join(entry.runtime.directory, "closed.json"),
			JSON.stringify({ generation: entry.runtime.generation, state: "stopped" }),
		);
		closingRuntime.set(entry.runtime.instanceId, entry.runtime);
		closed.set(entry.runtime.instanceId, {
			generation: entry.runtime.generation,
			state: "stopped",
		});
		await flushClosed();
	}
	const ready = (async () => {
		while (true) {
			try {
				await recover();
				return;
			} catch {
				console.warn("[opencode] recovery pending; new launches wait for reconciliation");
				await Bun.sleep(3000);
			}
		}
	})();
	const timer = setInterval(() => void poll().catch(() => {}), 1500);
	timer.unref();
	const idle = setInterval(
		() =>
			void (async () => {
				for (const id of await pool.reapIdle()) {
					const entry = active.get(id);
					if (!entry) continue;
					active.delete(id);
					writePrivateFileSyncNoFollow(
						join(entry.runtime.directory, "closed.json"),
						JSON.stringify({ generation: entry.runtime.generation, state: "stopped" }),
					);
					closingRuntime.set(entry.runtime.instanceId, entry.runtime);
					closed.set(entry.runtime.instanceId, {
						generation: entry.runtime.generation,
						state: "stopped",
					});
				}
				await flushClosed();
			})().catch(() => {}),
		30000,
	);
	idle.unref();
	return {
		async launch(launch: LaunchRequest, callbacks: LaunchCallbacks) {
			await ready;
			const canonical = await realpath(launch.cwd);
			if (
				canonical !== launch.cwd ||
				!isUnderAnyRoot(canonical, await resolveTrustedRoots(config.trustedRoots))
			)
				throw new Error("OpenCode cwd must be canonical and within trusted roots");
			const binding = launch.openCodeInstance;
			if (
				!binding ||
				launch.agentType !== "opencode" ||
				launch.requestedLaunchMode !== "managed_opencode"
			)
				throw new Error("opencode_missing_reservation");
			const runtime = await pool.start({
				instanceId: binding.id,
				generation: binding.generation,
				sessionId: launch.launchCorrelationId,
				cwd: launch.cwd,
				title: launch.desiredDisplayName ?? "OpenCode session",
			});
			try {
				await callbacks.reportState({
					sessionId: launch.launchCorrelationId,
					agentType: "opencode",
					launchRequestId: launch.id,
					cwd: runtime.cwd,
					providerInstanceId: binding.id,
					providerGeneration: binding.generation,
					providerSessionId: runtime.nativeSessionId,
					managedState: "managed",
					status: "idle",
					providerSyncState: "synced",
					providerProtocolVersion: "1.18.35",
					providerCapabilitySnapshot: {
						send: true,
						interrupt: true,
						stop: true,
						permission: ["once", "reject"],
						question: true,
					},
					desiredThreadTitle: launch.desiredDisplayName ?? "OpenCode session",
				});
				active.set(launch.launchCorrelationId, { runtime, polling: false });
				runtime.subscribe(() => void poll().catch(() => {}));
				const prompt = [launch.baseInstructions, launch.taskPrompt].filter(Boolean).join("\n\n");
				if (prompt) await runtime.prompt(prompt);
				return {
					pid: runtime.pid,
					metadata: {
						mode: "managed_opencode",
						instanceId: binding.id,
						generation: binding.generation,
						protocolVersion: "1.18.35",
					},
				};
			} catch (error) {
				await runtime.stop();
				active.delete(launch.launchCorrelationId);
				closed.set(runtime.instanceId, { generation: runtime.generation, state: "interrupted" });
				try {
					await flushClosed();
				} catch {}
				throw error;
			}
		},
		owns(sessionId: string) {
			return active.has(sessionId);
		},
		async control(action: ControlAction) {
			const metadata = action.metadata ?? {};
			// A6 addressing: resolve the runtime by INSTANCE (one runtime per
			// provider instance), not by the action's AgentPulse session id —
			// a fork child's action carries the CHILD session id while the
			// runtime stays keyed by the parent. The action must still name
			// the matching instance/generation, and the resolved runtime must
			// be the one holding that native session.
			let entry: (typeof active extends Map<string, infer V> ? V : never) | undefined;
			for (const candidate of active.values()) {
				if (
					metadata.instanceId === candidate.runtime.instanceId &&
					metadata.generation === candidate.runtime.generation
				) {
					entry = candidate;
					break;
				}
			}
			if (!entry) throw new Error("opencode_control_binding_mismatch");
			const runtime = entry.runtime;
			// A6 addressing: pass the action's native session through. The runtime
			// refuses anything outside the bound session + its LIVE subtree
			// (opencode_unknown_native_session) — never a silent misroute.
			const targetNative =
				typeof metadata.nativeSessionId === "string" ? metadata.nativeSessionId : undefined;
			// SESSION STOP IS NOT IMPLEMENTED. A child stop requires cancel-queued,
			// approval invalidation, a stop epoch and refusal of new actions — an
			// abort alone would be a half-truth, so it is REFUSED. Stopping the
			// bound session kills the shared instance and therefore affects EVERY
			// branch; that blast radius is the caller's explicit decision.
			if (action.actionType === "stop") {
				if (targetNative && targetNative !== runtime.nativeSessionId)
					throw new Error("opencode_child_stop_not_implemented");
				return stop(runtime.sessionId);
			}
			// Epochs are per TARGET native session: interrupting a child must not
			// cancel the parent's in-flight wait/retry.
			const epochKey = targetNative ?? runtime.nativeSessionId;
			if (action.actionType === "interrupt") {
				interruptEpoch.set(epochKey, (interruptEpoch.get(epochKey) ?? 0) + 1);
				return runtime.abort(targetNative);
			}
			if (action.actionType === "prompt") {
				const epoch = interruptEpoch.get(epochKey) ?? 0;
				const previous = promptQueues.get(epochKey) ?? Promise.resolve();
				const next = previous
					.catch(() => {})
					.then(async () => {
						const deadline = Date.now() + 15 * 60 * 1000;
						while (true) {
							if (!active.has(runtime.sessionId)) throw new Error("opencode_process_interrupted");
							if (epoch !== (interruptEpoch.get(epochKey) ?? 0))
								throw new Error("opencode_prompt_cancelled_before_delivery");
							const status = await runtime.snapshot();
							// Gate on THIS target only: a busy sibling session or its
							// pending card must not block the parent (and vice versa).
							const targetStatus = status.sessions[epochKey]?.type ?? "idle";
							const blocked =
								status.permissions.some((item) => (item as { sessionID?: string }).sessionID === epochKey) ||
								status.questions.some((item) => (item as { sessionID?: string }).sessionID === epochKey);
							if (targetStatus === "idle" && !blocked) break;
							if (Date.now() > deadline) throw new Error("opencode_prompt_wait_timeout");
							await Bun.sleep(250);
						}
						const model =
							metadata.model && typeof metadata.model === "object"
								? {
										providerID: String(
											(metadata.model as Record<string, unknown>).providerID ?? "",
										),
										modelID: String((metadata.model as Record<string, unknown>).modelID ?? ""),
									}
								: undefined;
						await runtime.prompt(String(metadata.prompt ?? ""), {
							...(targetNative ? { nativeSessionId: targetNative } : {}),
							...(model ? { model } : {}),
							...(typeof metadata.agent === "string" && metadata.agent
								? { agent: metadata.agent }
								: {}),
						});
						await Bun.sleep(500);
					});
				promptQueues.set(epochKey, next);
				try {
					await next;
				} finally {
					if (promptQueues.get(epochKey) === next) promptQueues.delete(epochKey);
				}
				return;
			}
			if (action.actionType === "opencode_resume") {
				// The server has already transitioned stopped -> active (new epoch)
				// at acceptance; no native work is required.
				runtime.touch();
				return;
			}
			if (action.actionType === "opencode_fork") {
				// PRECONDITIONS FIRST: no native fork when the result channel is
				// missing or the source is outside this slice (bound ROOT session,
				// full-history fork only).
				const claimToken = metadata.claimToken;
				if (typeof claimToken !== "string" || !claimToken)
					throw new Error("opencode_fork_missing_claim");
				if (targetNative && targetNative !== runtime.nativeSessionId)
					throw new Error("opencode_fork_child_source_unsupported");
				if (!deps.reportForkResult) throw new Error("opencode_fork_report_unavailable");
				const report = deps.reportForkResult;
				const outcome = await runtime.withExclusiveFork(() =>
					executeOrReportFork({
						directory: runtime.directory,
						identity: {
							actionId: action.id,
							instanceId: runtime.instanceId,
							generation: runtime.generation,
						},
						nativeSessionId: runtime.nativeSessionId,
						claimToken,
						forkPointMessageId:
							typeof metadata.forkPointMessageId === "string" ? metadata.forkPointMessageId : null,
						capture: () =>
							runtime.captureForkSnapshot(
								typeof metadata.forkPointMessageId === "string"
									? metadata.forkPointMessageId
									: null,
							),
						// copyOf: the native fork accepts the message id; the child
						// history is truncated there (verified by the runtime test).
						fork: async (forkPointMessageId, parentSnapshot) => {
							const created = await runtime.forkSession(
								undefined,
								forkPointMessageId ? { messageID: forkPointMessageId } : {},
							);
							const childMap = await runtime.captureChildMap(created.id, parentSnapshot);
							return { id: created.id, childMap };
						},
						report: (record) =>
							reportForkWithTokenFallback({
								record,
								currentClaimToken: claimToken,
								deliver: (token) =>
									report(action.id, {
										claimToken: token,
										childNativeSessionId: String(record.childNativeSessionId ?? ""),
										parentSnapshot: record.parentSnapshot as ForkSnapshot,
										...(record.childMap ? { childMap: record.childMap as ForkChildMap } : {}),
									}),
							}),
						// The child becomes addressable ONLY after the server confirmed
						// the managed binding (2xx = committed transaction).
						register: (childNativeSessionId) => runtime.registerManagedChild(childNativeSessionId),
					}),
				);
				void outcome;
				runtime.touch();
				return;
			}
			if (action.actionType === "opencode_command") {
				const command = String(metadata.command ?? "");
				if (!/^[a-zA-Z0-9_-]+$/.test(command)) throw new Error("opencode_invalid_command");
				const epoch = interruptEpoch.get(epochKey) ?? 0;
				const previous = promptQueues.get(epochKey) ?? Promise.resolve();
				const next = previous
					.catch(() => {})
					.then(async () => {
						const deadline = Date.now() + 15 * 60 * 1000;
						while (true) {
							if (!active.has(runtime.sessionId)) throw new Error("opencode_process_interrupted");
							if (epoch !== (interruptEpoch.get(epochKey) ?? 0))
								throw new Error("opencode_prompt_cancelled_before_delivery");
							const status = await runtime.snapshot();
							const targetStatus = status.sessions[epochKey]?.type ?? "idle";
							const blocked =
								status.permissions.some(
									(item) => (item as { sessionID?: string }).sessionID === epochKey,
								) ||
								status.questions.some(
									(item) => (item as { sessionID?: string }).sessionID === epochKey,
								);
							if (targetStatus === "idle" && !blocked) break;
							if (Date.now() > deadline) throw new Error("opencode_prompt_wait_timeout");
							await Bun.sleep(250);
						}
						const commandModel =
							metadata.model && typeof metadata.model === "object"
								? {
										providerID: String(
											(metadata.model as Record<string, unknown>).providerID ?? "",
										),
										modelID: String((metadata.model as Record<string, unknown>).modelID ?? ""),
									}
								: undefined;
						await runtime.runCommand(
							command,
							metadata.arguments ? String(metadata.arguments) : "",
							{
								...(targetNative ? { nativeSessionId: targetNative } : {}),
								...(commandModel ? { model: commandModel } : {}),
								...(typeof metadata.agent === "string" && metadata.agent
									? { agent: metadata.agent }
									: {}),
							},
						);
						await Bun.sleep(500);
					});
				promptQueues.set(epochKey, next);
				try {
					await next;
				} finally {
					if (promptQueues.get(epochKey) === next) promptQueues.delete(epochKey);
				}
				return;
			}
			if (action.actionType === "interaction_response") {
				const snapshot = await runtime.snapshot();
				const kind = metadata.kind;
				const list =
					kind === "permission"
						? snapshot.permissions
						: kind === "question"
							? snapshot.questions
							: [];
				const pending = list.find(
					(value) => (value as { id: string }).id === metadata.nativeRequestId,
				);
				if (!pending) throw new Error("interaction_no_longer_pending");
				if (
					createHash("sha256").update(JSON.stringify(pending)).digest("hex") !== metadata.revision
				)
					throw new Error("interaction_revision_changed");
				const id = encodeURIComponent(String(metadata.nativeRequestId));
				if (kind === "permission") {
					if (!["once", "reject"].includes(String(metadata.decision)))
						throw new Error("permission_decision_not_allowed");
					await runtime.request(`/permission/${id}/reply`, { reply: metadata.decision });
				} else if (kind === "question") {
					if (metadata.decision === "reject") await runtime.request(`/question/${id}/reject`, {});
					else await runtime.request(`/question/${id}/reply`, { answers: metadata.answers });
				} else throw new Error("invalid_interaction");
				runtime.touch();
				return;
			}
			throw new Error("opencode_unsupported_action");
		},
		poll,
		async close() {
			clearInterval(timer);
			clearInterval(idle);
			for (const id of active.keys()) await stop(id);
			await pool.close();
		},
	};
}
