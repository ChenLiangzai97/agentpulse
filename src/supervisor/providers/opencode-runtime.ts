import type { ForkChildMap, ForkSnapshot } from "./fork-snapshot.js";
import { markAbort, newClaimState, observeClaim } from "./session-claim.js";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
/** Isolated OpenCode 1.18.35 runtime. Never adopts a process or accepts a caller URL. */
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { writePrivateFileSyncNoFollow } from "../../shared/private-file.js";
import { processStartTicks } from "./opencode-recovery.js";

export interface OpenCodeRuntimeConfig {
	executable: string;
	profilePath: string;
	stateDirectory: string;
	maxInstances: number;
	idleTimeoutMs: number;
	stopGraceMs: number;
}
export type OpenCodeHealth =
	| "ready"
	| "not_configured"
	| "authentication_failed"
	| "model_unavailable"
	| "unavailable";
export interface OpenCodeProfile {
	model: string;
	provider: Record<
		string,
		{ npm: string; options: { baseURL?: string; apiKey?: string }; models: Record<string, unknown> }
	>;
}
export interface OpenCodeRuntime {
	instanceId: string;
	generation: number;
	sessionId: string;
	nativeSessionId: string;
	cwd: string;
	pid: number;
	directory: string;
	/** Stable fork ledger for this instance (survives runtime restarts). */
	ledgerDirectory: string;
	request<T = unknown>(path: string, body?: unknown): Promise<T>;
	prompt(
		text: string,
		options?: {
			model?: { providerID: string; modelID: string };
			agent?: string;
			/** Target native session (default: the bound one; a fork child must be known). */
			nativeSessionId?: string;
		},
	): Promise<void>;
	runCommand(
		command: string,
		args?: string,
		options?: {
			model?: { providerID: string; modelID: string };
			agent?: string;
			nativeSessionId?: string;
		},
	): Promise<void>;
	abort(nativeSessionId?: string): Promise<void>;
	stop(): Promise<void>;
	snapshot(): Promise<{
		messages: unknown[];
		children?: { session: Record<string, unknown>; messages: unknown[] }[];
		permissions: unknown[];
		questions: unknown[];
		status: unknown;
		sessions: Record<string, { type: string }>;
		commands?: unknown[];
		agents?: unknown[];
		providers?: unknown;
	}>;
	touch(): void;
	/** Registers a child from an AUTHENTICATED fork result (never from snapshots). */
	registerManagedChild(nativeSessionId: string): void;
	/** Evidence captured in the controlled window before executing a fork. */
	captureForkSnapshot(forkPointMessageId?: string | null): Promise<ForkSnapshot>;
	/** Holds the instance/source session for the whole capture+fork window. */
	withExclusiveFork<T>(run: () => Promise<T>): Promise<T>;
	/** Parent->child message map for the execution-time copyOf window. */
	captureChildMap(childNativeSessionId: string, parentSnapshot: ForkSnapshot): Promise<ForkChildMap>;
	/** Root-session full fork only; the child stays unaddressable until confirmed. */
	forkSession(
		nativeSessionId?: string,
		body?: Record<string, unknown>,
	): Promise<{ id: string; parentID: string | null }>;
	subscribe(onEvent: () => void): () => void;
}

/** Dedicated private file; ambient user auth/config is deliberately never copied. */
export async function readOpenCodeProfile(path: string): Promise<OpenCodeProfile> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		throw new Error("opencode_not_configured");
	}
	let profile: OpenCodeProfile;
	try {
		const info = await file.stat();
		if (!info.isFile() || (info.mode & 0o077) !== 0)
			throw new Error("opencode_profile_must_be_private");
		try {
			profile = JSON.parse(await file.readFile("utf8")) as OpenCodeProfile;
		} catch {
			throw new Error("opencode_profile_invalid");
		}
	} finally {
		await file.close();
	}
	const [providerID, ...modelParts] = String(profile?.model ?? "").split("/");
	const modelID = modelParts.join("/");
	const provider = profile?.provider?.[providerID];
	if (
		!provider ||
		!modelID ||
		!provider.models?.[modelID] ||
		!provider.options?.apiKey ||
		!provider.options.baseURL
	)
		throw new Error("opencode_not_configured");
	if (provider.npm !== "@ai-sdk/openai-compatible")
		throw new Error("opencode_unsupported_provider");
	return profile;
}

