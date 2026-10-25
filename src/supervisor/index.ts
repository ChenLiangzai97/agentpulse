import { homedir } from "node:os";
import type { ControlAction, LaunchRequest, ManagedSession } from "../shared/types.js";
import {
	ensureSupervisorConfigPrivate,
	loadSupervisorConfig,
	saveSupervisorConfig,
} from "./config.js";
import { createControlActionHandler } from "./control-actions.js";
import { createLaunchDispatcher } from "./launch-dispatch.js";
import {
	launchClaudeHeadlessRequest,
	launchClaudeInteractiveRequest,
	promptClaudeHeadlessSession,
	promptClaudeInteractiveSession,
} from "./providers/claude.js";
import {
	launchManagedCodexRequest,
	reconcileManagedCodexTitles,
	recoverManagedCodexSessions,
	stopManagedCodexSession,
} from "./providers/codex-managed.js";
import { createManagedOpenCodeProvider } from "./providers/opencode-managed.js";
import { checkOpenCodeProfileHealth } from "./providers/opencode-runtime.js";
import { executeCleanupWorkArea } from "./services/cleanup-workarea.js";
import { isCodexObserverEnabled, startCodexObserver } from "./services/codex-observer.js";
import {
	createRulesWatch,
	resolveAccountHome,
	warnIfHomeMismatch,
} from "./services/exclude-rules-watch.js";
import { parseErrorBodyField, sanitizeForLog } from "./services/log-sanitize.js";
import { createManagedOutbox } from "./services/managed-outbox.js";
import { executePrelaunchActions } from "./services/prelaunch-actions.js";
import { retryWithBackoff } from "./services/registration-retry.js";
import { createReportGate, heartbeatBody } from "./services/report-gate.js";
import { SupervisorRequestError } from "./services/report-resilience.js";

const REQUEST_TIMEOUT_MS = 15_000;
/** How often the exclude rules are re-read for a changed symlink, the stamp is refreshed and sessions a new rule covers are closed. */
const EXCLUDE_SCAN_MS = 15_000;

async function request(path: string, options?: RequestInit) {
	const config = await loadSupervisorConfig();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.supervisorCredential)
		headers["X-AgentPulse-Supervisor-Token"] = config.supervisorCredential;
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

	const res = await fetch(`${config.serverUrl}/api/v1${path}`, {
		...options,
		headers,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		// Best-effort: carry the server's own error string (F43) alongside the
		// raw status for logging. F49: both the body and statusText are
		// attacker-controlled (a malicious/compromised server, or a
		// network-position attacker on an unencrypted http:// path) — bound
		// the body read and strip control/ANSI characters before either ever
		// reaches a log line.
		const bodyError = await parseErrorBodyField(res);
		throw new SupervisorRequestError(res.status, sanitizeForLog(res.statusText), bodyError);
	}
	return res.json();
}

