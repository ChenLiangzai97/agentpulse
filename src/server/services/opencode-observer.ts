/** Read-only OpenCode v1 SQLite observer. Never loads or changes OpenCode plugins. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { events, sessions } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { toSessionEventDtos } from "./event-dto.js";
import type { NormalizedEvent } from "./event-normalizer.js";
import { notifySessionCreated, notifySessionEvents, notifySessionUpdated } from "./notifier.js";
import {
	OpenCodeSchemaError,
	defaultOpenCodeDbPath,
	validateOpenCodeSchema,
} from "./opencode-source.js";
export { defaultOpenCodeDbPath } from "./opencode-source.js";
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

export class OpenCodeObserver {
	private source: Database;
	private watermark = 0;
	private schemaVersion = -1;
	readonly instanceId: string;
	constructor(path: string, instanceId = `${hostname()}:${resolve(path)}`) {
		this.instanceId = hash(instanceId).slice(0, 20);
		this.source = new Database(path, { readonly: true, create: false });
		try {
			validateOpenCodeSchema(this.source);
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
			const { schema_version: schemaVersion } = this.source
				.query("PRAGMA schema_version")
				.get() as { schema_version: number };
			if (schemaVersion !== this.schemaVersion) validateOpenCodeSchema(this.source);
			// Re-read all rows after a compatible migration, including newly added metadata.
			const watermark = schemaVersion === this.schemaVersion ? this.watermark : 0;
			const ids = this.source
				.query(`SELECT id FROM session WHERE time_updated >= ?
    UNION SELECT session_id AS id FROM message WHERE time_updated >= ?
    UNION SELECT session_id AS id FROM part WHERE time_updated >= ?`)
				.all(watermark, watermark, watermark) as { id: string }[];
			const snapshots: Snapshot[] = [];
			let high = watermark;
			// Fresh statements refresh SELECT * column mappings after a live migration.
			const sessionQuery = this.source.prepare("SELECT * FROM session WHERE id = ?");
			const messageQuery = this.source.prepare(
				"SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id",
			);
			const partQuery = this.source.prepare(
				"SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id",
			);
			try {
				for (const { id } of ids) {
					const session = sessionQuery.get(id) as SourceSession | null;
					if (!session) continue;
					const messages = messageQuery.all(id) as SourceMessage[];
					const parts = partQuery.all(id) as SourcePart[];
					high = [...messages, ...parts].reduce(
						(latest, row) => Math.max(latest, row.time_updated),
						Math.max(high, session.time_updated),
					);
					snapshots.push({ session, messages, parts });
				}
			} finally {
				sessionQuery.finalize();
				messageQuery.finalize();
				partQuery.finalize();
			}
			return { snapshots, high, schemaVersion };
		})();
		let changedEvents = 0;
		for (const snapshot of read.snapshots) changedEvents += await this.importSession(snapshot);
		this.watermark = read.high;
		this.schemaVersion = read.schemaVersion;
		return { sessions: read.snapshots.length, changedEvents };
	}

	private async importSession({ session, messages, parts }: Snapshot): Promise<number> {
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
				const initial = !observer;
				observer ??= new OpenCodeObserver(
					process.env.AGENTPULSE_OPENCODE_DB || defaultOpenCodeDbPath(),
					process.env.AGENTPULSE_OPENCODE_INSTANCE_ID,
				);
				const result = await observer.sync();
				if (initial)
					console.info(
						`[opencode-observer] Observation ready (v1, read-only): ${result.sessions} sessions scanned, ${result.changedEvents} events changed.`,
					);
				warned = false;
			} catch (error) {
				// Reopen after failures so a repaired/replaced DB or completed migration can recover.
				observer?.close();
				observer = undefined;
				if (!warned)
					console.warn(
						error instanceof OpenCodeSchemaError
							? `[opencode-observer] ${error.message}; no schema migration will be attempted. Retrying. Run bun scripts/observe-opencode.ts --check; see docs/OPENCODE.md.`
							: "[opencode-observer] Source unavailable or sync failed; reopening and retrying. Run bun scripts/observe-opencode.ts --check as the server account; see docs/OPENCODE.md.",
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
