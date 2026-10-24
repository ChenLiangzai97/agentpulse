/**
 * Build the web bundle AND stamp it in ONE flow. The stamp is bound to the
 * bytes actually produced by this build (sha256 over every file under dist/web
 * except build.json), plus the commit, so an old bundle can never be re-labelled
 * by re-running the stamp alone.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = "dist/web";
const index = join(root, "index.html");
try {
	await stat(index);
} catch {
	throw new Error("dist/web/index.html missing — run this script to build, never stamp alone");
}
execSync("bunx vite build", { stdio: "inherit" });
const files: string[] = [];
const walk = async (dir: string) => {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) await walk(path);
		else if (!path.endsWith("build.json")) files.push(path);
	}
};
await walk(root);
files.sort();
const hash = createHash("sha256");
for (const file of files) hash.update(file).update("\0").update(await readFile(file)).update("\0");
const info = {
	commit: execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(),
	hash: hash.digest("hex"),
	files,
	builtAt: new Date().toISOString(),
};
await writeFile(join(root, "build.json"), `${JSON.stringify(info, null, 1)}\n`);
console.log(JSON.stringify({ commit: info.commit.slice(0, 7), hash: info.hash }));
