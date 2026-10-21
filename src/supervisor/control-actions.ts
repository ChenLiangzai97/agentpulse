import { realpath } from "node:fs/promises";
import type { LaunchRequest } from "../shared/types.js";
/**
 * Runs one claimed control action (stop, prompt, workarea cleanup) and reports
 * its result.
 *
 * Before anything is executed the action is checked with the report gate. A session
 * is judged by the directory this supervisor started it in; the directory the
 * action itself names is only compared with it (a different one is refused, a
 * covered one excludes), never believed in its place. While rules exist an action
 * for a session this supervisor did not start is refused, and one that is not
 * about a session is judged by the directory it names. A refused action is not
 * executed and the only thing reported is the gate's generic failure. While the
 * exclude file is invalid nothing is executed and nothing is reported. Every
 * report an action makes, including one that arrives after it finished running,
 * goes through the gate.
 *
 * While rules exist every way a workarea cleanup can be refused answers with the one
 * generic body, so whether a path is covered, outside the trusted roots or missing is not
 * learnable from the answer; the specifics go to the host's own log. The difference
 * between a cleanup that ran and one that was refused stays visible for a path under a
 * trusted root, which is inherent to reporting a result at all. With no rules file the
 * bodies are what they always were.
 */
import type { ControlAction, ManagedState } from "../shared/types.js";
import { MANAGED_STATES } from "../shared/types.js";
import type { LaunchCallbacks } from "./providers/claude-shared.js";
import type {
	promptClaudeHeadlessSession,
	promptClaudeInteractiveSession,
} from "./providers/claude.js";
import {
	launchManagedCodexRequest,
	promptManagedCodexSession,
	respondManagedApproval,
} from "./providers/codex-managed.js";
import type { stopManagedCodexSession } from "./providers/codex-managed.js";
import { CleanupError, type executeCleanupWorkArea } from "./services/cleanup-workarea.js";
import { isUnderAnyRoot, resolveTrustedRoots } from "./services/prelaunch-actions.js";
import { type ReportGate, controlRefusalBody } from "./services/report-gate.js";

export type ControlProviders = {
	openCodeControl?: (
		action: ControlAction,
		report: (body: { status: "succeeded" | "failed"; error?: string }) => Promise<void>,
	) => Promise<void>;
	openCodeHealth?: () => Promise<string>;
	stopManagedCodexSession: typeof stopManagedCodexSession;
	promptClaudeHeadlessSession: typeof promptClaudeHeadlessSession;
	promptClaudeInteractiveSession: typeof promptClaudeInteractiveSession;
};

