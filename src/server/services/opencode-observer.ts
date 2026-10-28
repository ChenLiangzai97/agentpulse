/** Read-only OpenCode v1 SQLite observer. Never loads or changes OpenCode plugins. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { events, providerInstances, sessionControlBindings, sessions } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { toSessionEventDtos } from "./event-dto.js";
import type { NormalizedEvent } from "./event-normalizer.js";
import { notifySessionCreated, notifySessionEvents, notifySessionUpdated } from "./notifier.js";
import { recordExternalOpenCodeSession } from "./opencode-control-provenance.js";
import { getCachedProjects } from "./projects/cache.js";
import { resolveProjectIdForCwd } from "./projects/resolver.js";

type Json = Record<string, unknown>;
interface SourceSession {
	id: string;
	title: string;
	directory: string;
	parent_id: string | null;
	agent?: string;
	model?: string;
	time_created: number;
	time_updated: number;
	time_archived?: number | null;
	cost?: number;
	tokens_input?: number;
	tokens_output?: number;
	tokens_reasoning?: number;
	tokens_cache_read?: number;
	tokens_cache_write?: number;
}
interface SourceMessage {
	id: string;
	session_id: string;
	data: string;
	time_created: number;
	time_updated: number;
}
interface SourcePart extends SourceMessage {
	message_id: string;
}
interface Snapshot {
	session: SourceSession;
	messages: SourceMessage[];
	parts: SourcePart[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Json =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const parse = (value: string): Json => object(JSON.parse(value));
const date = (value: number) => new Date(value).toISOString().slice(0, 19).replace("T", " ");
const text = (value: unknown): string | null =>
	value == null ? null : typeof value === "string" ? value : JSON.stringify(value);

/** Keep BotMux's hidden routing context out of timeline/search/AI content. */
export function cleanOpenCodeText(value: string): string {
	let cleaned = value;
	for (const tag of [
		"botmux_routing",
		"botmux_builtin_skills",
		"botmux_reminder",
		"identity",
		"session_id",
		"role",
		"sender",
		"mentions",
		"available_bots",
		"attachments",
		"environment_context",
	]) {
		cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
	}
	return cleaned.replace(/<\/?user_message\b[^>]*>/gi, "").trim();
}

export function normalizeOpenCodePart(
	part: SourcePart,
	message: SourceMessage,
): NormalizedEvent | null {
	const data = parse(part.data);
	const info = parse(message.data);
	const state = object(data.state);
	const base: NormalizedEvent = {
		eventType: "OpenCodePart",
		category: "system_event",
		source: "observed_transcript",
		content: null,
		isNoise: false,
		providerEventType: `opencode.${data.type}`,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {
			native_session_id: part.session_id,
			message_id: message.id,
			// Preserved so a turn can be correlated CAUSALLY (assistant.parentID
			// === the user message id); normalized parts otherwise lose it.
			parent_id: typeof info.parentID === "string" ? info.parentID : null,
			part_id: part.id,
			source_updated_at: Math.max(part.time_updated, message.time_updated),
			tool_use_id: data.callID,
			role: info.role,
			call_id: data.callID,
			status: state.status,
			source_data: data,
		},
	};
	if (data.type === "text") {
		base.content = cleanOpenCodeText(String(data.text ?? ""));
		base.category = info.role === "user" ? "prompt" : "assistant_message";
		base.eventType = info.role === "user" ? "UserPromptSubmit" : "AssistantMessage";
		if (!base.content) return null;
	} else if (data.type === "tool") {
		base.eventType =
			state.status === "error"
				? "PostToolUseFailure"
				: state.status === "completed"
					? "PostToolUse"
					: "PreToolUse";
		base.category = "tool_event";
		base.toolName = String(data.tool ?? "unknown");
		base.toolInput = object(state.input);
		base.toolResponse = text(state.output ?? state.error);
		base.content = base.toolName;
	} else if (data.type === "step-finish") {
		base.eventType = "OpenCodeStepFinish";
		base.content = text({ tokens: data.tokens, cost: data.cost, reason: data.reason });
		base.isNoise = true;
	} else return null;
	base.rawPayload.observer_fingerprint = hash(JSON.stringify(base.rawPayload));
	return base;
}

export function defaultOpenCodeDbPath(): string {
	return join(
		process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
		"opencode",
		"opencode.db",
	);
}

