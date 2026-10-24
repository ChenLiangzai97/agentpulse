/** Stamp dist/web with the commit it was built from (prevents stale-bundle evidence). */
import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const info = { commit, short: commit.slice(0, 7), builtAt: new Date().toISOString() };
await writeFile(join("dist", "web", "build.json"), `${JSON.stringify(info, null, 1)}\n`);
console.log(JSON.stringify(info));