export interface ControlActionDeps {
	gate: ReportGate;
	trustedRoots: string[];
	providers: ControlProviders;
	executeCleanupWorkArea: typeof executeCleanupWorkArea;
	log?: (line: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The directory an action names itself; the gate only compares it with what it knows. */
function namedDirectory(action: ControlAction): string | undefined {
	if (action.actionType !== "prompt" && action.actionType !== "cleanup_workarea") return undefined;
	const cwd = asRecord(action.metadata)?.cwd;
	return typeof cwd === "string" && cwd ? cwd : undefined;
}

export function createControlActionHandler(
	deps: ControlActionDeps,
): (action: ControlAction) => Promise<void> {
	const { gate, providers } = deps;
	const log = deps.log ?? ((line: string) => console.log(line));

	/** Status results, always through the gate: `succeeded` for a session that is now excluded becomes the generic failure. */
	const report = (action: ControlAction, body: Parameters<ReportGate["reportControlStatus"]>[2]) => {
		// Bind every result to the claim token issued with THIS action, so a late
		// result from an older claim cannot overwrite a newer running attempt.
		const claimToken =
			typeof action.metadata?.claimToken === "string" ? action.metadata.claimToken : undefined;
		return gate.reportControlStatus(
			action.id,
			action.sessionId ?? null,
			claimToken ? { ...body, claimToken } : body,
			namedDirectory(action),
		);
	};

	async function stop(action: ControlAction, sessionId: string) {
		try {
			await providers.stopManagedCodexSession(sessionId);
			await gate.reportState({
				sessionId,
				status: "completed",
				managedState: "stopped" satisfies ManagedState,
				providerSyncState: "synced",
			});
			await gate.reportEvents(sessionId, [
				{
					eventType: "ManagedSessionStopped",
					category: "system_event",
					content: "Managed session stopped by operator.",
				},
			]);
			await report(action, { status: "succeeded" });
		} catch (error) {
			await report(action, {
				status: "failed",
				error: error instanceof Error ? error.message : "Failed to stop managed session",
			});
		}
	}

	async function prompt(action: ControlAction, sessionId: string) {
		const metadata = (action.metadata ?? {}) as Record<string, unknown>;
		const text = typeof metadata.prompt === "string" ? metadata.prompt : "";
		const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
		const model = typeof metadata.model === "string" ? metadata.model : null;
		// Coerce metadata.managedState (cross-process JSON, untyped) into the
		// canonical ManagedState union; unknown values fall through as null
		// so the prompt routing below treats them as the default headless path.
		const managedState: ManagedState | null =
			typeof metadata.managedState === "string" &&
			(MANAGED_STATES as readonly string[]).includes(metadata.managedState)
				? (metadata.managedState as ManagedState)
				: null;
		const env = asRecord(metadata.env) ? (metadata.env as Record<string, string>) : {};
		const terminalOwner = asRecord(metadata.terminalOwner);
		const interactiveBridge = asRecord(metadata.interactiveBridge);
		const callbacks: LaunchCallbacks = {
			reportState: (body) => gate.reportState(body),
			reportEvents: (events) => gate.reportEvents(sessionId, events),
		};

		try {
			if (!text || !cwd) {
				throw new Error("Prompt action is missing prompt or working directory.");
			}

			if (metadata.agentType === "codex_cli") {
				await promptManagedCodexSession(sessionId, text, callbacks);
				await report(action, { status: "succeeded" });
				return;
			}
			if (managedState === "interactive_terminal") {
				const response = await providers.promptClaudeInteractiveSession(
					{
						sessionId,
						prompt: text,
						cwd,
						model,
						env,
						managedState,
						terminalOwner,
						interactiveBridge,
					},
					callbacks,
				);
				await report(action, { status: "succeeded", metadata: response.metadata });
				return;
			}

			const response = await providers.promptClaudeHeadlessSession(
				{ sessionId, prompt: text, cwd, model, env, managedState },
				async () => {},
				callbacks,
			);
			void response.monitor
				.then(async () => {
					await report(action, { status: "succeeded", metadata: response.metadata });
				})
				.catch(async (error) => {
					await report(action, {
						status: "failed",
						error: error instanceof Error ? error.message : "Failed to execute prompt",
					});
				});
		} catch (error) {
			await report(action, {
				status: "failed",
				error: error instanceof Error ? error.message : "Failed to execute prompt action",
			});
		}
	}

	async function cleanup(action: ControlAction) {
		const metadata = (action.metadata ?? {}) as Record<string, unknown>;
		const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
		try {
			if (!cwd) throw new Error("cleanup_workarea action is missing cwd metadata.");
			const result = await deps.executeCleanupWorkArea({
				cwd,
				trustedRoots: deps.trustedRoots,
				logProgress: (msg) => log(`[cleanup] ${msg}`),
			});
			await report(action, {
				status: "succeeded",
				metadata: {
					...metadata,
					cleanup: { removed: result.removed, resolvedPath: result.resolvedPath },
				},
			});
		} catch (error) {
			const detail = error instanceof CleanupError ? error.toJSON() : null;
			if (gate.rulesState() !== "none") {
				// While rules exist every refusal looks the same from outside: whether a path is covered,
				// outside the roots or missing must not be learnable from the answer. What happened stays here.
				const why = detail
					? `${detail.code}: ${detail.message}`
					: error instanceof Error
						? error.message
						: "cleanup failed";
				log(`[cleanup] action ${action.id} refused: ${why}`);
				await report(action, controlRefusalBody());
				return;
			}
			await report(action, {
				status: "failed",
				error: detail?.message ?? (error instanceof Error ? error.message : "Cleanup failed"),
				metadata: detail ? { ...metadata, cleanupError: detail } : metadata,
			});
		}
	}

	return async function handleControlAction(action) {
		const sessionId = action.sessionId ?? null;
		if (action.actionType === "opencode_health" && !sessionId) {
			try {
				if (!providers.openCodeHealth) throw new Error("OpenCode unavailable");
				await report(action, {
					status: "succeeded",
					metadata: {
						targetSupervisorId: action.metadata?.targetSupervisorId,
						health: await providers.openCodeHealth(),
					},
				});
			} catch {
				await report(action, { status: "failed", error: "opencode_health_unavailable" });
			}
			return;
		}
		const named = namedDirectory(action);
		if (action.actionType === "resume" && sessionId) {
			try {
				const launch = action.metadata?.launch as LaunchRequest;
				if (!launch || launch.launchCorrelationId !== sessionId)
					throw new Error("Invalid resume descriptor");
				const cwd = await realpath(launch.cwd);
				const roots = await resolveTrustedRoots(deps.trustedRoots);
				if (!isUnderAnyRoot(cwd, roots)) throw new Error("Directory outside trusted roots");
				if (!gate.noteCwd(sessionId, cwd) || gate.verdict(sessionId, cwd) !== "send") {
					await gate.refuseControlAction(action.id);
					return;
				}
				if (launch.agentType === "codex_cli") {
					const threadId = action.metadata?.providerThreadId;
					if (typeof threadId !== "string" || !threadId)
						throw new Error("Missing native thread ID");
					await launchManagedCodexRequest(
						launch,
						{
							reportState: (body) => gate.reportState(body),
							reportEvents: (events) => gate.reportEvents(sessionId, events),
						},
						{ resumeThreadId: threadId, noPrompt: true },
					);
				} else if (launch.agentType === "claude_code") {
					await gate.reportState({
						sessionId,
						managedState: "headless",
						status: "idle",
						providerSyncState: "synced",
					});
				} else throw new Error("Provider cannot resume");
				await report(action, { status: "succeeded" });
			} catch (error) {
				await report(action, {
					status: "failed",
					error: error instanceof Error ? error.message : "Resume failed",
				});
			}
			return;
		}
		const verdict = sessionId ? gate.verdict(sessionId, named) : gate.verdictForDirectory(named);
		if (verdict !== "send") {
			log(`[supervisor] control action ${action.id} (${action.actionType}) not executed`);
			await gate.refuseControlAction(action.id);
			return;
		}

		if (action.metadata?.agentType === "opencode") {
			// REPORT OWNERSHIP is claimed BEFORE the call starts: a thrown report
			// (lost response) means "started, outcome unknown" and the outer catch
			// must NOT send a second (failed) report.
			let reportOwned = false;
			try {
				if (!providers.openCodeControl) throw new Error("OpenCode provider unavailable");
				await providers.openCodeControl(action, async (body: { status: "succeeded" | "failed"; error?: string }) => {
					reportOwned = true;
					await report(action, body);
				});
				if (!reportOwned) await report(action, { status: "succeeded" });
			} catch (error) {
				if (!reportOwned)
					await report(action, {
						status: "failed",
						error: error instanceof Error ? error.message : "OpenCode action failed",
					});
			}
			return;
		}
		if (action.actionType === "approval" && sessionId) {
			try {
				respondManagedApproval(
					sessionId,
					String(action.metadata?.approvalId),
					String(action.metadata?.decision),
				);
				await gate.reportEvents(sessionId, [
					{
						eventType: "NativeApprovalResolved",
						category: "system_event",
						content: String(action.metadata?.decision),
						rawPayload: { approvalId: action.metadata?.approvalId },
					},
				]);
				await report(action, { status: "succeeded" });
			} catch (error) {
				await report(action, {
					status: "failed",
					error: error instanceof Error ? error.message : "Approval failed",
				});
			}
			return;
		}
		if (action.actionType === "stop" && sessionId) return stop(action, sessionId);
		if (action.actionType === "prompt" && sessionId) return prompt(action, sessionId);
		if (action.actionType === "cleanup_workarea") return cleanup(action);

		await report(action, {
			status: "failed",
			error: `Unsupported control action: ${action.actionType}`,
		});
	};
}
