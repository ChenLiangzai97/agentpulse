import { Database } from "bun:sqlite";
/**
 * AGEN-71: the OpenCode observer — a server-side collector that tails
 * OpenCode's own local database (~/.local/share/opencode/opencode.db) and
 * replays its sessions into AgentPulse through the same POST /api/v1/hooks
 * ingestion path every other agent uses.
 *
 * Why server-side (unlike the codex observer, which lives in the supervisor):
 * OpenCode's sessions live in a single SQLite file on this machine, the
 * server already runs periodic services (retention, transcript-sync), and a
 * direct-mode install has no supervisor process at all. The observer is a
 * no-op on deployments where the database does not exist, and
 * AGENTPULSE_OPENCODE_OBSERVER=off disables it explicitly.
 *
 * Delivery discipline mirrors the codex observer (Decision 2 / F48): every
 * post carries X-Agent-Type: opencode, X-AgentPulse-Origin: opencode-observer
 * and a deterministic X-AgentPulse-Delivery-Id (sha256 of
 * table+session+rowid), so a state-loss replay of the same rows is
 * exactly-once at the server via the durable dedup_key.
 *
 * Mapping (opencode row -> AgentPulse event):
 *   session row        -> SessionStart (cwd=directory, model) + native-name
 *                         pull (title), once per session; time_archived -> SessionEnd
 *   message role=user  -> UserPromptSubmit (prompt = its settled text parts)
 *   message role=assistant -> its settled tool parts first (PostToolUse /
 *                         PostToolUseFailure, tool_use_id = the part's callID),
 *                         then Stop with last_assistant_message = joined text
 *                         parts — the same shape the codex observer uses, so
 *                         isWorking/turn-completion/acknowledgement all work
 *   step-start/step-finish/reasoning parts -> ignored (noise for the ledger)
 *
 * Rows are only delivered once settled (time_updated older than SETTLE_MS),
 * so a mid-stream assistant message is never posted half-written. The
 * per-session cursor is the last delivered message rowid; parts are read per
 * message at delivery time. Exclude rules (~/.agentpulse/exclude) are checked
 * per session directory before anything is sent.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { evaluateExclusion, loadExcludeRules } from "../../shared/exclude-rules.js";
import {
	DELIVERY_ID_HEADER,
	HOST_HEADER,
	ORIGIN_HEADER,
	ORIGIN_OPENCODE_OBSERVER,
} from "../../shared/hook-headers.js";

const STATE_FILE = join(homedir(), ".agentpulse", "opencode-observer-state.json");
const SCAN_INTERVAL_MS = 5_000;
/** A row younger than this is still being streamed/edited; deliver it on a later scan. */
const SETTLE_MS = 8_000;
/** Messages delivered per session per scan — keeps a first-run history import bounded. */
const MESSAGE_BATCH = 200;
/** tool_response is trimmed to this before posting (ingest drops oversized bodies wholesale). */
const TOOL_RESPONSE_CAP = 4_000;
const PROMPT_CAP = 20_000;

export type SessionState = {
	/** SessionStart delivered. */
	started: boolean;
	/** SessionEnd delivered (time_archived seen). */
	ended: boolean;
	/** Last delivered message rowid; rows above it are pending. */
	msgCursor: number;
	/** The session title last pushed through the native-name pull. */
	appliedTitle: string | null;
	/** Set once the directory was covered by an exclude rule; never cleared. */
	excluded?: boolean;
};

export type ObserverState = { version: 1; sessions: Record<string, SessionState> };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What one scan needs from the outside world — injectable for tests. */
export interface ScanDeps {
	fetchImpl?: FetchLike;
	hooksUrl: string;
	/** Native-name pull base (same server, different route); empty disables the pull. */
	apiUrl: string;
	apiKey?: string | null;
	now?: () => number;
	reportedHost?: string | null;
	/** Overrides the home directory the exclude rules are read from (tests). */
	home?: string;
}

type SessionRow = {
	rowid: number;
	id: string;
	directory: string | null;
	title: string | null;
	model: string | null;
	time_archived: number | null;
};

type MessageRow = {
	rowid: number;
	id: string;
	session_id: string;
	time_created: number;
	time_updated: number;
	data: string;
};

type PartRow = {
	rowid: number;
	id: string;
	message_id: string;
	time_updated: number;
	data: string;
};

