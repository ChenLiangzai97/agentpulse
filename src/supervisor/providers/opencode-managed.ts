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
import { OpenCodeRuntimePool } from "./opencode-runtime.js";

export function createManagedOpenCodeProvider(
	config: SupervisorConfig,
	home: string,
	deps: {
		request: (path: string, options?: RequestInit) => Promise<unknown>;
		verdict: (sessionId: string) => string;
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
			const entry = active.get(action.sessionId ?? "");
			const metadata = action.metadata ?? {};
			if (
				!entry ||
				metadata.instanceId !== entry.runtime.instanceId ||
				metadata.generation !== entry.runtime.generation
			)
				throw new Error("opencode_control_binding_mismatch");
			const runtime = entry.runtime;
			if (action.actionType === "stop") return stop(runtime.sessionId);
			if (action.actionType === "interrupt") return runtime.abort();
			if (action.actionType === "prompt") {
				const previous = promptQueues.get(runtime.sessionId) ?? Promise.resolve();
				const next = previous
					.catch(() => {})
					.then(async () => {
						const deadline = Date.now() + 15 * 60 * 1000;
						while (true) {
							if (!active.has(runtime.sessionId)) throw new Error("opencode_process_interrupted");
							const status = await runtime.snapshot();
							if (
								(status.status as { type: string }).type === "idle" &&
								!status.permissions.length &&
								!status.questions.length
							)
								break;
							if (Date.now() > deadline) throw new Error("opencode_prompt_wait_timeout");
							await Bun.sleep(250);
						}
						await runtime.prompt(String(metadata.prompt ?? ""));
						await Bun.sleep(500);
					});
				promptQueues.set(runtime.sessionId, next);
				try {
					await next;
				} finally {
					if (promptQueues.get(runtime.sessionId) === next) promptQueues.delete(runtime.sessionId);
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