export class OpenCodeObserver {
	private source: Database;
	private watermark = 0;
	readonly instanceId: string;
	/** Source host identity — the observer-skip scope is (thisHost, nativeId),
	 * never a bare native id across sources (fork design §A4). */
	readonly sourceHost: string;
	constructor(
		path: string,
		instanceId = `${hostname()}:${resolve(path)}`,
		sourceHost = hostname(),
	) {
		this.instanceId = hash(instanceId).slice(0, 20);
		this.sourceHost = sourceHost;
		this.source = new Database(path, { readonly: true, create: false });
		try {
			for (const [table, required] of Object.entries({
				session: ["id", "title", "directory", "parent_id", "time_created", "time_updated"],
				message: ["id", "session_id", "data", "time_created", "time_updated"],
				part: ["id", "session_id", "message_id", "data", "time_created", "time_updated"],
			})) {
				const statement = this.source.query(`PRAGMA table_info("${table}")`);
				const columns = statement.all() as { name: string }[];
				if (!required.every((key) => columns.some((column) => column.name === key)))
					throw new Error(`Unsupported OpenCode schema: ${table}`);
			}
		} catch (error) {
			this.source.close();
			throw error;
		}
	}
	sessionId(nativeId: string): string {
		return `opencode:${this.instanceId}:${nativeId}`;
	}
	close() {
		this.source.close();
	}

	async sync(): Promise<{ sessions: number; changedEvents: number }> {
		// A short source snapshot ends BEFORE any asynchronous destination writes.
		// Inclusive watermark handles equal millisecond timestamps; durable upserts handle replay.
		const read = this.source.transaction(() => {
			const ids = this.source
				.query(`SELECT id FROM session WHERE time_updated >= ?
    UNION SELECT session_id AS id FROM message WHERE time_updated >= ?
    UNION SELECT session_id AS id FROM part WHERE time_updated >= ?`)
				.all(this.watermark, this.watermark, this.watermark) as { id: string }[];
			const snapshots: Snapshot[] = [];
			let high = this.watermark;
			for (const { id } of ids) {
				const session = this.source
					.query("SELECT * FROM session WHERE id = ?")
					.get(id) as SourceSession | null;
				if (!session) continue;
				const messages = this.source
					.query("SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id")
					.all(id) as SourceMessage[];
				const parts = this.source
					.query("SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id")
					.all(id) as SourcePart[];
				high = [...messages, ...parts].reduce(
					(latest, row) => Math.max(latest, row.time_updated),
					Math.max(high, session.time_updated),
				);
				snapshots.push({ session, messages, parts });
			}
			return { snapshots, high };
		})();
		let changedEvents = 0;
		for (const snapshot of read.snapshots) changedEvents += await this.importSession(snapshot);
		this.watermark = read.high;
		return { sessions: read.snapshots.length, changedEvents };
	}

	/**
	 * A4: a native session claimed by an AgentPulse-managed binding ON THIS
	 * SOURCE HOST belongs to the managed domain — the observer must not also
	 * ingest it as an external opencode:row. Scope is (sourceHost, nativeId):
	 * the same native id on a DIFFERENT host is a different session.
	 */
	private async isManagedOnThisHost(nativeId: string): Promise<boolean> {
		// SOURCE-DOMAIN proof (not hostname): the provider instance must record
		// THIS observer's source instance id. A same-hostname source with a
		// different storage domain, or an instance with no recorded domain
		// (NULL), is NOT proven — the observer keeps observing.
		const rows = await getDb()
			.select({ id: sessionControlBindings.sessionId })
			.from(sessionControlBindings)
			.innerJoin(providerInstances, eq(providerInstances.id, sessionControlBindings.instanceId))
			.where(
				and(
					eq(sessionControlBindings.nativeSessionId, nativeId),
					eq(sessionControlBindings.origin, "agentpulse_launch"),
					eq(providerInstances.sourceInstanceId, this.instanceId),
				),
			)
			.limit(1);
		return rows.length > 0;
	}

