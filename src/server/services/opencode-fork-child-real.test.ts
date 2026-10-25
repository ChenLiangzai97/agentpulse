/**
 * REAL managed fork-child ingestion chain: the supervisor provider enumerates
 * the server's TRUSTED committed child bindings and polls each child native id;
 * the server ingests that child's own snapshot into its own AgentPulse session.
 *
 * Opt-in: needs the real OpenCode 1.18.35 CLI and the deterministic loopback
 * model fixture. Set AGENTPULSE_OPENCODE_RUNTIME_TEST=1.
 */
import "../db/__test_db.js";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const db = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { claimNextControlAction, updateControlAction } = await import("./control-actions.js");
const { reserveOpenCodeInstance } = await import("./opencode-control-provenance.js");
const { queueOpenCodeAction } = await import("./opencode-managed.js");
const { loadCopiedEvents } = await import("./worklog-copy.js");
const { upsertManagedSessionState } = await import("./managed-session-state.js");
const { mapLaunchRequest } = await import("./launch-validator.js");
const { createManagedOpenCodeProvider } = await import(
	"../../supervisor/providers/opencode-managed.js"
);

const HOST = "fork-child-real-host";
const admin = { label: "user", userId: null, role: "admin", mode: "solo" } as const;
const originalDisableAuth = config.disableAuth;
const originalEntry = config.opencodeForkEntry;

const request = async (path: string, options?: RequestInit) => {
	const response = await app.request(`/api/v1${path}`, options);
	if (!response.ok)
		throw Object.assign(new Error(`real_http_${response.status}`), {
			status: response.status,
		});
	return response.json();
};

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = true;
	(config as Record<string, unknown>).opencodeForkEntry = true;
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	(config as Record<string, unknown>).opencodeForkEntry = originalEntry;
});

