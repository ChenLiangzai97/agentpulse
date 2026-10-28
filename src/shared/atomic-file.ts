/**
 * Private atomic file write used by supervisor-side durable records (fork
 * ledger, claim records): write a mode-0600 temp file, fsync it, rename over
 * the target and fsync the directory entry. Absolute power-loss safety is NOT
 * claimed — no power-cut experiment has been run — but a crash cannot leave a
 * torn or partially written record.
 */
import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";

export async function writePrivateFileAtomic(
	path: string,
	content: string,
	options: { mode?: number } = {},
): Promise<void> {
	const mode = options.mode ?? 0o600;
	const temp = `${path}.tmp-${crypto.randomUUID()}`;
	const handle = await open(temp, "w", mode);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, path);
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
