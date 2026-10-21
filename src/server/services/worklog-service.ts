import { and, asc, desc, eq, gt, gte, inArray, like, lt } from "drizzle-orm";
import { z } from "zod";
import {
	DEFAULT_WORKLOG_CONFIG,
	type WorklogConfig,
	type WorklogFact,
	type WorklogRun,
} from "../../shared/worklog.js";
import { getDb } from "../db/client.js";
import { events, sessions, settings } from "../db/schema/index.js";
import { jsonExtractText } from "../db/sql-helpers.js";
import { isAiActive } from "./ai/feature.js";
import { priceCompletion } from "./ai/llm/pricing.js";
import { getAdapter } from "./ai/llm/registry.js";
import type { LlmResponse } from "./ai/llm/types.js";
import { getProvider, getProviderApiKey } from "./ai/providers-service.js";
import { redact } from "./ai/redactor.js";
import { reserveSpendCents, settleReservedSpend } from "./ai/spend-service.js";
import { EFFECTIVE_MACHINE } from "./effective-machine.js";
import { upsertSetting } from "./settings-service.js";
import { toDbTimestamp } from "./util/db-time.js";
import {
	type ChunkEvent,
	FACT_EXTRACTION_SYSTEM_PROMPT,
	TEAM_DRAFT_SYSTEM_PROMPT,
	appendVersion,
	dedupeFacts,
	parseFacts,
	renderPersonalReview,
	renderTeamDraftInput,
} from "./worklog-facts.js";
import { loadCopiedEvents } from "./worklog-copy.js";

const CONFIG = "worklog.config";
export const worklogConfigSchema = z.object({
	enabled: z.boolean(),
	timezone: z
		.string()
		.max(100)
		.refine((zone) => {
			try {
				new Intl.DateTimeFormat("en", { timeZone: zone });
				return true;
			} catch {
				return false;
			}
		}),
	time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
	providerId: z.string().max(200),
	model: z.string().max(200),
	documentUrl: z
		.string()
		.max(2000)
		.refine((url) => {
			if (!url) return true;
			try {
				const u = new URL(url);
				return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password;
			} catch {
				return false;
			}
		}),
	documentId: z.string().max(500),
});
export async function readWorklogValue<T>(key: string, fallback: T): Promise<T> {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, key));
	return row ? (row.value as T) : fallback;
}
const save = (key: string, value: unknown) => upsertSetting(key, value, { allowProtected: true });
export const getWorklogConfig = () => readWorklogValue(CONFIG, DEFAULT_WORKLOG_CONFIG);
export async function saveWorklogConfig(input: unknown) {
	const config = worklogConfigSchema.parse(input);
	if (config.enabled && (!config.providerId || !config.model || !config.documentUrl))
		throw new Error("Configure a model and document endpoint before enabling automatic delivery");
	if (config.enabled) {
		const previous = await getWorklogConfig();
		if (!previous.enabled) await save("worklog.firstDay", localDate(new Date(), config.timezone));
	}
	await save(CONFIG, config);
	return config;
}
export const getWorklogIncluded = (sessionId: string) =>
	readWorklogValue(`worklog.include.${sessionId}`, true);
export async function setWorklogIncluded(sessionId: string, included: boolean) {
	const [session] = await getDb()
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId));
	if (!session) throw new Error("Session not found");
	await save(`worklog.include.${sessionId}`, included);
}
export function localDate(now: Date, timezone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const value = (name: string) => parts.find((p) => p.type === name)?.value;
	return `${value("year")}-${value("month")}-${value("day")}`;
}
export function previousDate(date: string) {
	return new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
export function validateDate(date: string) {
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
		new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
	)
		throw new Error("Invalid calendar date");
}
/** Find midnight in the target zone using date boundaries (23/25 hour DST days included). */
export function dayWindow(date: string, timezone: string) {
	validateDate(date);
	const center = Date.parse(`${date}T00:00:00Z`);
	const boundary = (target: string) => {
		let lo = center - 36 * 3_600_000;
		let hi = center + 60 * 3_600_000;
		while (hi - lo > 1) {
			const mid = Math.floor((lo + hi) / 2);
			if (localDate(new Date(mid), timezone) < target) lo = mid;
			else hi = mid;
		}
		return new Date(hi);
	};
	return {
		start: boundary(date),
		end: boundary(new Date(center + 86_400_000).toISOString().slice(0, 10)),
	};
}
const runKey = (date: string, zone: string) => `worklog.run.${zone}.${date}`;
export async function listWorklogs() {
	const rows = await getDb()
		.select()
		.from(settings)
		.where(like(settings.key, "worklog.run.%"))
		.orderBy(desc(settings.updatedAt))
		.limit(60);
	return rows.map((r) => r.value as WorklogRun);
}