test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"provider polls trusted children: inheritance, causality, isolation, multi-branch, parent deletion, STOP",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ap-fork-child-real-"));
		const cwd = join(root, "project");
		await mkdir(cwd);
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("mock exited");
			line += new TextDecoder().decode(next.value);
		}
		const port = Number(line.trim());
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "p0-fixture-key" },
						models: {
							"fixture-model": {
								name: "Fixture",
								tool_call: true,
								limit: { context: 32768, output: 2048 },
							},
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		await getDb()
			.insert(db.supervisors)
			.values({
				id: HOST,
				hostName: HOST,
				platform: "linux",
				arch: "x64",
				version: "t",
				status: "connected",
				trustedRoots: [root],
				capabilities: {},
			});
		const parentId = "fork-child-real-parent";
		const [launch] = await getDb()
			.insert(db.launchRequests)
			.values({
				launchCorrelationId: parentId,
				agentType: "opencode",
				cwd,
				requestedLaunchMode: "managed_opencode",
				claimedBySupervisorId: HOST,
				status: "launching",
				taskPrompt: "P0_HELLO PARENTSTART",
				desiredDisplayName: "fork child real",
			})
			.returning();
		const instance = await reserveOpenCodeInstance(HOST, launch.id);
		const provider = createManagedOpenCodeProvider(
			{
				id: HOST,
				serverUrl: "http://localhost",
				hostName: HOST,
				platform: "linux",
				arch: "x64",
				version: "test",
				trustedRoots: [root],
				opencodeProfilePath: profilePath,
				capabilities: {
					version: 1,
					agentTypes: ["opencode"],
					launchModes: ["managed_opencode"],
					os: "linux",
					terminalSupport: [],
					features: ["managed_opencode"],
					executables: {
						opencode: {
							available: true,
							command: "opencode",
							resolvedPath: process.env.AGENTPULSE_OPENCODE_COMMAND ?? "opencode",
							source: "config",
						},
					},
				},
			},
			root,
			{
				request,
				verdict: () => "send",
				reportForkResult: async (actionId, body) => {
					await request(`/supervisors/${HOST}/control-actions/${actionId}/fork-result`, {
						method: "POST",
						body: JSON.stringify(body),
					});
				},
				listTrustedForkChildren: async (instanceId, generation) => {
					const result = (await request(
						`/supervisors/${HOST}/opencode/${instanceId}/children?generation=${generation}`,
					)) as { children?: { sessionId: string; nativeSessionId: string }[] };
					return result.children ?? [];
				},
			},
		);

		const eventsFor = async (sessionId: string) =>
			getDb().select().from(db.events).where(eq(db.events.sessionId, sessionId));
		const sessionRow = async (sessionId: string) =>
			(await getDb().select().from(db.sessions).where(eq(db.sessions.sessionId, sessionId)))[0];
		const waitFor = async (check: () => Promise<boolean>, timeoutMs = 45_000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				await provider.poll();
				if (await check()) return true;
				await Bun.sleep(200);
			}
			return false;
		};
		const waitPrompt = async (sessionId: string, marker: string) => {
			const ok = await waitFor(async () =>
				(await eventsFor(sessionId)).some(
					(row) => row.content === marker && row.eventType === "UserPromptSubmit",
				),
			);
			expect(ok).toBe(true);
			const okTerminal = await waitFor(async () => {
				const rows = await eventsFor(sessionId);
				const prompt = rows.find((row) => row.content === marker);
				if (!prompt) return false;
				return rows.some(
					(row) =>
						row.id > prompt.id && row.eventType === "AssistantMessage" && row.content === "P0_DONE",
				);
			});
			expect(okTerminal).toBe(true);
		};
		const runAction = async (
			sessionId: string,
			kind: "prompt" | "stop" | "opencode_fork",
			body: Record<string, unknown>,
		) => {
			const queued = await queueOpenCodeAction(sessionId, kind, body, admin);
			const claimed = await claimNextControlAction(HOST);
			expect(claimed?.id).toBe(queued.id);
			if (!claimed) throw new Error("no claimed action");
			await provider.control(claimed);
			const claimToken = String((claimed.metadata as Record<string, unknown>)?.claimToken ?? "");
			await updateControlAction({
				actionId: claimed.id,
				supervisorId: HOST,
				status: "succeeded",
				claimToken,
			});
			return claimed;
		};

		try {
			await provider.launch(
				{
					...mapLaunchRequest(launch),
					openCodeInstance: { id: instance.id, generation: instance.generation },
				},
				{
					reportState: (body) => upsertManagedSessionState(HOST, body),
					reportEvents: async () => {
						throw new Error("unfenced event path");
					},
				},
			);
			await waitPrompt(parentId, "P0_HELLO PARENTSTART");
			const parentNative = (await sessionRow(parentId))?.metadata as {
				opencode?: { nativeSessionId?: string };
			};
			const parentNativeId = String(parentNative?.opencode?.nativeSessionId ?? "");
			expect(parentNativeId.startsWith("ses_")).toBe(true);

			const tag = crypto.randomUUID().slice(0, 8);
			const srcMarker = `CHILD-INHERIT-${tag}`;
			await runAction(parentId, "prompt", { prompt: `P0_HELLO ${srcMarker}` });
			await waitPrompt(parentId, `P0_HELLO ${srcMarker}`);

			// ── branch A ────────────────────────────────────────────────────
			await runAction(parentId, "opencode_fork", {
				idempotencyKey: `real-a-${tag}`,
				childDisplayName: "branch A",
			});
			const childA = (
				await getDb()
					.select()
					.from(db.opencodeForks)
					.where(eq(db.opencodeForks.parentSessionId, parentId))
			)[0];
			expect(childA?.childSessionId).toBeTruthy();
			const childAId = childA?.childSessionId ?? "";
			// Inherited history must arrive through the CHILD's own timeline.
			const inherited = await waitFor(async () =>
				(await eventsFor(childAId)).some((row) => row.content === `P0_HELLO ${srcMarker}`),
			);
			expect(inherited).toBe(true);
			const [parentSource] = (await eventsFor(parentId)).filter(
				(row) => row.content === `P0_HELLO ${srcMarker}`,
			);
			const inheritedRow = (await eventsFor(childAId)).find(
				(row) => row.content === `P0_HELLO ${srcMarker}`,
			);
			// COPIED prefix: original parent event anchor + original occurrence time.
			const copies = await loadCopiedEvents(childAId);
			expect(copies.get(inheritedRow?.id ?? -1)?.copyOf).toBe(`${parentId}:${parentSource?.id}`);
			expect(inheritedRow?.createdAt).toBe(parentSource?.createdAt);

			// Child's new turn terminates in the child only (causal parent link).
			const childTurn = `CHILD-TURN-${tag}`;
			await runAction(childAId, "prompt", { prompt: `P0_HELLO ${childTurn}` });
			await waitPrompt(childAId, `P0_HELLO ${childTurn}`);
			const childRowsAfter = await eventsFor(childAId);
			const childPrompt = childRowsAfter.find((row) => row.content === `P0_HELLO ${childTurn}`);
			const childDone = childRowsAfter.find(
				(row) =>
					row.id > (childPrompt?.id ?? 0) &&
					row.eventType === "AssistantMessage" &&
					row.content === "P0_DONE",
			);
			expect((childDone?.rawPayload as { parent_id?: unknown } | undefined)?.parent_id).toBe(
				(childPrompt?.rawPayload as { message_id?: unknown } | undefined)?.message_id,
			);
			const childSessionAfter = await sessionRow(childAId);
			expect(childSessionAfter?.isWorking).toBe(false);
			expect(childSessionAfter?.lastAgentTurnCompletedAt).toBeTruthy();
			expect(
				(await eventsFor(parentId)).some((row) => row.content === `P0_HELLO ${childTurn}`),
			).toBe(false);

			// Parent's post-fork turn never enters the child.
			const parentPost = `PARENT-POST-${tag}`;
			await runAction(parentId, "prompt", { prompt: `P0_HELLO ${parentPost}` });
			await waitPrompt(parentId, `P0_HELLO ${parentPost}`);
			expect(
				(await eventsFor(childAId)).some((row) => row.content === `P0_HELLO ${parentPost}`),
			).toBe(false);

			// ── branch B: multi-branch isolation ────────────────────────────
			await runAction(parentId, "opencode_fork", {
				idempotencyKey: `real-b-${tag}`,
				childDisplayName: "branch B",
			});
			const forks = await getDb()
				.select()
				.from(db.opencodeForks)
				.where(eq(db.opencodeForks.parentSessionId, parentId));
			expect(forks).toHaveLength(2);
			const childB = forks.find((row) => row.childSessionId !== childAId);
			const childBId = childB?.childSessionId ?? "";
			const bInherited = await waitFor(async () =>
				(await eventsFor(childBId)).some((row) => row.content === `P0_HELLO ${srcMarker}`),
			);
			expect(bInherited).toBe(true);
			const bTurn = `B-TURN-${tag}`;
			await runAction(childBId, "prompt", { prompt: `P0_HELLO ${bTurn}` });
			await waitPrompt(childBId, `P0_HELLO ${bTurn}`);
			expect((await eventsFor(childAId)).some((row) => row.content === `P0_HELLO ${bTurn}`)).toBe(
				false,
			);

			// Duplicate snapshots are idempotent.
			await provider.poll();
			const aCount = (await eventsFor(childAId)).length;
			const bCount = (await eventsFor(childBId)).length;
			await provider.poll();
			await provider.poll();
			expect((await eventsFor(childAId)).length).toBe(aCount);
			expect((await eventsFor(childBId)).length).toBe(bCount);

			// ── child STOP: success + protected stopped, parent identity kept ──
			const parentBindingBefore = (
				await getDb()
					.select()
					.from(db.sessionControlBindings)
					.where(eq(db.sessionControlBindings.sessionId, parentId))
			)[0];
			await runAction(childAId, "stop", {});
			const [childABinding, parentBindingAfter] = await Promise.all([
				getDb()
					.select()
					.from(db.sessionControlBindings)
					.where(eq(db.sessionControlBindings.sessionId, childAId))
					.then((rows) => rows[0]),
				getDb()
					.select()
					.from(db.sessionControlBindings)
					.where(eq(db.sessionControlBindings.sessionId, parentId))
					.then((rows) => rows[0]),
			]);
			expect(childABinding?.stopState).toBe("stopped");
			expect(parentBindingAfter?.nativeSessionId).toBe(parentBindingBefore?.nativeSessionId);
			expect(parentBindingAfter?.stopState).toBe("active");
			// The parent keeps working after the child stop.
			const afterStop = `AFTER-STOP-${tag}`;
			await runAction(parentId, "prompt", { prompt: `P0_HELLO ${afterStop}` });
			await waitPrompt(parentId, `P0_HELLO ${afterStop}`);

			// ── parent deletion: child B ingestion continues ───────────────
			await getDb().delete(db.sessions).where(eq(db.sessions.sessionId, parentId));
			expect(await sessionRow(parentId)).toBeUndefined();
			const afterGone = `AFTER-PARENT-GONE-${tag}`;
			await runAction(childBId, "prompt", { prompt: `P0_HELLO ${afterGone}` });
			await waitPrompt(childBId, `P0_HELLO ${afterGone}`);
			const childBEvents = await eventsFor(childBId);
			expect(childBEvents.some((row) => row.content === `P0_HELLO ${afterGone}`)).toBe(true);
			// No other child received the parent-deleted turn.
			expect(
				(await eventsFor(childAId)).some((row) => row.content === `P0_HELLO ${afterGone}`),
			).toBe(false);

			// The server's trusted enumeration is still exactly the live branches.
			const [instanceAfter] = await getDb()
				.select()
				.from(db.providerInstances)
				.where(eq(db.providerInstances.id, instance.id));
			const listed = (await request(
				`/supervisors/${HOST}/opencode/${instance.id}/children?generation=${instanceAfter?.generation}`,
			)) as { children: { sessionId: string }[] };
			expect(listed.children.map((child) => child.sessionId).sort()).toEqual(
				[childAId, childBId].sort(),
			);
		} finally {
			await provider.close().catch(() => {});
			mock.kill();
			await mock.exited.catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	},
	300_000,
);