export function opencodeDbPath(): string {
	const override = process.env.OPENCODE_DB;
	if (override) return override;
	return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

// ── state ────────────────────────────────────────────────────────────────────

export function loadState(path = STATE_FILE): ObserverState {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as ObserverState;
		if (raw && raw.version === 1 && typeof raw.sessions === "object" && raw.sessions !== null) {
			return raw;
		}
	} catch {
		// missing or unreadable: start fresh (server-side dedup makes replay safe)
	}
	return { version: 1, sessions: {} };
}

export function saveState(state: ObserverState, path = STATE_FILE): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	// Same-directory temp + rename: a cross-device rename (tmpdir() often sits
	// on another filesystem than $HOME) throws EXDEV and loses the scan's
	// progress — same-directory rename is atomic and always works.
	const tmp = join(dir, `.opencode-observer-state-${process.pid}.json.tmp`);
	writeFileSync(tmp, JSON.stringify(state));
	renameSync(tmp, path);
}

// ── delivery identity ────────────────────────────────────────────────────────

/** Deterministic per-row delivery id: stable across replays, so the server's durable dedup_key makes a state-loss re-scan exactly-once. */
export function deliveryIdFor(
	kind: "start" | "end" | "message" | "part",
	sessionId: string,
	rowid: number,
): string {
	return createHash("sha256")
		.update(`opencode\u0000${sessionId}\u0000${kind}\u0000${rowid}`)
		.digest("hex")
		.slice(0, 32);
}

// ── mapping ──────────────────────────────────────────────────────────────────

type HookPayload = {
	session_id: string;
	hook_event_name: string;
	cwd?: string;
	model?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
	tool_use_id?: string;
	last_assistant_message?: string;
	prompt?: string;
	turn_id?: string;
};

interface MappedMessage {
	payloads: Array<{ payload: HookPayload; deliveryKind: "message" | "part"; rowid: number }>;
}