/** DB lease survives restart and prevents two replicas generating/delivering the same day. */
async function claim(key: string) {
	const token = crypto.randomUUID();
	const now = new Date();
	const inserted = await getDb()
		.insert(settings)
		.values({ key, value: { token }, updatedAt: now.toISOString() })
		.onConflictDoNothing()
		.returning();
	if (inserted.length) return token;
	const rows = await getDb()
		.update(settings)
		.set({ value: { token }, updatedAt: now.toISOString() })
		.where(
			and(
				eq(settings.key, key),
				lt(settings.updatedAt, new Date(now.getTime() - 180_000).toISOString()),
			),
		)
		.returning();
	if (!rows.length) throw new Error("This work log is already running");
	return token;
}

export async function runWorklog(
	date: string,
	deliver = false,
	admission?: { token: string; config: WorklogConfig; force?: boolean },
): Promise<WorklogRun> {
	const config = admission?.config ?? (await getWorklogConfig());
	const window = dayWindow(date, config.timezone);
	if (window.end > new Date())
		throw new Error("Choose a completed day so late-day messages are not omitted");
	const key = runKey(date, config.timezone);
	const leaseKey = `worklog.lock.${config.timezone}.${date}`;
	const token = admission?.token ?? (await claim(leaseKey));
	const ownedLease = and(
		eq(settings.key, leaseKey),
		eq(jsonExtractText(settings.value, "$.token"), token),
	);
	const assertLease = async () => {
		const lock = await readWorklogValue<{ token: string } | null>(leaseKey, null);
		if (lock?.token !== token)
			throw new Error("Work-log lease lost; another worker is recovering it");
	};
	// Keep the lease alive even for days containing many sessions/chunks.
	const heartbeat = setInterval(() => {
		void getDb()
			.update(settings)
			.set({ updatedAt: new Date().toISOString() })
			.where(ownedLease)
			.catch(() => {});
	}, 30_000);
	let run = await readWorklogValue<WorklogRun>(key, {
		date,
		timezone: config.timezone,
		status: "ready",
		markdown: "",
		sessionIds: [],
		error: null,
		updatedAt: new Date().toISOString(),
	});
	try {
		if (run.status === "delivered") return run;
		if (!run.markdown || admission?.force) {
			if (!(await isAiActive()))
				throw new Error("Enable AI in Settings before generating work logs");
			const provider = await getProvider(config.providerId);
			const apiKey = await getProviderApiKey(config.providerId);
			if (!provider || !apiKey || !config.model)
				throw new Error("Configure a work-log model provider");
			const adapter = getAdapter({
				kind: provider.kind,
				apiKey,
				baseUrl: provider.baseUrl ?? undefined,
			});
			run = { ...run, status: "generating", error: null };
			await assertLease();
			await save(key, run);
			const excludedRows = await getDb()
				.select()
				.from(settings)
				.where(like(settings.key, "worklog.include.%"));
			const excluded = new Set(
				excludedRows
					.filter((r) => r.value === false)
					.map((r) => r.key.slice("worklog.include.".length)),
			);
			const active = await getDb()
				.selectDistinct({
					sessionId: events.sessionId,
					name: sessions.displayName,
					host: EFFECTIVE_MACHINE,
				})
				.from(events)
				.innerJoin(sessions, eq(events.sessionId, sessions.sessionId))
				.where(
					and(
						gte(events.createdAt, toDbTimestamp(window.start)),
						lt(events.createdAt, toDbTimestamp(window.end)),
						inArray(events.category, ["prompt", "assistant_message"]),
					),
				);
			// ── P4 fact pipeline: chunked extraction → dedup → two views ──
			// Chunks carry `[#eventId]` prefixes so the model can cite evidence;
			// parseFacts drops any fact whose evidence id was not in the chunk.
			const allFacts: WorklogFact[] = [];
			let rejectedFacts = 0;
			let downgradedFacts = 0;
			let modelCalls = 0;
			run.sessionIds = [];
			for (const session of active) {
				if (excluded.has(session.sessionId)) continue;
				// Provenance of events COPIED by a fork: dedupe anchor + original
				// occurrence time. Empty for ordinary sessions.
				const copies = await loadCopiedEvents(session.sessionId);
				let after = 0;
				let chunk = "";
				// The chunk's real events by id — the only admissible evidence
				// for extraction (ids, timestamps and content all come from here).
				const chunkEvents = new Map<number, ChunkEvent>();
				const sessionFacts: WorklogFact[] = [];
				const extract = async () => {
					if (!chunk) return;
					if (!(await isAiActive())) throw new Error("AI paused during work-log generation");
					if (++modelCalls > 100)
						throw new Error("Work log exceeded 100 model calls; narrow the session scope");
					await assertLease();
					const reservedCents = Math.ceil(
						priceCompletion(provider.kind, config.model, {
							inputTokens: chunk.length + 2000,
							outputTokens: 1800,
							estimated: true,
						}),
					);
					const reservation = await reserveSpendCents(reservedCents);
					if (!reservation) throw new Error("Daily AI spend cap reached");
					let chargedCents = reservedCents;
					let response: LlmResponse;
					try {
						response = await adapter.complete({
							model: config.model,
							maxTokens: 1800,
							systemPrompt: FACT_EXTRACTION_SYSTEM_PROMPT,
							transcriptPrompt: redact(chunk).text,
						});
						chargedCents = Math.ceil(priceCompletion(provider.kind, config.model, response.usage));
					} finally {
						await settleReservedSpend(reservation, {
							sessionId: session.sessionId,
							actualCents: chargedCents,
						});
					}
					if (
						!response.text.trim() ||
						response.stopReason === "refusal" ||
						response.stopReason === "length"
					)
						throw new Error("Model returned incomplete work-log content");
					const parsed = parseFacts(response.text, {
						sessionId: session.sessionId,
						host: session.host,
						sessionName: session.name || session.sessionId,
						events: chunkEvents,
						...(copies.size > 0 ? { copies } : {}),
					});
					// A broken extraction protocol must fail loudly — an empty
					// "successful" log would silently hide the failure.
					if (parsed.parseFailed)
						throw new Error("Model returned unparseable fact extraction output");
					rejectedFacts += parsed.rejected;
					downgradedFacts += parsed.downgraded;
					sessionFacts.push(...parsed.facts);
					chunk = "";
					chunkEvents.clear();
				};
				for (;;) {
					const batch = await getDb()
						.select({
							id: events.id,
							category: events.category,
							content: events.content,
							createdAt: events.createdAt,
							eventType: events.eventType,
							toolResponse: events.toolResponse,
						})
						.from(events)
						.where(
							and(
								eq(events.sessionId, session.sessionId),
								gt(events.id, after),
								gte(events.createdAt, toDbTimestamp(window.start)),
								lt(events.createdAt, toDbTimestamp(window.end)),
								inArray(events.category, ["prompt", "assistant_message", "tool_event"]),
							),
						)
						.orderBy(asc(events.id))
						.limit(100);
					if (!batch.length) break;
					for (const event of batch) {
						// Tool lines surface the mechanical status and an output
						// excerpt so extraction can cite real verification output.
						const toolSuffix =
							event.category === "tool_event"
								? ` [status=${
										event.eventType === "PreToolUse"
											? "running"
											: event.eventType === "PostToolUseFailure"
												? "error"
												: "completed"
									}] ${event.toolResponse?.slice(0, 400) ?? ""}`
								: "";
						const text = `[#${event.id}] ${event.category}: ${event.content ?? ""}${toolSuffix}\n`;
						for (let offset = 0; offset < text.length; offset += 12000) {
							const part = text.slice(offset, offset + 12000);
							if (chunk.length + part.length > 16000) await extract();
							chunk += part;
						}
						chunkEvents.set(event.id, {
							id: event.id,
							category: event.category ?? "unknown",
							createdAt: event.createdAt,
							content: event.content,
							eventType: event.eventType,
							toolResponse: event.toolResponse,
						});
						after = event.id;
					}
				}
				await extract();
				if (!sessionFacts.length) continue;
				run.sessionIds.push(session.sessionId);
				allFacts.push(...sessionFacts);
			}
			// Fork-copied turns recorded by another session count once.
			const facts = dedupeFacts(allFacts);
			const extractedAt = new Date().toISOString();
			// Personal review: deterministic render, no model call. A forced
			// regeneration APPENDS to the previous versions — old drafts are
			// never silently overwritten (taskbook P4 versioning rule).
			let versions = appendVersion(
				run.versions ?? [],
				{
					kind: "personal",
					markdown: renderPersonalReview({
						date,
						timezone: config.timezone,
						facts,
						sessionNames: new Map(active.map((row) => [row.sessionId, row.name || row.sessionId])),
					}),
					generator: { model: config.model, source: "facts" },
				},
				new Date(extractedAt),
			);
			// Team draft: a single model call over the fact digest.
			if (facts.length) {
				if (++modelCalls > 100)
					throw new Error("Work log exceeded 100 model calls; narrow the session scope");
				await assertLease();
				const reservedCents = Math.ceil(
					priceCompletion(provider.kind, config.model, {
						inputTokens: facts.length * 80 + 2000,
						outputTokens: 1800,
						estimated: true,
					}),
				);
				const reservation = await reserveSpendCents(reservedCents);
				if (!reservation) throw new Error("Daily AI spend cap reached");
				let chargedCents = reservedCents;
				let response: LlmResponse;
				try {
					response = await adapter.complete({
						model: config.model,
						maxTokens: 1800,
						systemPrompt: TEAM_DRAFT_SYSTEM_PROMPT,
						transcriptPrompt: redact(renderTeamDraftInput(facts)).text,
					});
					chargedCents = Math.ceil(priceCompletion(provider.kind, config.model, response.usage));
				} finally {
					await settleReservedSpend(reservation, {
						sessionId: run.sessionIds[0] ?? "worklog",
						actualCents: chargedCents,
					});
				}
				if (
					!response.text.trim() ||
					response.stopReason === "refusal" ||
					response.stopReason === "length"
				)
					throw new Error("Model returned incomplete work-log content");
				versions = appendVersion(
					versions,
					{
						kind: "team",
						markdown: redact(response.text).text,
						generator: { model: config.model, source: "facts" },
					},
					new Date(extractedAt),
				);
			}
			// Adoption is user-owned: a forced regeneration appends versions but
			// never resets a prior explicit adoption (manual edits included).
			// Only a first generation (no prior adoption) auto-adopts the team draft.
			const teamVersion = versions.filter((v) => v.kind === "team").at(-1) ?? null;
			const priorAdoptedId = run.adoptedVersionId ?? null;
			const adoptedId =
				priorAdoptedId && versions.some((v) => v.versionId === priorAdoptedId)
					? priorAdoptedId
					: (teamVersion?.versionId ?? versions[versions.length - 1]?.versionId ?? null);
			const adoptedVersion = versions.find((v) => v.versionId === adoptedId) ?? teamVersion;
			run = {
				...run,
				markdown: adoptedVersion ? adoptedVersion.markdown : "",
				facts,
				factMeta: {
					model: config.model,
					extractedAt,
					rejected: rejectedFacts,
					deduped: allFacts.length - facts.length,
					downgraded: downgradedFacts,
				},
				versions,
				adoptedVersionId: adoptedId,
				status: "ready",
				error: null,
				updatedAt: extractedAt,
			};
			await assertLease();
			await save(key, run);
		}
		if (deliver) {
			if (!config.documentUrl) throw new Error("Document endpoint is not configured");
			// Refuse exporting an old draft after the operator excludes one of its sessions.
			for (const id of run.sessionIds)
				if (!(await getWorklogIncluded(id)))
					throw new Error("Summary scope changed; discard the draft and generate it again");
			await assertLease();

			const idempotencyKey = `agentpulse-worklog:${config.timezone}:${date}:${config.documentId}`;
			const response = await fetch(config.documentUrl, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": idempotencyKey,
					...(process.env.AGENTPULSE_WORKLOG_DOCUMENT_TOKEN
						? { Authorization: `Bearer ${process.env.AGENTPULSE_WORKLOG_DOCUMENT_TOKEN}` }
						: {}),
				},
				body: JSON.stringify({
					version: 1,
					idempotencyKey,
					documentId: config.documentId,
					date,
					timezone: config.timezone,
					title: `工作日志 · ${date}`,
					markdown: run.markdown,
					sessionIds: run.sessionIds,
					operation: "upsert",
				}),
			});
			if (!response.ok) throw new Error(`Document endpoint returned HTTP ${response.status}`);
			run = { ...run, status: "delivered", error: null, updatedAt: new Date().toISOString() };
			await assertLease();
			await save(key, run);
		}
		return run;
	} catch (error) {
		run = {
			...run,
			status: "failed",
			error: error instanceof Error ? error.message : "Work log failed",
			updatedAt: new Date().toISOString(),
		};
		await assertLease();
		await save(key, run);
		throw error;
	} finally {
		clearInterval(heartbeat);
		await getDb().delete(settings).where(ownedLease);
	}
}

