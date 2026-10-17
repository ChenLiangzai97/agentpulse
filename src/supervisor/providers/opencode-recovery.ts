/** Restart recovery reads only AgentPulse-owned instance directories, never the default OpenCode DB. */
import { Database } from "bun:sqlite";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFileSyncNoFollow } from "../../shared/private-file.js";

export async function processStartTicks(pid: number) {
	try {
		const value = await readFile(`/proc/${pid}/stat`, "utf8");
		return value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return null;
	}
}
/** pidfd prevents a recycled PID being signalled between validation and termination. */
export async function stopRecordedOpenCodeProcess(
	directory: string,
	manifest: { pid: number; startTicks?: string | null; cwd: string },
) {
	if (process.platform !== "linux")
		throw new Error("opencode_recovery_requires_manual_process_check");
	const script = `import os,sys,json,signal,time\nfrom pathlib import Path\ndirectory=Path(sys.argv[1]).resolve();m=json.loads(sys.argv[2]);pid=m['pid']\ntry: fd=os.pidfd_open(pid)\nexcept ProcessLookupError: sys.exit(0)\ntry:\n p=Path('/proc')/str(pid)\n stat=p.joinpath('stat').read_text();ticks=stat[stat.rfind(')')+2:].split()[19]\n if not m.get('startTicks') or ticks!=m['startTicks']:sys.exit(3)\n if p.joinpath('cwd').resolve()!=Path(m['cwd']).resolve():sys.exit(3)\n cmd=p.joinpath('cmdline').read_bytes().split(b'\\0')\n env=p.joinpath('environ').read_bytes().split(b'\\0')\n if b'--pure' not in cmd or b'serve' not in cmd or ('OPENCODE_CONFIG='+str(directory/'provider.json')).encode() not in env:sys.exit(3)\n signal.pidfd_send_signal(fd,signal.SIGTERM)\n time.sleep(1)\n try:signal.pidfd_send_signal(fd,signal.SIGKILL)\n except ProcessLookupError:pass\nfinally:os.close(fd)\n`;
	const child = Bun.spawn(["/usr/bin/python3", "-c", script, directory, JSON.stringify(manifest)], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if ((await child.exited) !== 0) throw new Error("opencode_process_identity_unverified");
}
export function readOwnedOpenCodeHistory(directory: string, nativeSessionId: string) {
	const db = new Database(join(directory, "xdg_data_home", "opencode", "opencode.db"), {
		readonly: true,
	});
	try {
		const messages = db
			.query("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id")
			.all(nativeSessionId) as { id: string; data: string }[];
		const parts = db
			.query("SELECT id,message_id,data FROM part WHERE session_id=? ORDER BY time_created,id")
			.all(nativeSessionId) as { id: string; message_id: string; data: string }[];
		return messages.map((message) => ({
			info: { ...JSON.parse(message.data), id: message.id, sessionID: nativeSessionId },
			parts: parts
				.filter((p) => p.message_id === message.id)
				.map((p) => ({
					...JSON.parse(p.data),
					id: p.id,
					sessionID: nativeSessionId,
					messageID: p.message_id,
				})),
		}));
	} finally {
		db.close();
	}
}
export async function recoverOpenCodeHistory(
	stateDirectory: string,
	send: (
		instanceId: string,
		path: "snapshot" | "closed",
		body: unknown,
		context: { sessionId: string; cwd: string },
	) => Promise<unknown>,
) {
	let directories: string[];
	try {
		directories = await readdir(stateDirectory);
	} catch {
		return;
	}
	for (const name of directories) {
		if (!/^instance-[A-Za-z0-9_-]+$/.test(name)) continue;
		const directory = join(stateDirectory, name);
		if (await Bun.file(join(directory, "reconciled.json")).exists()) continue;
		let manifest: {
			instanceId: string;
			sessionId: string;
			generation: number;
			nativeSessionId: string;
			pid: number;
			startTicks?: string;
			cwd: string;
		};
		try {
			manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
		} catch {
			continue;
		}
		if (!manifest.instanceId || !manifest.nativeSessionId || !Number.isInteger(manifest.generation))
			continue;
		let closure: { generation: number; state: "stopped" | "interrupted" };
		try {
			closure = JSON.parse(await readFile(join(directory, "closed.json"), "utf8"));
		} catch {
			await stopRecordedOpenCodeProcess(directory, manifest);
			closure = { generation: manifest.generation, state: "interrupted" };
			writePrivateFileSyncNoFollow(join(directory, "closed.json"), JSON.stringify(closure));
		}
		let messages: unknown[] = [];
		try {
			messages = readOwnedOpenCodeHistory(directory, manifest.nativeSessionId);
		} catch {}
		// A closed-generation snapshot can be refused: closing is idempotent and remains mandatory.
		try {
			await send(
				manifest.instanceId,
				"snapshot",
				{
					generation: manifest.generation,
					nativeSessionId: manifest.nativeSessionId,
					messages,
					children: readOwnedOpenCodeChildren(directory, manifest.nativeSessionId, manifest.cwd),
					permissions: [],
					questions: [],
					status: { type: "interrupted" },
				},
				manifest,
			);
		} catch (error) {
			const status = (error as { status?: number })?.status;
			if (status !== 403 && status !== 409) throw error;
		}
		await send(manifest.instanceId, "closed", closure, manifest);
		await rm(join(directory, "provider.json"), { force: true });
		writePrivateFileSyncNoFollow(
			join(directory, "reconciled.json"),
			JSON.stringify({ at: new Date().toISOString(), state: closure.state }),
		);
	}
}

export function readOwnedOpenCodeChildren(directory: string, rootId: string, cwd: string) {
	const db = new Database(join(directory, "xdg_data_home", "opencode", "opencode.db"), {
		readonly: true,
	});
	let rows: { id: string; title: string; directory: string; parent_id: string | null }[];
	try {
		rows = db.query("SELECT id,title,directory,parent_id FROM session").all() as typeof rows;
	} finally {
		db.close();
	}
	const allowed = new Set([rootId]);
	const children: { session: Record<string, unknown>; messages: unknown[] }[] = [];
	for (let depth = 0; depth < 64; depth++) {
		let changed = false;
		for (const row of rows) {
			if (
				row.directory === cwd &&
				row.parent_id &&
				allowed.has(row.parent_id) &&
				!allowed.has(row.id)
			) {
				allowed.add(row.id);
				children.push({
					session: {
						id: row.id,
						title: row.title,
						directory: row.directory,
						parentID: row.parent_id,
					},
					messages: readOwnedOpenCodeHistory(directory, row.id),
				});
				changed = true;
			}
		}
		if (!changed) break;
	}
	return children.slice(0, 256);
}

let recoverySupport: Promise<boolean> | undefined;
export function supportsOpenCodeRecovery() {
	return (recoverySupport ??= (async () => {
		if (process.platform !== "linux") return false;
		try {
			const process = Bun.spawn(
				[
					"/usr/bin/python3",
					"-c",
					"import os,signal;assert hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal')",
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
			return (await process.exited) === 0;
		} catch {
			return false;
		}
	})());
}