async function main() {
	// AGEN-21: self-heal a pre-fix, over-permissive supervisor.json before
	// anything reads it.
	ensureSupervisorConfigPrivate();
	const config = await loadSupervisorConfig();
	// F43/D10: registration retries forever on any HTTP failure (including
	// an old-shadow 401/403 from a not-yet-upgraded server during a
	// mixed-version rollout) instead of exiting and crash-looping. Only a
	// config load failure or a malformed success body is fatal here.
	const registration = (await retryWithBackoff(
		() =>
			request("/supervisors/register", {
				method: "POST",
				body: JSON.stringify({
					id: config.id,
					enrollmentToken: config.enrollmentToken,
					hostName: config.hostName,
					platform: config.platform,
					arch: config.arch,
					version: config.version,
					trustedRoots: config.trustedRoots,
					capabilities: config.capabilities,
					capabilitySchemaVersion: 3,
					configSchemaVersion: 1,
				}),
			}),
		(error, attempt, delayMs) => {
			console.error(
				`[supervisor] registration failed (attempt ${attempt + 1}): status=${error.status} statusText=${error.statusText}${
					error.error ? ` body.error=${error.error}` : ""
				}; retrying in ${delayMs}ms`,
			);
		},
	)) as {
		supervisor: { id: string; hostName: string };
		heartbeatIntervalMs: number;
		supervisorCredential?: string;
	};

	if (config.id !== registration.supervisor.id || registration.supervisorCredential) {
		await saveSupervisorConfig({
			...config,
			id: registration.supervisor.id,
			enrollmentToken: undefined,
			supervisorCredential: registration.supervisorCredential ?? config.supervisorCredential,
		});
	}

	console.log(
		`[supervisor] Registered ${registration.supervisor.hostName} (${registration.supervisor.id})`,
	);

	// The user's exclude rules, read once and shared by the report gate and the Codex observer.
	const home = process.env.HOME || homedir();
	const rules = createRulesWatch({ home });
	warnIfHomeMismatch(home, resolveAccountHome(), (line) => console.warn(line));

	// Observe local Codex rollout files and forward events as hooks. Codex's
	// own HTTP hooks have been stable since codex-cli 0.124.0 and are the
	// primary event source; the observer stays as belt-and-suspenders (dual
	// coverage) and backfill for sessions started before the supervisor was
	// running. Demotion to a pure fallback is a follow-up once more
	// reliability data is collected.
	//
	// AGENTPULSE_CODEX_OBSERVER=off is an operator-only escape hatch — no
	// installer sets it (Decision 19 supersedes the installer-disables-it
	// approach: it fails closed whenever native hooks are untrusted).
	if (isCodexObserverEnabled(process.env)) {
		void startCodexObserver({
			serverUrl: config.serverUrl,
			apiKey: config.apiKey ?? null,
			rules,
			hostName: config.hostName,
		}).catch((error) => {
			console.error("[codex-observer] failed to start:", error);
		});
	} else {
		console.log("[codex-observer] disabled via AGENTPULSE_CODEX_OBSERVER=off");
	}

	let lastHeartbeatOkAt = Date.now();
	const watchdogStaleMs = Math.max(registration.heartbeatIntervalMs * 3, 90_000);
	setInterval(
		() => {
			const staleMs = Date.now() - lastHeartbeatOkAt;
			if (staleMs > watchdogStaleMs) {
				console.error(
					`[supervisor] watchdog: no successful heartbeat in ${Math.round(staleMs / 1000)}s — preserving active sessions while reconnecting`,
				);
			}
		},
		Math.max(10_000, Math.floor(registration.heartbeatIntervalMs / 2)),
	).unref();

	// Every report about a session leaves through this gate (see report-gate.ts): it holds the
	// directories sessions and launches were started in, and the one closing report a newly
	// excluded session gets. The rules it reads are the observer's too.
	const gate = createReportGate({
		request,
		supervisorId: registration.supervisor.id,
		home,
		version: config.version,
		rules,
	});
	const outbox = createManagedOutbox(home, (id, events) => gate.reportEvents(id, events));
	const reportingGate = {
		...gate,
		reportEvents: (id: string, events: Parameters<typeof gate.reportEvents>[1]) =>
			gate.verdict(id) === "send" ? outbox.enqueue(id, events) : gate.reportEvents(id, events),
	};
	setInterval(() => {
		void outbox.flush().catch((error) => {
			console.error("[managed-outbox] retry failed", error);
			if (error instanceof SupervisorRequestError && error.status === 401) process.exit(1);
		});
	}, 3_000).unref();
	const openCode = createManagedOpenCodeProvider(
		{ ...config, id: registration.supervisor.id },
		home,
		{
			request,
			verdict: (id) => gate.verdict(id),
			checkExecutionPermit: async (actionId, claimToken) => {
				await request(
					`/supervisors/${registration.supervisor.id}/control-actions/${actionId}/permit`,
					{ method: "POST", body: JSON.stringify({ claimToken }) },
				);
			},
			// Fork results go to the AUTHENTICATED endpoint; the server mints all
			// ids and commits the single transaction. Entry points stay CLOSED.
			reportForkResult: async (actionId, body) => {
				await request(
					`/supervisors/${registration.supervisor.id}/control-actions/${actionId}/fork-result`,
					{ method: "POST", body: JSON.stringify(body) },
				);
			},
			// Committed (trusted) fork children only — the server enumerates them
			// from the protected bindings + creation ledger for this generation.
			listTrustedForkChildren: async (instanceId, generation) => {
				const result = (await request(
					`/supervisors/${registration.supervisor.id}/opencode/${instanceId}/children?generation=${generation}`,
				)) as { children?: { sessionId: string; nativeSessionId: string }[] };
				return result.children ?? [];
			},
		},
	);
	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.on(signal, () => void openCode.close().finally(() => process.exit(0)));
	const dispatchLaunch = createLaunchDispatcher({
		gate: reportingGate,
		trustedRoots: config.trustedRoots,
		providers: {
			launchManagedCodex: launchManagedCodexRequest,
			launchManagedOpenCode: openCode.launch,
			launchClaudeHeadless: launchClaudeHeadlessRequest,
			launchClaudeInteractive: launchClaudeInteractiveRequest,
		},
		executePrelaunchActions,
	});
	const handleControlAction = createControlActionHandler({
		gate: reportingGate,
		trustedRoots: config.trustedRoots,
		providers: {
			stopManagedCodexSession,
			openCodeControl: openCode.control,
			openCodeHealth: () => checkOpenCodeProfileHealth(config.opencodeProfilePath ?? ""),
			promptClaudeHeadlessSession,
			promptClaudeInteractiveSession,
		},
		executeCleanupWorkArea,
	});

	void gate.scan();
	setInterval(() => {
		gate.scan().catch((error) => console.error("[supervisor] exclude scan failed", error));
	}, EXCLUDE_SCAN_MS).unref();

	setInterval(async () => {
		try {
			const result = (await request(`/supervisors/${registration.supervisor.id}/launches/claim`, {
				method: "POST",
			})) as { launchRequest: LaunchRequest | null };
			if (result.launchRequest) {
				await dispatchLaunch(result.launchRequest);
			}
		} catch (error) {
			console.error("[supervisor] claim failed", error);
		}
	}, 3_000);

	setInterval(async () => {
		try {
			// Whether the exclude file on this host is in use, absent or broken, for the Hosts page.
			// Optional on the wire: a server that predates the field ignores the body.
			await request(`/supervisors/${registration.supervisor.id}/heartbeat`, {
				method: "POST",
				body: heartbeatBody(gate.rulesState()),
			});
			lastHeartbeatOkAt = Date.now();
			console.log("[supervisor] heartbeat ok");
		} catch (error) {
			console.error("[supervisor] heartbeat failed", error);
		}
	}, registration.heartbeatIntervalMs);

	setInterval(async () => {
		try {
			const result = (await request(
				`/supervisors/${registration.supervisor.id}/provider-sync?includeRecoverable=true`,
			)) as { managedSessions: ManagedSession[] };
			await recoverManagedCodexSessions(
				result.managedSessions ?? [],
				reportingGate,
				config.trustedRoots,
			);
			await reconcileManagedCodexTitles(result.managedSessions ?? [], (body) =>
				gate.reportState(body),
			);
		} catch (error) {
			console.error("[supervisor] provider sync failed", error);
		}
	}, 3_000);

	setInterval(async () => {
		try {
			const result = (await request(
				`/supervisors/${registration.supervisor.id}/control-actions/claim`,
				{ method: "POST" },
			)) as { action: ControlAction | null };
			if (result.action) await handleControlAction(result.action);
		} catch (error) {
			console.error("[supervisor] control action failed", error);
		}
	}, 2_000);
}

main().catch((error) => {
	console.error("[supervisor] fatal", error);
	process.exit(1);
});