export async function discardWorklog(date: string) {
	validateDate(date);
	const config = await getWorklogConfig();
	const key = runKey(date, config.timezone);
	const leaseKey = `worklog.lock.${config.timezone}.${date}`;
	const token = await claim(leaseKey);
	try {
		const run = await readWorklogValue<WorklogRun | null>(key, null);
		if (run?.status === "delivered") throw new Error("A delivered log cannot be discarded");
		await getDb().delete(settings).where(eq(settings.key, key));
	} finally {
		await getDb()
			.delete(settings)
			.where(
				and(eq(settings.key, leaseKey), eq(jsonExtractText(settings.value, "$.token"), token)),
			);
	}
}

/** Scope preview: sessions active in the day window, no model calls. */
export async function previewWorklogScope(date: string): Promise<{
	date: string;
	timezone: string;
	sessions: Array<{
		sessionId: string;
		name: string | null;
		host: string | null;
		included: boolean;
		counts: { prompt: number; assistant_message: number; tool_event: number };
	}>;
}> {
	validateDate(date);
	const config = await getWorklogConfig();
	const window = dayWindow(date, config.timezone);
	const rows = await getDb()
		.select({
			sessionId: events.sessionId,
			name: sessions.displayName,
			host: EFFECTIVE_MACHINE,
			category: events.category,
		})
		.from(events)
		.innerJoin(sessions, eq(events.sessionId, sessions.sessionId))
		.where(
			and(
				gte(events.createdAt, toDbTimestamp(window.start)),
				lt(events.createdAt, toDbTimestamp(window.end)),
				inArray(events.category, ["prompt", "assistant_message", "tool_event"]),
			),
		);
	const excludedRows = await getDb()
		.select()
		.from(settings)
		.where(like(settings.key, "worklog.include.%"));
	const excluded = new Set(
		excludedRows
			.filter((r) => r.value === false)
			.map((r) => r.key.slice("worklog.include.".length)),
	);
	const bySession = new Map<
		string,
		{
			name: string | null;
			host: string | null;
			counts: { prompt: number; assistant_message: number; tool_event: number };
		}
	>();
	for (const row of rows) {
		const entry = bySession.get(row.sessionId) ?? {
			name: row.name,
			host: row.host,
			counts: { prompt: 0, assistant_message: 0, tool_event: 0 },
		};
		if (
			row.category === "prompt" ||
			row.category === "assistant_message" ||
			row.category === "tool_event"
		)
			entry.counts[row.category] += 1;
		bySession.set(row.sessionId, entry);
	}
	return {
		date,
		timezone: config.timezone,
		sessions: [...bySession.entries()].map(([sessionId, entry]) => ({
			sessionId,
			name: entry.name,
			host: entry.host,
			included: !excluded.has(sessionId),
			counts: entry.counts,
		})),
	};
}

