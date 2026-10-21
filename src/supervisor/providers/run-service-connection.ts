/**
 * Protected run-service state + connection adapter (P2).
 *
 * - The manifest and token live in a service-owned directory: the caller passes
 *   only the ROOT and the instance id; paths cannot be supplied by the action.
 * - Files must be private (no group/other bits) and owned by this uid.
 * - The adapter talks to loopback ONLY, never follows redirects (so credentials
 *   cannot be forwarded elsewhere) and always has a timeout.
 */
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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

const privateFile = async (path: string) => {
	const info = await stat(path);
	if (info.uid !== process.getuid?.()) throw new Error("run_service_not_owner");
	if ((info.mode & 0o077) !== 0) throw new Error("run_service_not_private");
};

export function createRunServiceStore(root: string) {
	const dir = (instanceId: string) => runServiceDirectory(root, instanceId);
	return {
		async ensure(instanceId: string) {
			const directory = dir(instanceId);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await chmod(directory, 0o700);
			return directory;
		},
		/** Written by the service itself (atomic, 0600). */
		async write(instanceId: string, manifest: RunServiceManifest, token: string) {
			const directory = await this.ensure(instanceId);
			const tokenPath = join(directory, "token");
			const manifestPath = join(directory, "manifest.json");
			await writeFile(`${tokenPath}.tmp`, token, { mode: 0o600 });
			await rename(`${tokenPath}.tmp`, tokenPath);
			await writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest), { mode: 0o600 });
			await rename(`${manifestPath}.tmp`, manifestPath);
		},
		async readManifest(instanceId: string): Promise<RunServiceManifest> {
			const path = join(dir(instanceId), "manifest.json");
			await privateFile(path);
			return JSON.parse(await readFile(path, "utf8")) as RunServiceManifest;
		},
		async readToken(instanceId: string): Promise<string> {
			const path = join(dir(instanceId), "token");
			await privateFile(path);
			return (await readFile(path, "utf8")).trim();
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
	return new Promise((resolvePromise, reject) => {
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
				let text = "";
				response.on("data", (chunk) => {
					text += chunk;
				});
				response.on("end", () => {
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
		req.on("error", reject);
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