export class OpenCodeRuntimePool {
	private instances = new Map<
		string,
		{ runtime: OpenCodeRuntime; lastUsed: number; busy: boolean; pending: boolean }
	>();
	private starting = new Set<string>();
	constructor(readonly config: OpenCodeRuntimeConfig) {
		if (
			!Number.isInteger(config.maxInstances) ||
			config.maxInstances < 1 ||
			config.maxInstances > 32 ||
			config.idleTimeoutMs < 60_000 ||
			config.stopGraceMs < 100 ||
			config.stopGraceMs > 30_000
		)
			throw new Error("opencode_invalid_resource_limits");
	}
	get(sessionId: string) {
		return this.instances.get(sessionId)?.runtime;
	}
	async start(input: {
		instanceId: string;
		generation: number;
		sessionId: string;
		cwd: string;
		title: string;
	}): Promise<OpenCodeRuntime> {
		if (this.instances.has(input.sessionId) || this.starting.has(input.sessionId))
			throw new Error("opencode_already_started");
		if (this.instances.size + this.starting.size >= this.config.maxInstances)
			throw new Error("opencode_capacity_exceeded");
		this.starting.add(input.sessionId);
		let process: ReturnType<typeof Bun.spawn> | undefined;
		let directory: string | undefined;
		let ledgerDirectory: string | undefined;
		try {
			const profile = await readOpenCodeProfile(this.config.profilePath);
			const cwd = await realpath(input.cwd);
			await mkdir(this.config.stateDirectory, { recursive: true, mode: 0o700 });
			directory = await mkdtemp(join(this.config.stateDirectory, "instance-"));
			// The fork ledger must outlive a runtime restart: it lives in a
			// STABLE per-instance directory, not in the ephemeral instance dir.
			ledgerDirectory = join(
				this.config.stateDirectory,
				"fork-ledger",
				input.instanceId.replace(/[^A-Za-z0-9_-]/g, "_"),
			);
			await mkdir(ledgerDirectory, { recursive: true, mode: 0o700 });
			const isolated: Record<string, string> = {};
			for (const key of [
				"XDG_CONFIG_HOME",
				"XDG_DATA_HOME",
				"XDG_CACHE_HOME",
				"XDG_STATE_HOME",
				"TMPDIR",
			]) {
				isolated[key] = join(directory, key.toLowerCase());
				await mkdir(isolated[key], { mode: 0o700 });
			}
			const password = randomBytes(32).toString("hex");
			const configPath = join(directory, "provider.json");
			writePrivateFileSyncNoFollow(
				configPath,
				JSON.stringify({
					model: profile.model,
					small_model: profile.model,
					provider: profile.provider,
					enabled_providers: [profile.model.split("/")[0]],
					snapshot: false,
					share: "disabled",
				}),
			);
			// Explicit allowlist prevents OPENCODE_CONFIG_CONTENT, provider keys, preload hooks and
			// inherited BotMux configuration from weakening --pure isolation.
			const environment: Record<string, string> = {
				PATH: globalThis.process.env.PATH ?? "",
				HOME: directory,
				...isolated,
				OPENCODE_CONFIG: configPath,
				OPENCODE_SERVER_PASSWORD: password,
				OPENCODE_SERVER_USERNAME: "agentpulse",
				OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
				OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
			};
			process = Bun.spawn({
				cmd: [this.config.executable, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"],
				cwd,
				env: environment,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			const child = process;
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			let output = "";
			const startup = (async () => {
				while (true) {
					const { value, done } = await reader.read();
					if (done) throw new Error("opencode_startup_failed");
					output = (output + new TextDecoder().decode(value)).slice(-8192);
					const match = output.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/);
					if (match) return match[1];
				}
			})();
			const base = await Promise.race([
				startup,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(() => reject(new Error("opencode_startup_timeout")), 20_000);
					timer.unref();
				}),
			]);
			// Drain without persisting provider output (it can contain secrets or prompts).
			void (async () => {
				try {
					while (!(await reader.read()).done) {}
				} catch {}
			})();
			const request = async <T = unknown>(path: string, body?: unknown): Promise<T> => {
				if (child.exitCode !== null) throw new Error("opencode_process_interrupted");
				const url = new URL(path, base);
				url.searchParams.set("directory", cwd);
				if (url.origin !== base) throw new Error("opencode_invalid_path");
				return new Promise<T>((resolve, reject) => {
					const request = httpRequest(
						url,
						{
							method: body === undefined ? "GET" : "POST",
							headers: {
								Authorization: `Basic ${btoa(`agentpulse:${password}`)}`,
								"Content-Type": "application/json",
							},
						},
						(response) => {
							let text = "";
							response.on("data", (chunk) => {
								text += chunk;
								if (text.length > 32 * 1024 * 1024)
									request.destroy(new Error("opencode_response_too_large"));
							});
							response.on("error", reject);
							response.on("end", () => {
								if ((response.statusCode ?? 500) >= 300)
									return reject(new Error(`opencode_http_${response.statusCode}`));
								try {
									resolve(text ? (JSON.parse(text) as T) : (undefined as T));
								} catch (error) {
									reject(error);
								}
							});
						},
					);
					request.setTimeout(15000, () => request.destroy(new Error("opencode_timeout")));
					request.on("error", reject);
					request.end(body === undefined ? undefined : JSON.stringify(body));
				});
			};
			const health = await request<{ healthy: boolean; version: string }>("/global/health");
			if (!health.healthy || health.version !== "1.18.35")
				throw new Error("opencode_unverified_protocol_version");
			const native = await request<{ id: string; directory: string }>("/session", {
				title: input.title,
				permission: [{ permission: "*", pattern: "*", action: "ask" }],
			});
			if (native.directory !== cwd || !/^ses_[A-Za-z0-9_-]+$/.test(native.id))
				throw new Error("opencode_directory_mismatch");
			const nativePath = `/session/${encodeURIComponent(native.id)}`;
			// A6: native sessions this runtime may address. The bound session plus
			// children registered from an AUTHENTICATED fork result — snapshots only
			// update OBSERVATION state and never grant control. Anything else is an
			// explicit refusal (a bare id or a subtree match proves nothing).
			const knownSessions = new Set<string>([native.id]);
			// Per-target execution claims: ONE turn in flight per native session.
			// Check-and-set is atomic within this single-threaded runtime, so two
			// immediate prompts can never both pass before a snapshot reports busy.
			interface Claim {
				/** Unique per attempt: an old callback may never free a new claim. */
				id: string;
				/** Native user-message id sent with this request (correlation key). */
				messageID: string;
				state: ReturnType<typeof newClaimState>;
			}
			// native id -> in-flight claim bound to the REQUEST identity.
			const executing = new Map<string, Claim>();
			/** Incremented BEFORE the first await of each snapshot (observation gen). */
			let snapshotSeq = 0;
			/**
			 * One fork window at a time: no prompt/command may run between the
			 * snapshot and the native fork, or the captured parent state would be
			 * a lie.
			 */
			let forking = false;
			const withExclusiveFork = async <T>(run: () => Promise<T>): Promise<T> => {
				if (forking) throw new Error("opencode_fork_busy");
				forking = true;
				try {
					const deadline = Date.now() + 30_000;
					while (executing.size > 0) {
						if (Date.now() > deadline) throw new Error("opencode_fork_wait_timeout");
						await Bun.sleep(50);
					}
					return await run();
				} finally {
					forking = false;
				}
			};
			// Targets must be in the TRUSTED addressable set (bound session or a
			// child registered from an authenticated fork result).
			// Correlation helpers over the native message list. The COMPLETION of
			// THIS request is proven only by an assistant message whose parentID is
			// our messageID (and which is completed/failed), never by "some new id".
			const assistantFor = (list: unknown[], messageID: string) =>
				list.find((item) => {
					const info = (item as { info?: Record<string, unknown> })?.info;
					return info?.role === "assistant" && info?.parentID === messageID;
				}) as { info?: Record<string, unknown> } | undefined;
			/** Every assistant step of ONE request (all share the user message id). */
			const turnAssistants = (list: unknown[], messageID: string) =>
				list.filter((item) => {
					const info = (item as { info?: Record<string, unknown> })?.info;
					return info?.role === "assistant" && info?.parentID === messageID;
				}) as { info: Record<string, unknown> }[];
			/**
			 * A turn is terminal only when its LAST assistant step completed with
			 * finish "stop" (a completed intermediate step with finish
			 * "tool-calls" is not the end of the turn) and that step has no
			 * running tool. Earlier steps' stale parts are irrelevant.
			 */
			/** Abort case: the last step is completed OR carries an error (cancelled). */
			const abortTerminal = (list: unknown[], messageID: string) => {
				const last = turnAssistants(list, messageID).at(-1);
				if (!last) return false;
				const time = last.info.time as { completed?: unknown } | undefined;
				return Boolean(time?.completed) || Boolean(last.info.error);
			};
			const turnTerminal = (list: unknown[], messageID: string) => {
				const steps = turnAssistants(list, messageID);
				const last = steps.at(-1);
				if (!last) return false;
				const time = last.info.time as { completed?: unknown } | undefined;
				if (!time?.completed || last.info.error) return false;
				// "tool-calls" means the turn CONTINUES with another step. A
				// completed message with no finish marker is terminal.
				if (last.info.finish === "tool-calls") return false;
				return !runningTools([last]);
			};
			const runningTools = (list: unknown[]) =>
				list.some(
					(value) =>
						Array.isArray((value as { parts?: unknown[] }).parts) &&
						(value as { parts: unknown[] }).parts.some((part) => {
							const p = part as { type?: string; state?: { status?: string } };
							return p.type === "tool" && ["running", "pending"].includes(p.state?.status ?? "");
						}),
				);
			const hasUserMessage = (list: unknown[], messageID: string) =>
				list.some((item) => {
					const info = (item as { info?: Record<string, unknown> })?.info;
					return info?.id === messageID;
				});
			/**
			 * Atomic pre-claim happens BEFORE any await; the baseline read can then
			 * never interleave two same-target attempts. A baseline failure frees
			 * only THIS claim id.
			 */
			const integrate = async (
				kind: "prompt" | "command",
				target?: string,
			): Promise<{ id: string; path: string; claim: Claim }> => {
				const id = target ?? native.id;
				if (id !== native.id && !knownSessions.has(id))
					throw new Error("opencode_unknown_native_session");
				if (forking) throw new Error("opencode_session_busy");
				if (executing.has(id)) throw new Error("opencode_session_busy");
				if (id === native.id) {
					const current = this.instances.get(input.sessionId);
					if (!current || current.pending) throw new Error("opencode_session_busy");
				}
				const claim: Claim = {
					id: crypto.randomUUID(),
					messageID: `msg_ap_${crypto.randomUUID().replaceAll("-", "")}`,
					state: newClaimState(kind, snapshotSeq + 1),
				};
				executing.set(id, claim); // synchronous: no interleaving here
				try {
					await request<unknown[]>(`/session/${encodeURIComponent(id)}/message`);
				} catch (error) {
					if (executing.get(id) === claim) executing.delete(id);
					throw error;
				}
				return { id, path: id === native.id ? nativePath : `/session/${encodeURIComponent(id)}`, claim };
			};
			const release = (id: string, claim: Claim) => {
				if (executing.get(id) === claim) executing.delete(id);
			};
			const pathFor = (target?: string): string => {
				if (!target || target === native.id) return nativePath;
				if (!knownSessions.has(target)) throw new Error("opencode_unknown_native_session");
				return `/session/${encodeURIComponent(target)}`;
			};
			const subscriptions = new Set<() => void>();
			const runtime: OpenCodeRuntime = {
				ledgerDirectory: ledgerDirectory ?? directory,
				/**
				 * Evidence captured in the CONTROLLED WINDOW before the native fork.
				 * The server verifies this exact snapshot; the action metadata mirror
				 * is NOT accepted as evidence.
				 */
				async captureForkSnapshot(forkPointMessageId?: string | null) {
					const list = await request<unknown[]>(`${nativePath}/message`);
					const { createHash } = await import("node:crypto");
					const messages = list.map((item) => {
						const info = (item as { info?: { id?: unknown; time?: { created?: unknown } } })
							?.info;
						const created = Number(info?.time?.created ?? 0);
						return {
							nativeId: String(info?.id ?? ""),
							contentHash: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
							occurredAt: created > 0 ? new Date(created).toISOString() : new Date(0).toISOString(),
						};
					});
					return {
						version: 1 as const,
						instanceId: input.instanceId,
						nativeSessionId: native.id,
						messages,
						forkPointMessageId: forkPointMessageId ?? null,
					};
				},
				/** Runs capture+fork with the instance/source session exclusively held. */
				withExclusiveFork,
				async forkSession(nativeSessionId?: string, body?: Record<string, unknown>) {
					// SLICE LIMIT: only the bound root session, full-history fork.
					if (nativeSessionId && nativeSessionId !== native.id)
						throw new Error("opencode_fork_child_source_unsupported");
					const created = await request<{ id?: unknown; parentID?: unknown }>(`${nativePath}/fork`, {
						...(body ?? {}),
					});
					if (typeof created?.id !== "string" || !/^ses_[A-Za-z0-9_-]+$/.test(created.id))
						throw new Error("opencode_fork_invalid_result");
					// NOT addressable yet: registration is granted only after the
					// server commits the managed binding (registerManagedChild).
					return { id: created.id, parentID: typeof created.parentID === "string" ? created.parentID : null };
				},
				/**
				 * Execution-time copy map. Native fork REMAPS ids and is
				 * exclusive at the fork point, so the child history is the parent
				 * prefix: child[i] <-> parent[i], never by id lookup.
				 */
				async captureChildMap(
					childNativeSessionId: string,
					parentSnapshot: ForkSnapshot,
				): Promise<ForkChildMap> {
					const childMessages = await request<unknown[]>(
						`/session/${encodeURIComponent(childNativeSessionId)}/message`,
					);
					if (childMessages.length > parentSnapshot.messages.length)
						throw new Error("opencode_fork_child_prefix_invalid");
					return {
						version: 1,
						forkPointMessageId: parentSnapshot.forkPointMessageId,
						pairs: childMessages.map((item, index) => {
							const parentMessage = parentSnapshot.messages[index];
							if (!parentMessage) throw new Error("opencode_fork_child_prefix_invalid");
							return {
								parentNativeId: parentMessage.nativeId,
								childNativeId: String((item as { info?: { id?: unknown } })?.info?.id ?? ""),
								parentOccurredAt: parentMessage.occurredAt,
							};
						}),
					};
				},
				registerManagedChild(nativeSessionId: string) {
					if (!/^ses_[A-Za-z0-9_-]+$/.test(nativeSessionId))
						throw new Error("opencode_invalid_child_session");
					if (nativeSessionId === native.id) throw new Error("opencode_invalid_child_session");
					knownSessions.add(nativeSessionId);
				},
				subscribe(onEvent) {
					let stopped = false;
					let active: ReturnType<typeof httpRequest> | undefined;
					let timer: ReturnType<typeof setTimeout> | undefined;
					const connect = () => {
						if (stopped) return;
						const url = new URL("/event", base);
						url.searchParams.set("directory", cwd);
						active = httpRequest(
							url,
							{ headers: { Authorization: `Basic ${btoa(`agentpulse:${password}`)}` } },
							(response) => {
								if (response.statusCode !== 200) {
									response.resume();
									return;
								}
								let buffer = "";
								response.on("data", (chunk) => {
									buffer += chunk.toString();
									if (buffer.length > 2097152) buffer = "";
									let boundary: number;
									while ((boundary = buffer.indexOf("\n\n")) >= 0) {
										const frame = buffer.slice(0, boundary);
										buffer = buffer.slice(boundary + 2);
										if (frame.includes("data:")) onEvent();
									}
								});
							},
						);
						active.on("error", () => {});
						active.on("close", () => {
							if (!stopped) {
								timer = setTimeout(connect, 1000);
								timer.unref();
							}
						});
						active.end();
					};
					connect();
					const cancel = () => {
						stopped = true;
						if (timer) clearTimeout(timer);
						active?.destroy();
						subscriptions.delete(cancel);
					};
					subscriptions.add(cancel);
					return cancel;
				},
				...input,
				cwd,
				directory,
				pid: child.pid,
				nativeSessionId: native.id,
				request,
				touch: () => {
					const entry = this.instances.get(input.sessionId);
					if (entry) entry.lastUsed = Date.now();
				},
				prompt: async (text, options) => {
					const claim = await integrate("prompt", options?.nativeSessionId);
					const entry = this.instances.get(input.sessionId);
					if (entry) entry.lastUsed = Date.now();
					// No explicit model: inherit the session's current one (a previous
					// explicit carry switches it natively and stickily per session).
					// Never retry an ambiguous transport failure: native messageID is not part-idempotent.
					try {
						await request(`${claim.path}/prompt_async`, {
							messageID: claim.claim.messageID,
							...(options?.model ? { model: options.model } : {}),
							...(options?.agent ? { agent: options.agent } : {}),
							parts: [{ type: "text", text }],
						});
					} catch (error) {
						// DEFINITIVE rejection (4xx) never accepted the turn — free it.
						// Transport loss/timeout/5xx is UNKNOWN: keep the claim held.
						const status = Number(/opencode_http_(\d{3})/.exec(String((error as Error).message))?.[1]);
						if (status >= 400 && status < 500) release(claim.id, claim.claim);
						throw new Error("opencode_prompt_delivery_uncertain", { cause: error });
					}
				},
				runCommand: async (command, args, options) => {
					// Native custom-command execution: the instance expands the command
					// template as a user message and runs it. TUI built-ins are NOT
					// valid here (verified: 1.18.35 answers UnknownError).
					if (!/^[a-zA-Z0-9_-]+$/.test(command)) throw new Error("opencode_invalid_command");
					const claim = await integrate("command", options?.nativeSessionId);
					try {
						await request(`${claim.path}/command`, {
						command,
						arguments: args ?? "",
						messageID: `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
						// /command's model field is the "provider/model" string form.
						...(options?.model
							? { model: `${options.model.providerID}/${options.model.modelID}` }
							: {}),
							...(options?.agent ? { agent: options.agent } : {}),
						});
					} catch (error) {
						const status = Number(
							/opencode_http_(\d{3})/.exec(String((error as Error).message))?.[1],
						);
						// Only a definitive 4xx proves the command never ran.
						if (status >= 400 && status < 500) release(claim.id, claim.claim);
						throw error;
					}
					runtime.touch();
				},
				abort: async (nativeSessionId?: string) => {
					const id = nativeSessionId ?? native.id;
					// pathFor also enforces the trusted addressable set.
					await request(`${pathFor(nativeSessionId)}/abort`, {});
					// HTTP acceptance is NOT termination — the claim stays held until
					// a snapshot proves the target idle with no in-flight reply.
					const held = executing.get(id);
					if (held) held.state = markAbort(held.state, snapshotSeq + 1);
					runtime.touch();
				},
				stop: async () => {
					for (const cancel of subscriptions) cancel();
					// Only our live child handle can be signalled; no recovered PID or caller URL is trusted.
					if (child.exitCode === null) {
						child.kill("SIGTERM");
						await Promise.race([
							child.exited,
							new Promise<void>((resolve) => setTimeout(resolve, this.config.stopGraceMs)),
						]);
						if (child.exitCode === null) {
							child.kill("SIGKILL");
							await child.exited;
						}
					}
					this.instances.delete(input.sessionId);
					await rm(configPath, { force: true });
				},
				snapshot: async () => {
					// Observation generation: a snapshot that began BEFORE a claim
					// (or before an abort) can never settle it, even if it returns
					// later with a stale idle status.
					const seq = ++snapshotSeq;
					
					const [
						messages,
						permissions,
						questions,
						status,
						nativeSessions,
						commands,
						agents,
						providers,
					] = await Promise.all([
						request<unknown[]>(`${nativePath}/message`),
						request<unknown[]>("/permission"),
						request<unknown[]>("/question"),
						request<Record<string, { type: string }>>("/session/status"),
						request<Record<string, unknown>[]>("/session"),
						request<unknown[]>("/command").catch(() => []),
						request<unknown[]>("/agent").catch(() => []),
						request<unknown>("/config/providers").catch(() => null),
					]);
					const descendants = new Set<string>([native.id]);
					for (const id of knownSessions) descendants.add(id);
					for (let depth = 0; depth < 64; depth++) {
						let changed = false;
						for (const session of nativeSessions) {
							if (
								typeof session.id === "string" &&
								session.directory === cwd &&
								descendants.has(String(session.parentID)) &&
								!descendants.has(session.id)
							) {
								descendants.add(session.id);
								changed = true;
							}
						}
						if (!changed) break;
					}
					const children = await Promise.all(
						nativeSessions
							.filter((session) => session.id !== native.id && descendants.has(String(session.id)))
							.slice(0, 256)
							.map(async (session) => ({
								session,
								messages: await request<unknown[]>(
									`/session/${encodeURIComponent(String(session.id))}/message`,
								),
							})),
					);
					const belongs = (item: unknown) =>
						descendants.has(String((item as { sessionID?: string })?.sessionID));
					const hasRunningTools = [messages, ...children.map((child) => child.messages)]
						.flat()
						.some(
							(value) =>
								Array.isArray((value as { parts?: unknown[] }).parts) &&
								(value as { parts: unknown[] }).parts.some((part) => {
									const p = part as { type?: string; state?: { status?: string } };
									return (
										p.type === "tool" && ["running", "pending"].includes(p.state?.status ?? "")
									);
								}),
						);
					// Snapshots OBSERVE descendants; they never add them to the
					// addressable set (only an authenticated fork result does).
					// A target is no longer executing once its native status is idle.
					for (const [id, claim] of [...executing]) {
						const current =
							id === native.id
								? messages
								: (children.find((child) => child.session.id === id)?.messages ?? []);
						const raw = status[id]?.type;
						const observation = {
							seq,
							status:
								raw === "busy" || raw === "retry"
									? ("busy" as const)
									: raw === undefined
										? ("missing" as const)
										: ("idle" as const),
							quiet:
								!permissions.some((item) => (item as { sessionID?: string }).sessionID === id) &&
								!questions.some((item) => (item as { sessionID?: string }).sessionID === id),
							turnTerminal: turnTerminal(current, claim.messageID),
							abortTerminal: abortTerminal(current, claim.messageID),
							runningTools: runningTools(current),
						};
						const outcome = observeClaim(claim.state, observation);
						claim.state = outcome.state;
						if (outcome.release) executing.delete(id);
					}
					const boundBusy = status[native.id]?.type === "busy" || status[native.id]?.type === "retry";
					const entry = this.instances.get(input.sessionId);
					if (entry) {
						// Instance entry tracks the BOUND session only; a busy CHILD
						// must not gate the parent (and vice versa).
						entry.busy = boundBusy;
						entry.pending = permissions.some(
							(item) => (item as { sessionID?: string }).sessionID === native.id,
						) || questions.some((item) => (item as { sessionID?: string }).sessionID === native.id);
						if (entry.busy || entry.pending) entry.lastUsed = Date.now();
					}
					return {
						messages,
						children,
						permissions: permissions.filter(belongs),
						questions: questions.filter(belongs),
						status: status[native.id] ?? { type: "idle" },
						sessions: status,
						commands,
						agents,
						providers,
					};
				},
			};
			writePrivateFileSyncNoFollow(
				join(directory, "manifest.json"),
				JSON.stringify({
					instanceId: input.instanceId,
					sessionId: input.sessionId,
					generation: input.generation,
					pid: child.pid,
					startTicks: await processStartTicks(child.pid),
					cwd,
					nativeSessionId: native.id,
					protocolVersion: health.version,
					startedAt: new Date().toISOString(),
				}),
			);
			void child.exited.then(() => {
				const current = this.instances.get(input.sessionId);
				if (current?.runtime.pid === child.pid) this.instances.delete(input.sessionId);
			});
			this.instances.set(input.sessionId, {
				runtime,
				lastUsed: Date.now(),
				busy: false,
				pending: false,
			});
			return runtime;
		} catch (error) {
			if (process && process.exitCode === null) {
				process.kill("SIGKILL");
				await process.exited;
			}
			if (directory) await rm(directory, { recursive: true, force: true });
			throw error;
		} finally {
			this.starting.delete(input.sessionId);
		}
	}
	async reapIdle(now = Date.now()) {
		const stopped: string[] = [];
		for (const [id, entry] of this.instances) {
			// Recheck pending and busy on the native server; failure is not proof of idleness.
			try {
				await entry.runtime.snapshot();
			} catch {
				continue;
			}
			if (!entry.busy && !entry.pending && now - entry.lastUsed >= this.config.idleTimeoutMs) {
				await entry.runtime.stop();
				stopped.push(id);
			}
		}
		return stopped;
	}
	async close() {
		await Promise.all([...this.instances.values()].map((entry) => entry.runtime.stop()));
	}
}

/** Tiny real model request: registry membership is not credential/model health. */
export async function checkOpenCodeProfileHealth(path: string): Promise<OpenCodeHealth> {
	let profile: OpenCodeProfile;
	try {
		profile = await readOpenCodeProfile(path);
	} catch {
		return "not_configured";
	}
	const [providerID, ...model] = profile.model.split("/");
	const options = profile.provider[providerID].options;
	try {
		const url = new URL("chat/completions", `${options.baseURL?.replace(/\/$/, "")}/`);
		const status = await new Promise<number>((resolve, reject) => {
			const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
				url,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${options.apiKey}`,
						"Content-Type": "application/json",
					},
				},
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 500);
				},
			);
			request.setTimeout(15000, () => request.destroy(new Error("timeout")));
			request.on("error", reject);
			request.end(
				JSON.stringify({
					model: model.join("/"),
					messages: [{ role: "user", content: "Reply OK" }],
					max_tokens: 1,
					stream: false,
				}),
			);
		});
		if (status === 401 || status === 403) return "authentication_failed";
		if (status === 404) return "model_unavailable";
		return status >= 200 && status < 300 ? "ready" : "unavailable";
	} catch {
		return "unavailable";
	}
}