/**
 * Appends a manual-edit version based on an existing one and adopts it.
 * Regeneration never overwrites it; a delivered run is locked.
 */
export async function editWorklogVersion(
	date: string,
	baseVersionId: string,
	markdown: string,
): Promise<WorklogRun> {
	validateDate(date);
	if (typeof markdown !== "string" || !markdown.trim() || markdown.length > 200_000)
		throw new Error("Invalid markdown");
	const config = await getWorklogConfig();
	const key = runKey(date, config.timezone);
	const leaseKey = `worklog.lock.${config.timezone}.${date}`;
	const token = await claim(leaseKey);
	try {
		const run = await readWorklogValue<WorklogRun | null>(key, null);
		if (!run) throw new Error("No work log for that date");
		if (run.status === "delivered") throw new Error("A delivered log cannot be edited");
		const base = run.versions?.find((v) => v.versionId === baseVersionId);
		if (!base) throw new Error("Unknown base version");
		const { appendVersion } = await import("./worklog-facts.js");
		const versions = appendVersion(run.versions ?? [], {
			kind: base.kind,
			markdown,
			generator: { model: null, source: "manual" },
		});
		const manual = versions[versions.length - 1];
		const next: WorklogRun = {
			...run,
			versions,
			markdown,
			adoptedVersionId: manual.versionId,
			updatedAt: new Date().toISOString(),
		};
		await save(key, next);
		return next;
	} finally {
		await getDb()
			.delete(settings)
			.where(
				and(eq(settings.key, leaseKey), eq(jsonExtractText(settings.value, "$.token"), token)),
			);
	}
}