function parseJson(value: unknown): Record<string, unknown> {
	if (typeof value !== "string") return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function cap(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n[truncated by opencode observer]`;
}

/**
 * One opencode message -> the hook payloads that replay it, in order:
 * user -> UserPromptSubmit; assistant -> settled tool parts (rowid order),
 * then Stop carrying the assistant text. Empty when nothing is deliverable.
 */
export function mapMessage(message: MessageRow, parts: PartRow[]): MappedMessage {
	const data = parseJson(message.data);
	const role = typeof data.role === "string" ? data.role : null;
	const out: MappedMessage["payloads"] = [];
	if (role === "user") {
		const text = parts
			.map((p) => parseJson(p.data))
			.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text as string)
			.join("\n")
			.trim();
		if (text) {
			out.push({
				payload: {
					session_id: message.session_id,
					hook_event_name: "UserPromptSubmit",
					prompt: cap(text, PROMPT_CAP),
					turn_id: message.id,
				},
				deliveryKind: "message",
				rowid: message.rowid,
			});
		}
		return { payloads: out };
	}
	if (role !== "assistant") return { payloads: out };
	for (const part of parts) {
		const pdata = parseJson(part.data);
		if (pdata.type !== "tool") continue;
		const state = pdata.state as Record<string, unknown> | undefined;
		const status = state?.status;
		if (status !== "completed" && status !== "error") continue;
		const payload: HookPayload = {
			session_id: message.session_id,
			hook_event_name: status === "error" ? "PostToolUseFailure" : "PostToolUse",
			tool_name: typeof pdata.tool === "string" ? pdata.tool : "unknown",
			turn_id: message.id,
		};
		if (typeof pdata.callID === "string") payload.tool_use_id = pdata.callID;
		if (state?.input && typeof state.input === "object") {
			payload.tool_input = state.input as Record<string, unknown>;
		}
		if (status === "error") {
			const err = state?.error;
			payload.tool_response = typeof err === "string" ? cap(err, TOOL_RESPONSE_CAP) : (err ?? null);
		} else if (typeof state?.output === "string") {
			payload.tool_response = cap(state.output, TOOL_RESPONSE_CAP);
		}
		out.push({ payload, deliveryKind: "part", rowid: part.rowid });
	}
	const text = parts
		.map((p) => parseJson(p.data))
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n")
		.trim();
	if (text) {
		out.push({
			payload: {
				session_id: message.session_id,
				hook_event_name: "Stop",
				last_assistant_message: cap(text, PROMPT_CAP),
				turn_id: message.id,
			},
			deliveryKind: "message",
			rowid: message.rowid,
		});
	}
	return { payloads: out };
}

// ── posting ──────────────────────────────────────────────────────────────────

async function postHook(deps: ScanDeps, payload: HookPayload, deliveryId: string): Promise<void> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Agent-Type": "opencode",
		[ORIGIN_HEADER]: ORIGIN_OPENCODE_OBSERVER,
		[DELIVERY_ID_HEADER]: deliveryId,
	};
	if (deps.reportedHost) headers[HOST_HEADER] = deps.reportedHost;
	if (deps.apiKey) headers.Authorization = `Bearer ${deps.apiKey}`;
	const res = await (deps.fetchImpl ?? fetch)(`${deps.hooksUrl}/api/v1/hooks`, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`opencode observer ingest ${res.status} ${res.statusText}`);
}

async function putNativeName(deps: ScanDeps, sessionId: string, title: string): Promise<boolean> {
	if (!deps.apiUrl) return false;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (deps.apiKey) headers.Authorization = `Bearer ${deps.apiKey}`;
	const res = await (deps.fetchImpl ?? fetch)(
		`${deps.apiUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/native-name`,
		{
			method: "PUT",
			headers,
			body: JSON.stringify({ name: title }),
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!res.ok) throw new Error(`opencode observer native-name ${res.status} ${res.statusText}`);
	return ((await res.json()) as { applied?: boolean }).applied === true;
}

// ── one scan ─────────────────────────────────────────────────────────────────

export interface ScanSummary {
	sessionsSeen: number;
	messagesDelivered: number;
	excludedSessions: number;
}

/**
 * One pass over the opencode database. Reads only; every write is a POST to
 * this server's own ingest. Exported for tests and for the interval loop.
 */
export async function runScan(
	db: Database,
	state: ObserverState,
	deps: ScanDeps,
	options: { statePath?: string; save?: boolean } = {},
): Promise<ScanSummary> {
	const now = (deps.now ?? Date.now)();
	const settleCut = now - SETTLE_MS;
	const rules = loadExcludeRules(deps.home ?? homedir());
	const summary: ScanSummary = { sessionsSeen: 0, messagesDelivered: 0, excludedSessions: 0 };
	let dirty = false;

	const sessions = db
		.prepare("SELECT rowid AS rowid, id, directory, title, model, time_archived FROM session")
		.all() as unknown as SessionRow[];
	for (const session of sessions) {
		let s = state.sessions[session.id];
		if (!s) {
			s = { started: false, ended: false, msgCursor: 0, appliedTitle: null };
			state.sessions[session.id] = s;
			dirty = true;
		}
		const directory = session.directory ?? null;
		if (directory && !s.excluded) {
			const verdict = evaluateExclusion({ cwd: directory, skip: undefined, rules });
			if (verdict.excluded) {
				s.excluded = true;
				dirty = true;
			}
		}
		if (s.excluded) {
			summary.excludedSessions += 1;
			// An excluded session's cursor still advances past its rows so the
			// state cannot grow unboundedly with its activity; nothing is sent.
			s.msgCursor = bumpCursor(db, session.id, s.msgCursor, settleCut, true);
			continue;
		}
		summary.sessionsSeen += 1;
		if (!s.started) {
			await postHook(
				deps,
				{
					session_id: session.id,
					hook_event_name: "SessionStart",
					...(directory ? { cwd: directory } : {}),
					...(session.model ? { model: session.model } : {}),
				},
				deliveryIdFor("start", session.id, session.rowid),
			);
			s.started = true;
			dirty = true;
		}
		if (session.title && session.title !== s.appliedTitle) {
			try {
				await putNativeName(deps, session.id, session.title);
				s.appliedTitle = session.title;
				dirty = true;
			} catch (error) {
				console.warn("[opencode-observer] native-name pull failed", { error });
			}
		}
		if (session.time_archived !== null && !s.ended) {
			await postHook(
				deps,
				{ session_id: session.id, hook_event_name: "SessionEnd" },
				deliveryIdFor("end", session.id, session.rowid),
			);
			s.ended = true;
			dirty = true;
		}
		if (session.time_archived !== null) continue;

		const delivered = await deliverMessages(db, session.id, s, settleCut, deps);
		summary.messagesDelivered += delivered;
		if (delivered > 0) dirty = true;
	}
	if (dirty && options.save !== false) {
		saveState(state, options.statePath ?? STATE_FILE);
	}
	return summary;
}

/**
 * Delivers settled messages above the cursor, in rowid order, stopping at the
 * first unsettled row so order is preserved (a mid-stream message blocks the
 * rows behind it, exactly like a file tail). Returns the cursor's advance.
 */
async function deliverMessages(
	db: Database,
	sessionId: string,
	s: SessionState,
	settleCut: number,
	deps: ScanDeps,
): Promise<number> {
	const rows = db
		.prepare(
			"SELECT rowid AS rowid, id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
		)
		.all(sessionId, s.msgCursor, MESSAGE_BATCH) as unknown as MessageRow[];
	let delivered = 0;
	for (const message of rows) {
		if (message.time_updated > settleCut) break;
		const parts = db
			.prepare(
				"SELECT rowid AS rowid, id, message_id, time_updated, data FROM part WHERE message_id = ? AND time_updated <= ? ORDER BY rowid ASC",
			)
			.all(message.id, settleCut) as unknown as PartRow[];
		const mapped = mapMessage(message, parts);
		for (const entry of mapped.payloads) {
			await postHook(
				deps,
				entry.payload,
				deliveryIdFor(entry.deliveryKind, sessionId, entry.rowid),
			);
		}
		s.msgCursor = message.rowid;
		dirtyCursor(s);
		delivered += 1;
	}
	return delivered;
}

function dirtyCursor(_s: SessionState): void {
	// The caller saves the state when any delivery happened; the cursor itself
	// is part of that state, so nothing extra is needed here.
}

/**
 * Advances a session's cursor without delivering anything (excluded sessions).
 * Reads settled rows only, so a still-streaming excluded session keeps its
 * place without ever posting.
 */
function bumpCursor(
	db: Database,
	sessionId: string,
	from: number,
	settleCut: number,
	_all: boolean,
): number {
	const rows = db
		.prepare(
			"SELECT rowid AS rowid, time_updated FROM message WHERE session_id = ? AND rowid > ? AND time_updated <= ? ORDER BY rowid DESC LIMIT 1",
		)
		.all(sessionId, from, settleCut) as unknown as Array<{ rowid: number }>;
	const top = rows[0]?.rowid;
	return typeof top === "number" ? top : from;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function isOpenCodeObserverEnabled(): boolean {
	const flag = process.env.AGENTPULSE_OPENCODE_OBSERVER;
	return flag !== "off" && flag !== "false" && flag !== "0";
}

/**
 * Starts the interval loop against this server's own HTTP surface. A no-op
 * (with one log line) when OpenCode's database is absent — k8s/Docker
 * deployments where no agent runs on the server box.
 */
export function startOpenCodeObserver(baseUrl: string, apiKey?: string | null): void {
	if (!isOpenCodeObserverEnabled()) {
		console.log("[opencode-observer] disabled via AGENTPULSE_OPENCODE_OBSERVER=off");
		return;
	}
	const dbPath = opencodeDbPath();
	if (!existsSync(dbPath)) {
		console.log(`[opencode-observer] no OpenCode database at ${dbPath}; standing down`);
		return;
	}
	if (timer) return;
	const deps: ScanDeps = {
		hooksUrl: baseUrl,
		apiUrl: baseUrl,
		apiKey: apiKey ?? null,
		reportedHost: hostname(),
	};
	timer = setInterval(() => {
		void scanOnce(dbPath, deps);
	}, SCAN_INTERVAL_MS);
	if (typeof timer.unref === "function") timer.unref();
	console.log(`[opencode-observer] watching ${dbPath} every ${SCAN_INTERVAL_MS / 1000}s`);
	void scanOnce(dbPath, deps);
}

async function scanOnce(dbPath: string, deps: ScanDeps): Promise<void> {
	if (running) return;
	running = true;
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const summary = await runScan(db, loadState(), deps);
			if (summary.messagesDelivered > 0) {
				console.log(
					`[opencode-observer] ${summary.messagesDelivered} message(s) delivered across ${summary.sessionsSeen} session(s)`,
				);
			}
		} finally {
			db.close();
		}
	} catch (error) {
		console.error("[opencode-observer] scan failed", error);
	} finally {
		running = false;
	}
}

/** Test/lifecycle helper: stops the interval loop. */
export function stopOpenCodeObserver(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

export const OPENCODE_OBSERVER_LIMITS = {
	scanIntervalMs: SCAN_INTERVAL_MS,
	settleMs: SETTLE_MS,
	messageBatch: MESSAGE_BATCH,
	toolResponseCap: TOOL_RESPONSE_CAP,
} as const;
