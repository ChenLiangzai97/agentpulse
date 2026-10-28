/**
 * P2: an INDEPENDENT supervisor process (A or B) for the real run service.
 *
 * A connects with the shared resolver, delivers ONE long native turn and exits
 * while that turn is still in flight. B is a separate OS process that connects
 * with the SAME resolver and reads the SAME native message id to its terminal
 * result. Neither process holds the daemon or the OpenCode child.
 *
 * Usage:
 *   bun p2-real-supervisor.ts --role a --root R --instance I --generation G --native N [--timeout MS]
 *   bun p2-real-supervisor.ts --role b --root R --instance I --generation G --native N --message-id M [--timeout MS]
 */
import { turnTerminal } from "../../src/supervisor/providers/claim-evidence.js";
import {
	connectRunService,
	createRunServiceStore,
	fetchRunServiceMessages,
	promptRunService,
} from "../../src/supervisor/providers/run-service-connection.js";

const flags = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith("--") || value === undefined) throw new Error("invalid_argument");
	flags.set(key.slice(2), value);
}

const role = flags.get("role");
const root = flags.get("root");
const instanceId = flags.get("instance");
const generation = Number(flags.get("generation"));
const nativeSessionId = flags.get("native");
const timeoutMs = Number(flags.get("timeout") ?? 45_000);
const messageId = flags.get("message-id");

function emit(value: Record<string, unknown>, code = 0): never {
	console.log(JSON.stringify(value));
	process.exit(code);
}
function fail(error: unknown, extra: Record<string, unknown> = {}): never {
	emit(
		{ ok: false, role, error: error instanceof Error ? error.message : String(error), ...extra },
		2,
	);
}

const messageInfo = (item: unknown) => (item as { info?: Record<string, unknown> })?.info ?? {};
const messageParts = (item: unknown) =>
	Array.isArray((item as { parts?: unknown[] })?.parts)
		? ((item as { parts: Record<string, unknown>[] }).parts ?? [])
		: [];
const isUserMessage = (item: unknown, id: string) => {
	const info = messageInfo(item);
	return info.id === id && info.role === "user";
};

if (!root || !instanceId || !nativeSessionId || !Number.isInteger(generation) || generation < 1)
	fail(new Error("invalid_arguments"));
if (role !== "a" && role !== "b") fail(new Error("invalid_role"));
if (role === "b" && !messageId) fail(new Error("missing_message_id"));

const expected = {
	instanceId: instanceId as string,
	generation,
	nativeSessionId: nativeSessionId as string,
};
const connected = await connectRunService(root as string, instanceId as string, expected);
if (!connected.ok) fail(new Error(`connect_refused:${connected.reason}`));

// The URL/token come from the SAME protected store the resolver just verified.
const store = createRunServiceStore(root as string);
const manifest = await store.readManifest(instanceId as string);
const token = await store.readToken(instanceId as string);
const readView = async () => {
	const response = await fetchRunServiceMessages(manifest.url, token, { timeoutMs: 5000 });
	if (response.status !== 200) throw new Error(`messages_http_${response.status}`);
	const body = (response.body ?? {}) as { messages?: unknown[]; status?: { type?: string } };
	if (!Array.isArray(body.messages)) throw new Error("messages_invalid");
	return { messages: body.messages, status: body.status ?? {} };
};

