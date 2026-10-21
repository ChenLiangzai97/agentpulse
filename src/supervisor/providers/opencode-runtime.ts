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
		commands?: unknown[];
		agents?: unknown[];
		providers?: unknown;
	}>;
	touch(): void;
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
		try {
			const profile = await readOpenCodeProfile(this.config.profilePath);
			const cwd = await realpath(input.cwd);
			await mkdir(this.config.stateDirectory, { recursive: true, mode: 0o700 });
			directory = await mkdtemp(join(this.config.stateDirectory, "instance-"));
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
			// any live subtree member learned from snapshots. Anything else is an
			// explicit refusal — a bare id never grants execution.
			const knownSessions = new Set<string>([native.id]);
			const childBusy = new Set<string>();
			const pathFor = (target?: string): string => {
				if (!target || target === native.id) return nativePath;
				if (!knownSessions.has(target)) throw new Error("opencode_unknown_native_session");
				return `/session/${encodeURIComponent(target)}`;
			};
			const subscriptions = new Set<() => void>();
			const runtime: OpenCodeRuntime = {
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
					const target = options?.nativeSessionId;
					const targetPath = pathFor(target);
					const entry = this.instances.get(input.sessionId);
					if (!target || target === native.id) {
						if (!entry || entry.busy || entry.pending) throw new Error("opencode_session_busy");
					} else if (childBusy.has(target)) {
						throw new Error("opencode_session_busy");
					}
					childBusy.add(target ?? native.id);
					if (entry) entry.lastUsed = Date.now();
					// No explicit model: inherit the session's current one (a previous
					// explicit carry switches it natively and stickily per session).
					// Never retry an ambiguous transport failure: native messageID is not part-idempotent.
					try {
						await request(`${targetPath}/prompt_async`, {
							...(options?.model ? { model: options.model } : {}),
							...(options?.agent ? { agent: options.agent } : {}),
							parts: [{ type: "text", text }],
						});
					} catch (error) {
						throw new Error("opencode_prompt_delivery_uncertain", { cause: error });
					}
				},
				runCommand: async (command, args, options) => {
					// Native custom-command execution: the instance expands the command
					// template as a user message and runs it. TUI built-ins are NOT
					// valid here (verified: 1.18.35 answers UnknownError).
					if (!/^[a-zA-Z0-9_-]+$/.test(command)) throw new Error("opencode_invalid_command");
					await request(`${pathFor(options?.nativeSessionId)}/command`, {
						command,
						arguments: args ?? "",
						messageID: `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
						// /command's model field is the "provider/model" string form.
						...(options?.model
							? { model: `${options.model.providerID}/${options.model.modelID}` }
							: {}),
						...(options?.agent ? { agent: options.agent } : {}),
					});
					runtime.touch();
				},
				abort: async (nativeSessionId?: string) => {
					await request(`${pathFor(nativeSessionId)}/abort`, {});
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
					for (const id of descendants) knownSessions.add(id);
					// A child is no longer executing once its native status is idle.
					for (const id of [...childBusy]) {
						const st = status[id]?.type;
						if (st !== "busy" && st !== "retry") childBusy.delete(id);
					}
					const entry = this.instances.get(input.sessionId);
					if (entry) {
						entry.busy =
							hasRunningTools ||
							[...descendants].some(
								(id) => status[id]?.type === "busy" || status[id]?.type === "retry",
							);
						entry.pending = permissions.some(belongs) || questions.some(belongs);
						if (entry.busy || entry.pending) entry.lastUsed = Date.now();
					}
					return {
						messages,
						children,
						permissions: permissions.filter(belongs),
						questions: questions.filter(belongs),
						status:
							hasRunningTools ||
							[...descendants].some(
								(id) => status[id]?.type === "busy" || status[id]?.type === "retry",
							)
								? { type: "busy" }
								: (status[native.id] ?? { type: "idle" }),
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