	private async importSession({ session, messages, parts }: Snapshot): Promise<number> {
		// Managed-domain sessions are owned by the snapshot/control path; the
		// observer skips them on this host (no duplicate external rows).
		if (await this.isManagedOnThisHost(session.id)) return 0;
		const sessionId = this.sessionId(session.id);
		const byMessage = new Map(messages.map((message) => [message.id, message]));
		const converted = parts.flatMap((part) => {
			const message = byMessage.get(part.message_id);
			if (!message) return [];
			const event = normalizeOpenCodePart(part, message);
			return event
				? [{ ...event, dedupKey: `opencode:${part.id}`, createdAt: date(part.time_created) }]
				: [];
		});
		const newest = messages.at(-1);
		const latestUser = [...messages].reverse().find((m) => parse(m.data).role === "user");
		const info = newest ? parse(newest.data) : {};
		const lastTime = [...messages, ...parts].reduce(
			(latest, row) => Math.max(latest, row.time_updated),
			session.time_updated,
		);
		const recent = Date.now() - lastTime < 5 * 60_000;
		const running = parts.some((part) =>
			["running", "pending"].includes(String(object(parse(part.data).state).status)),
		);
		const working =
			recent && (running || (info.role === "assistant" && !object(info.time).completed));
		const archived = session.time_archived != null;
		const model = typeof info.modelID === "string" ? info.modelID : (session.model ?? null);
		const projectId = resolveProjectIdForCwd(session.directory, getCachedProjects());
		const result = await withTransaction(async (tx) => {
			const [existing] = await tx.select().from(sessions).where(eq(sessions.sessionId, sessionId));
			if (existing && existing.agentType !== "opencode")
				throw new Error("OpenCode session identity collision");
			const previousMeta = object(existing?.metadata);
			const metadata = {
				...previousMeta,
				nativeName: session.title,
				lastAppliedNativeName: session.title,
				opencode: {
					instanceId: this.instanceId,
					sessionId: session.id,
					parentSessionId: session.parent_id ? this.sessionId(session.parent_id) : null,
					nativeParentId: session.parent_id,
					agent: session.agent,
					cost: session.cost,
					tokens: {
						input: session.tokens_input,
						output: session.tokens_output,
						reasoning: session.tokens_reasoning,
						cacheRead: session.tokens_cache_read,
						cacheWrite: session.tokens_cache_write,
					},
				},
			};
			const values = {
				displayName: previousMeta.renameSource === "user" ? existing.displayName : session.title,
				cwd: session.directory,
				projectId,
				model,
				metadata,
				reportedHost: hostname(),
				status: working ? "active" : "idle",
				isWorking: working,
				semanticStatus: !working && info.role === "user" ? "waiting" : null,
				lastActivityAt: date(lastTime),
				totalToolUses: parts.filter((p) => parse(p.data).type === "tool").length,
				// Preserve operator archives; reflect a source archive without declaring business completion.
				isArchived: archived || existing?.isArchived === true,
				lastAgentTurnCompletedAt: object(info.time).completed
					? date(Number(object(info.time).completed))
					: (existing?.lastAgentTurnCompletedAt ?? null),
				lastUserAcknowledgedAt: latestUser ? date(latestUser.time_created) : null,
			};
			if (existing) await tx.update(sessions).set(values).where(eq(sessions.sessionId, sessionId));
			else
				await tx.insert(sessions).values({
					...values,
					sessionId,
					agentType: "opencode",
					startedAt: date(session.time_created),
				});
			await recordExternalOpenCodeSession(sessionId, tx);
			const stored = await tx
				.select({
					id: events.id,
					dedupKey: events.dedupKey,
					rawPayload: events.rawPayload,
					eventType: events.eventType,
				})
				.from(events)
				.where(eq(events.sessionId, sessionId));
			const byKey = new Map<string, { id: number; rawPayload: unknown; eventType: string }>(
				stored.map(
					(row: { id: number; dedupKey: string; rawPayload: unknown; eventType: string }) => [
						row.dedupKey,
						row,
					],
				),
			);
			const changed = [];
			for (const row of converted) {
				const before = byKey.get(row.dedupKey);
				if (
					before &&
					object(before.rawPayload).observer_fingerprint === row.rawPayload.observer_fingerprint &&
					before.eventType === row.eventType
				)
					continue;
				const rows = before
					? await tx
							.update(events)
							.set(row)
							.where(and(eq(events.sessionId, sessionId), eq(events.id, before.id)))
							.returning()
					: await tx
							.insert(events)
							.values({ ...row, sessionId })
							.onConflictDoUpdate({ target: [events.sessionId, events.dedupKey], set: row })
							.returning();
				changed.push(...rows);
			}
			const [updated] = await tx.select().from(sessions).where(eq(sessions.sessionId, sessionId));
			return { updated, created: !existing, changed };
		});
		if (result.created) notifySessionCreated(result.updated);
		else notifySessionUpdated(result.updated);
		notifySessionEvents(sessionId, toSessionEventDtos(result.changed));
		return result.changed.length;
	}
}

/** Opt-in: local source data is never imported merely because it exists. */
export function startOpenCodeObserver(): () => Promise<void> {
	if (process.env.AGENTPULSE_OPENCODE_ENABLED !== "true" && !process.env.AGENTPULSE_OPENCODE_DB)
		return async () => {};
	let observer: OpenCodeObserver | undefined;
	let stopped = false;
	let warned = false;
	let running: Promise<void> | undefined;
	const tick = async () => {
		if (stopped || running) return;
		running = (async () => {
			try {
				observer ??= new OpenCodeObserver(
					process.env.AGENTPULSE_OPENCODE_DB || defaultOpenCodeDbPath(),
					process.env.AGENTPULSE_OPENCODE_INSTANCE_ID,
				);
				await observer.sync();
				warned = false;
			} catch {
				if (!warned)
					console.warn(
						"[opencode-observer] Source unavailable, unsupported schema, or sync failed; retrying. See docs/OPENCODE.md.",
					);
				warned = true;
			}
		})();
		await running;
		running = undefined;
	};
	const timer = setInterval(() => void tick(), 3000);
	void tick();
	return async () => {
		stopped = true;
		clearInterval(timer);
		await running;
		observer?.close();
	};
}