try {
	if (role === "a") {
		const startedAt = Date.now();
		const response = await promptRunService(
			manifest.url,
			token,
			`P0_ABORT P2 same-turn probe ${crypto.randomUUID()} keep this turn in flight`,
			{ timeoutMs: 20_000 },
		);
		const body = (response.body ?? {}) as { ok?: unknown; messageID?: unknown };
		if (response.status !== 200 || body.ok !== true || typeof body.messageID !== "string")
			fail(new Error("prompt_refused"), { status: response.status, body });
		const messageID = body.messageID as string;
		// Exit ONLY once the real runtime reports the turn in flight. A completed
		// turn here would not satisfy the slice, so it is a hard failure.
		let inFlight: Record<string, unknown> | null = null;
		while (Date.now() - startedAt < timeoutMs) {
			const view = await readView();
			const userPresent = view.messages.some((item) => isUserMessage(item, messageID));
			const terminal = turnTerminal(view.messages, messageID);
			if (userPresent && !terminal && view.status.type === "busy") {
				inFlight = {
					status: view.status.type,
					userMessagePresent: true,
					turnTerminal: false,
					assistantCount: view.messages.filter((item) => {
						const info = messageInfo(item);
						return info.role === "assistant" && info.parentID === messageID;
					}).length,
					observedAt: new Date().toISOString(),
				};
				break;
			}
			await Bun.sleep(100);
		}
		if (!inFlight) fail(new Error("turn_not_in_flight_before_exit"), { messageID });
		emit({
			ok: true,
			role: "a",
			pid: process.pid,
			identity: connected.identity,
			nativeSessionId: connected.identity.nativeSessionId,
			messageID,
			inFlight,
			exitedWhileInFlight: true,
		});
	}

	// B: a different process, reconnected only through the resolver above. It
	// must observe the turn STILL IN FLIGHT; connecting after it finished would
	// only prove that a stored result can be re-read (not part of this slice).
	const startedAt = Date.now();
	let terminal: Record<string, unknown> | null = null;
	let lastStatus: string | undefined;
	let connectedWhileInFlight = false;
	while (Date.now() - startedAt < timeoutMs) {
		const view = await readView();
		lastStatus = view.status.type;
		if (terminal === null && lastStatus === "busy") connectedWhileInFlight = true;
		const userMessage = view.messages.find((item) => isUserMessage(item, messageId as string));
		const assistants = view.messages.filter((item) => {
			const info = messageInfo(item);
			return info.role === "assistant" && info.parentID === messageId;
		}) as unknown[];
		const done =
			Boolean(userMessage) &&
			turnTerminal(view.messages, messageId as string) &&
			view.status.type !== "busy" &&
			view.status.type !== "retry";
		if (done) {
			const last = assistants.at(-1) as { info?: Record<string, unknown> } | undefined;
			const info = last?.info ?? {};
			const responseParts = messageParts(last).filter((part) => part.type === "text");
			const partEnds = messageParts(last)
				.map((part) => (part.time as { end?: unknown } | undefined)?.end)
				.filter((end): end is number => typeof end === "number");
			const time = info.time as { created?: unknown; completed?: unknown } | undefined;
			terminal = {
				identity: connected.identity,
				sameNativeSessionId: connected.identity.nativeSessionId === expected.nativeSessionId,
				connectedWhileInFlight,
				messageID: messageId,
				userMessagePresent: true,
				status: view.status.type,
				assistant: {
					id: info.id,
					parentID: info.parentID,
					sessionID: info.sessionID,
					finish: info.finish ?? null,
					error: info.error ?? null,
					modelID: info.modelID,
					providerID: info.providerID,
					createdAt:
						typeof time?.created === "number" ? new Date(time.created).toISOString() : null,
					completedAt:
						typeof time?.completed === "number" ? new Date(time.completed).toISOString() : null,
				},
				text: responseParts
					.map((part) => part.text)
					.filter((text): text is string => typeof text === "string")
					.join(""),
				partCompletedAt: partEnds.length > 0 ? new Date(Math.max(...partEnds)).toISOString() : null,
				pollMs: Date.now() - startedAt,
			};
			break;
		}
		await Bun.sleep(200);
	}
	if (!terminal) fail(new Error("terminal_timeout"), { lastStatus });
	if (terminal.connectedWhileInFlight !== true)
		fail(new Error("b_connected_after_turn_finished"), { terminal });
	emit({ ok: true, role: "b", pid: process.pid, terminal });
} catch (error) {
	fail(error);
}