/** Run detail incl. facts and view versions; null when nothing was generated. */
export async function getWorklogRun(date: string): Promise<WorklogRun | null> {
	validateDate(date);
	const config = await getWorklogConfig();
	return readWorklogValue<WorklogRun | null>(runKey(date, config.timezone), null);
}

/**
 * Adopts one of the run's view versions for delivery/export. Manual edits can
 * be recorded the same way once the UI writes `source: "manual"` versions.
 */
export async function adoptWorklogVersion(date: string, versionId: string): Promise<WorklogRun> {
	validateDate(date);
	const config = await getWorklogConfig();
	const key = runKey(date, config.timezone);
	const leaseKey = `worklog.lock.${config.timezone}.${date}`;
	const token = await claim(leaseKey);
	try {
		const run = await readWorklogValue<WorklogRun | null>(key, null);
		if (!run) throw new Error("No work log for that date");
		if (run.status === "delivered") throw new Error("A delivered log cannot be re-adopted");
		const version = run.versions?.find((v) => v.versionId === versionId);
		if (!version) throw new Error("Unknown version");
		const next: WorklogRun = {
			...run,
			markdown: version.markdown,
			adoptedVersionId: version.versionId,
			updatedAt: new Date().toISOString(),
		};
		await save(key, next);
		return next;
	} finally {
		await getDb()
			.delete(settings)
			.where(
				and(eq(settings.key, leaseKey), eq(jsonExtractText(settings.value, "$.token"), token)),
			);
	}
}

