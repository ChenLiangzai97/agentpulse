/**
 * Protected run-service state + connection adapter (P2).
 *
 * - The manifest and token live in a service-owned directory: the caller passes
 *   only the ROOT and the instance id; paths cannot be supplied by the action.
 * - Files must be private (no group/other bits) and owned by this uid.
 * - The adapter talks to loopback ONLY, never follows redirects (so credentials
 *   cannot be forwarded elsewhere) and always has a timeout.
 */
import { chmod, lstat, mkdir, open, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { processStartTicks } from "./opencode-recovery.js";
import {
	type ResolveFailure,
	type RunServiceManifest,
	resolveRunService,
} from "./run-service-resolver.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;

export const runServiceDirectory = (root: string, instanceId: string) => {
	if (!SAFE_ID.test(instanceId)) throw new Error("run_service_invalid_instance");
	const base = resolve(root);
	const directory = resolve(base, "instances", instanceId);
	if (!directory.startsWith(`${base}/`)) throw new Error("run_service_path_escape");
	return directory;
};

const requirePrivate = (info: {
	uid: number;
	mode: number;
	isSymbolicLink?: () => boolean;
	isDirectory?: () => boolean;
	isFile?: () => boolean;
}, kind: "dir" | "file") => {
	if (info.isSymbolicLink?.()) throw new Error("run_service_symlink_refused");
	if (kind === "dir" && info.isDirectory && !info.isDirectory())
		throw new Error("run_service_not_directory");
	if (kind === "file" && info.isFile && !info.isFile()) throw new Error("run_service_not_file");
	if (info.uid !== process.getuid?.()) throw new Error("run_service_not_owner");
	if ((info.mode & 0o077) !== 0) throw new Error("run_service_not_private");
};

/**
 * Read through a FILE HANDLE: O_NOFOLLOW refuses a symlink at open time and the
 * handle must be the SAME inode/device we lstat'ed (a mid-flight replacement is
 * refused). Directory-chain validation happens in the caller before this.
 */
const readPrivateFile = async (path: string): Promise<string> => {
	const before = await lstat(path);
	requirePrivate(before, "file");
	const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const after = await handle.stat();
		if (!after.isFile() || after.uid !== process.getuid?.() || (after.mode & 0o077) !== 0)
			throw new Error("run_service_not_private");
		if (before.dev !== after.dev || before.ino !== after.ino)
			throw new Error("run_service_file_replaced");
		return await handle.readFile({ encoding: "utf8" });
	} finally {
		await handle.close();
	}
};

export function createRunServiceStore(root: string) {
	const dir = (instanceId: string) => runServiceDirectory(root, instanceId);
	const assertChain = async (instanceId: string) => {
		const base = resolve(root);
		for (const path of [base, join(base, "instances"), dir(instanceId)]) {
			requirePrivate(await lstat(path), "dir");
		}
	};
	return {
		async ensure(instanceId: string) {
			const base = resolve(root);
			const directory = dir(instanceId);
			// The whole state chain must be owned/private and free of symlinks.
			for (const path of [base, join(base, "instances"), directory]) {
				await mkdir(path, { recursive: true, mode: 0o700 });
				requirePrivate(await lstat(path), "dir");
				await chmod(path, 0o700);
			}
			return directory;
		},
		/** Written by the service itself (atomic, 0600). */
		async write(instanceId: string, manifest: RunServiceManifest, token: string) {
			const directory = await this.ensure(instanceId);
			const tokenPath = join(directory, "token");
			const manifestPath = join(directory, "manifest.json");
			// Unique temp names with EXCLUSIVE create (never follow/clobber).
			const writeExclusive = async (target: string, body: string) => {
				const temp = `${target}.tmp-${crypto.randomUUID()}`;
				const handle = await open(temp, "wx", 0o600);
				try {
					await handle.writeFile(body);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temp, target);
			};
			await writeExclusive(tokenPath, token);
			await writeExclusive(manifestPath, JSON.stringify(manifest));
		},
		async readManifest(instanceId: string): Promise<RunServiceManifest> {
			await assertChain(instanceId);
			return JSON.parse(await readPrivateFile(join(dir(instanceId), "manifest.json"))) as RunServiceManifest;
		},
		async readToken(instanceId: string): Promise<string> {
			await assertChain(instanceId);
			return (await readPrivateFile(join(dir(instanceId), "token"))).trim();
		},
	};
}

/** Loopback, Basic auth, NO redirect following, bounded timeout. */
export async function fetchRunServiceIdentity(
	url: string,
	token: string,
	options: { timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
	const target = new URL(url);
	if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
		throw new Error("run_service_not_loopback");
	if (target.username || target.password) throw new Error("run_service_url_credentials");
	const timeoutMs = options.timeoutMs ?? 5000;
	const MAX_BODY = 64 * 1024;
	return new Promise((resolvePromise, reject) => {
		// req.setTimeout is an IDLE timeout; the absolute deadline is what a slow
		// drip cannot extend.
		let responseRef: { destroy: (error?: Error) => void } | null = null;
		const deadline = setTimeout(() => {
			// Actively terminate the connection: a drip must not keep it alive.
			responseRef?.destroy(new Error("run_service_timeout"));
			req.destroy(new Error("run_service_timeout"));
			reject(new Error("run_service_timeout"));
		}, timeoutMs);
		deadline.unref?.();
		const req = httpRequest(
			{
				host: target.hostname,
				port: target.port,
				path: "/identity",
				method: "GET",
				headers: {
					Authorization: `Basic ${Buffer.from(`agentpulse:${token}`).toString("base64")}`,
				},
			},
			(response) => {
				responseRef = response;
				let text = "";
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_BODY) {
						response.destroy(new Error("run_service_body_too_large"));
						return;
					}
					text += chunk;
				});
				response.on("error", (error) => {
					clearTimeout(deadline);
					reject(error);
				});
				response.on("aborted", () => {
					clearTimeout(deadline);
					reject(new Error("run_service_aborted"));
				});
				response.on("end", () => {
					clearTimeout(deadline);
					// A redirect is REFUSED: credentials are never replayed elsewhere.
					if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
						reject(new Error("run_service_redirect_refused"));
						return;
					}
					let body: unknown = null;
					try {
						body = JSON.parse(text || "null");
					} catch {
						body = null;
					}
					resolvePromise({ status: response.statusCode ?? 0, body });
				});
			},
		);
		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error("run_service_timeout"));
		});
		req.on("error", (error) => {
			clearTimeout(deadline);
			reject(error);
		});
		req.end();
	});
}

export async function connectRunService(
	root: string,
	instanceId: string,
	expected: { instanceId: string; generation: number; nativeSessionId: string },
	options: { timeoutMs?: number } = {},
): Promise<
	| { ok: true; identity: Record<string, unknown> }
	| { ok: false; reason: ResolveFailure | "store_unreadable" }
> {
	const store = createRunServiceStore(root);
	let manifest: RunServiceManifest;
	try {
		manifest = await store.readManifest(instanceId);
	} catch {
		return { ok: false, reason: "store_unreadable" };
	}
	return resolveRunService(manifest, expected, {
		startTicks: (pid) => processStartTicks(pid),
		readToken: () => store.readToken(instanceId),
		fetchIdentity: (url, token) => fetchRunServiceIdentity(url, token, options),
	});
}