export async function runScheduledWorklogs(now = new Date()) {
	const config = await getWorklogConfig();
	if (!config.enabled) return;
	const time = new Intl.DateTimeFormat("en-GB", {
		timeZone: config.timezone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(now);
	if (time < config.time) return;
	let date = previousDate(localDate(now, config.timezone));
	const enabledOn = await readWorklogValue<string>("worklog.firstDay", date);
	await save("worklog.firstDay", enabledOn);
	for (let i = 0; i < 7 && date >= enabledOn; i++, date = previousDate(date)) {
		if (!(await getWorklogConfig()).enabled) break;
		try {
			await runWorklog(date, true);
		} catch (error) {
			console.error("[worklog]", error instanceof Error ? error.message : "Scheduled run failed");
		}
	}
}
export function startWorklogScheduler() {
	let busy = false;
	const tick = async () => {
		if (busy) return;
		busy = true;
		try {
			await runScheduledWorklogs();
		} catch (error) {
			console.error("[worklog]", error instanceof Error ? error.message : "Scheduler failed");
		} finally {
			busy = false;
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), 60_000);
	return () => clearInterval(timer);
}

export async function queueWorklog(date: string, deliver: boolean) {
	const config = await getWorklogConfig();
	if (dayWindow(date, config.timezone).end > new Date())
		throw new Error("Choose a completed calendar day");
	if (!(await isAiActive())) throw new Error("Enable AI in Settings before generating work logs");
	const leaseKey = `worklog.lock.${config.timezone}.${date}`;
	const token = await claim(leaseKey);
	void runWorklog(date, deliver, { token, config }).catch((error) =>
		console.error("[worklog]", error.message),
	);
	return { accepted: true, date, timezone: config.timezone };
}
