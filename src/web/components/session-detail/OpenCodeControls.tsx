import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { Session } from "../../../shared/types.js";
import { useT } from "../../i18n/i18n.js";
import { api } from "../../lib/api.js";
import { scopedQuery } from "../../lib/scoped-query.js";
import { usePromptDraftStore } from "../../stores/prompt-draft-store.js";

type Interaction = Awaited<ReturnType<typeof api.getOpenCodeInteractions>>["interactions"][number];
type Question = {
	question: string;
	header?: string;
	options?: { label: string; description?: string }[];
	multiple?: boolean;
	custom?: boolean;
};
function QuestionCard({
	item,
	answer,
	disabled,
}: { item: Interaction; answer: (body: Record<string, unknown>) => void; disabled: boolean }) {
	const t = useT();
	const questions = (
		Array.isArray(item.payload.questions) ? item.payload.questions : []
	) as Question[];
	const [answers, setAnswers] = useState<string[][]>(questions.map(() => []));
	const [custom, setCustom] = useState<string[]>(questions.map(() => ""));
	return (
		<div className="space-y-3">
			{questions.map((q, index) => (
				<fieldset key={`${item.id}-${index}`} disabled={disabled} className="space-y-2">
					<legend className="font-medium">
						{q.header} · {q.question}
					</legend>
					{q.options?.map((option) => (
						<label key={option.label} className="flex gap-2 items-start">
							<input
								type={q.multiple ? "checkbox" : "radio"}
								name={`${item.id}-${index}`}
								checked={answers[index]?.includes(option.label) ?? false}
								onChange={(e) =>
									setAnswers((current) =>
										current.map((old, i) =>
											i !== index
												? old
												: q.multiple
													? e.target.checked
														? [...old, option.label]
														: old.filter((v) => v !== option.label)
													: [option.label],
										),
									)
								}
							/>
							<span>
								{option.label} <span className="text-muted-foreground">{option.description}</span>
							</span>
						</label>
					))}
					{q.custom !== false && (
						<input
							aria-label={`${t("opencodeCmd.freeAnswer")} ${index + 1}`}
							value={custom[index]}
							placeholder={t("opencodeCmd.freeAnswer")}
							maxLength={10000}
							className="w-full rounded border bg-background p-2"
							onChange={(e) =>
								setCustom((current) =>
									current.map((value, i) => (i === index ? e.target.value : value)),
								)
							}
						/>
					)}
				</fieldset>
			))}
			<button
				type="button"
				className="rounded border px-3 py-1"
				disabled={disabled || questions.length === 0}
				onClick={() =>
					answer({
						answers: answers.map((values, i) =>
							custom[i]?.trim()
								? questions[i].multiple
									? [...values, custom[i].trim()]
									: [custom[i].trim()]
								: values,
						),
					})
				}
			>
				{t("opencodeCmd.submitAnswer")}
			</button>
		</div>
	);
}
export function OpenCodeControls({
	session,
	onChanged,
}: { session: Session; onChanged: () => Promise<void> }) {
	const t = useT();
	const [cap, setCap] = useState<Session["controlCapabilities"]>();
	/** SAME snapshot as the connection block (detail DTO). Until the capability
	 * is loaded we do NOT open the input: unknown != allowed. */
	const sendBlocked = session.controlCapabilities?.send !== true;
	const [items, setItems] = useState<Interaction[]>([]);
	// Per-session draft (P1): survives tab switches and reloads; cleared on send.
	const [prompt, setPrompt] = useState(() =>
		usePromptDraftStore.getState().getDraft(session.sessionId),
	);
	// Component reuse (A→B without a key) must never leak A's draft into B.
	const sessionIdRef = useRef(session.sessionId);
	sessionIdRef.current = session.sessionId;
	useEffect(() => {
		setPrompt(usePromptDraftStore.getState().getDraft(session.sessionId));
	}, [session.sessionId]);
	const [catalog, setCatalog] = useState<{
		commands: { name: string; description?: string; source?: string }[];
		agents: { name: string; description?: string }[];
		providers: { id: string; name?: string; models: string[] }[] | null;
	} | null>(null);
	const [commandMenuOpen, setCommandMenuOpen] = useState(false);
	const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [agentPickerOpen, setAgentPickerOpen] = useState(false);
	const [pendingModel, setPendingModel] = useState<string | null>(() => {
		try {
			return localStorage.getItem(`agentpulse.opencode.model.${session.sessionId}`);
		} catch {
			return null;
		}
	});
	const [pendingAgent, setPendingAgent] = useState<string | null>(() => {
		try {
			return localStorage.getItem(`agentpulse.opencode.agent.${session.sessionId}`);
		} catch {
			return null;
		}
	});
	const persistChoice = (kind: "model" | "agent", value: string | null) => {
		try {
			const key = `agentpulse.opencode.${kind}.${session.sessionId}`;
			if (value) localStorage.setItem(key, value);
			else localStorage.removeItem(key);
		} catch {}
	};
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Catalog loads per session; a stale response from a previous session never
	// lands (active flag + deps) — and pending model/agent reload from this
	// session's own storage key whenever the rendered session changes, so a
	// reused component never carries another session's choices.
	useEffect(() => {
		let active = true;
		// A previous session's catalog must never flash into this one's menu.
		setCatalog(null);
		const load = () =>
			api
				.getOpenCodeCommands(session.sessionId)
				.then((r) => {
					if (active) setCatalog(r);
				})
				.catch(() => {});
		void load();
		const timer = setInterval(() => void load(), 10000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [session.sessionId]);
	useEffect(() => {
		try {
			setPendingModel(localStorage.getItem(`agentpulse.opencode.model.${session.sessionId}`));
			setPendingAgent(localStorage.getItem(`agentpulse.opencode.agent.${session.sessionId}`));
		} catch {
			setPendingModel(null);
			setPendingAgent(null);
		}
	}, [session.sessionId]);
	useEffect(() => {
		let active = true;
		setCap(undefined);
		setItems([]);
		const poll = async () => {
			try {
				const capabilities = await api.getOpenCodeCapabilities(session.sessionId);
				if (!active) return;
				setCap(capabilities);
				setError(null);
				if (capabilities.answerQuestion) {
					const result = await api.getOpenCodeInteractions(session.sessionId);
					if (active) setItems(result.interactions);
				} else setItems([]);
			} catch {
				if (active) {
					setCap(undefined);
					setError(t("opencodeCmd.capUnavailable"));
				}
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), 2000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [session.sessionId]);
	function handleSlash(text: string): void {
		const [head, ...rest] = text.slice(1).split(/\s+/);
		const name = (head ?? "").toLowerCase();
		const args = rest.join(" ");
		if (name === "model") {
			setModelPickerOpen(true);
			return;
		}
		if (name === "agent") {
			setAgentPickerOpen(true);
			return;
		}
		if (name === "help") {
			setCommandMenuOpen(true);
			return;
		}
		if (name === "session") {
			setSessionPickerOpen(true);
			return;
		}
		const known = (catalog?.commands ?? []).find(
			(c) => c.source === "command" && c.name.toLowerCase() === name,
		);
		if (known) {
			const [providerID, ...modelParts] = (pendingModel ?? "").split("/");
			// Await the server: the command text is only cleared on SUCCESS —
			// a failed command keeps the input so the user can retry/edit.
			void send({
				kind: "opencode_command",
				command: known.name,
				...(args ? { arguments: args.slice(0, 2000) } : {}),
				...(pendingModel && modelParts.length
					? { model: { providerID, modelID: modelParts.join("/") } }
					: {}),
				...(pendingAgent ? { agent: pendingAgent } : {}),
			});
			return;
		}
		toast.error(t("opencodeCmd.unknown").replace("{name}", name));
	}
	/** Clears the input/draft for a COMPLETED send — only when the viewer
	 * taken when the send started. The PERSISTED draft of the SENT session is
	 * cleared even after navigating away; the mounted input is cleared only when
	 * it still shows that session. A rewritten draft and another session's draft
	 * are never touched; a cross-viewer callback generation no longer matches. */
	function clearSentDraft(sentSession: string, sentVersion: number, sentGeneration: number) {
		const store = usePromptDraftStore.getState();
		// Clear the PERSISTED draft of the sent session (viewer epoch + version
		// guarded). Only the mounted input is touched when it still shows that
		// session: navigating to B must not leave A's delivered text behind and
		// must never clear B's draft.
		if (!store.canClearSent(sentSession, sentVersion, sentGeneration)) return;
		store.clearDraft(sentSession);
		if (sessionIdRef.current === sentSession) setPrompt("");
	}
	async function send(body: Record<string, unknown>) {
		const sentSession = sessionIdRef.current;
		const sentVersion = usePromptDraftStore.getState().currentVersion(sentSession);
		const sentGeneration = usePromptDraftStore.getState().currentGeneration();
		setBusy(true);
		try {
			await api.openCodeAction(session.sessionId, body);
			if (body.kind === "prompt" || body.kind === "opencode_command")
				clearSentDraft(sentSession, sentVersion, sentGeneration);
			if (body.interactionId)
				setItems((old) => old.filter((item) => item.id !== body.interactionId));
			await onChanged();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("opencodeCmd.controlFailed"));
		} finally {
			setBusy(false);
		}
	}
	if (!cap?.send) {
		if (!error && (!cap || cap.origin !== "agentpulse_launch")) return null;
		return (
			<section className="border-b border-border px-3 py-3 text-sm text-muted-foreground">
				{error ??
					(cap?.reason === "not_owner" ? t("opencodeCmd.notOwner") : t("opencodeCmd.stoppedNote"))}
			</section>
		);
	}

	return (
		<section className="space-y-3 border-b border-border px-3 py-3 md:px-6">
			<div className="flex gap-3 items-center text-sm">
				<strong>{t("opencodeCmd.managedHeader")}</strong>
				<button
					type="button"
					disabled={busy}
					className="rounded border px-3 py-1"
					onClick={() => void send({ kind: "interrupt" })}
				>
					{t("opencodeCmd.interruptTurn")}
				</button>
				<button
					type="button"
					disabled={busy}
					className="rounded border px-3 py-1"
					onClick={() => void send({ kind: "stop" })}
				>
					{t("opencodeCmd.stopInstance")}
				</button>
			</div>
			{items.map((item) => (
				<div
					key={`${item.id}-${item.revision}`}
					className="space-y-3 rounded border border-amber-500/40 p-3 text-sm"
				>
					<strong>
						{item.kind === "permission"
							? t("opencodeCmd.permissionCard")
							: t("opencodeCmd.questionCard")}
					</strong>
					{item.kind === "permission" ? (
						<>
							<pre className="whitespace-pre-wrap break-all text-xs">
								{JSON.stringify(
									{
										permission: item.payload.permission,
										patterns: item.payload.patterns,
										metadata: item.payload.metadata,
									},
									null,
									2,
								)}
							</pre>
							<button
								type="button"
								disabled={busy}
								className="rounded border px-3 py-1"
								onClick={() =>
									void send({
										kind: "interaction_response",
										interactionId: item.id,
										revision: item.revision,
										decision: "once",
									})
								}
							>
								{t("opencodeCmd.allowOnce")}
							</button>
						</>
					) : (
						<QuestionCard
							item={item}
							disabled={busy}
							answer={(body) =>
								void send({
									kind: "interaction_response",
									interactionId: item.id,
									revision: item.revision,
									...body,
								})
							}
						/>
					)}
					<button
						type="button"
						disabled={busy}
						className="ml-2 rounded border px-3 py-1"
						onClick={() =>
							void send({
								kind: "interaction_response",
								interactionId: item.id,
								revision: item.revision,
								decision: "reject",
							})
						}
					>
						{t("opencodeCmd.reject")}
					</button>
				</div>
			))}
			{commandMenuOpen && (
				<CommandMenu
					catalog={catalog}
					pendingModel={pendingModel}
					pendingAgent={pendingAgent}
					onPickSession={() => {
						setCommandMenuOpen(false);
						setSessionPickerOpen(true);
					}}
					onPickModel={() => {
						setCommandMenuOpen(false);
						setModelPickerOpen(true);
					}}
					onPickAgent={() => {
						setCommandMenuOpen(false);
						setAgentPickerOpen(true);
					}}
					onRunCommand={(name) => {
						setCommandMenuOpen(false);
						const [providerID, ...rest] = (pendingModel ?? "").split("/");
						void send({
							kind: "opencode_command",
							command: name,
							...(pendingModel && rest.length
								? { model: { providerID, modelID: rest.join("/") } }
								: {}),
							...(pendingAgent ? { agent: pendingAgent } : {}),
						});
					}}
					onClose={() => setCommandMenuOpen(false)}
				/>
			)}
			{sessionPickerOpen && (
				<SessionPicker
					currentSessionId={session.sessionId}
					onClose={() => setSessionPickerOpen(false)}
				/>
			)}
			{modelPickerOpen && (
				<ModelPicker
					catalog={catalog}
					current={pendingModel}
					onChoose={(value) => {
						setPendingModel(value);
						persistChoice("model", value);
						setModelPickerOpen(false);
					}}
					onClose={() => setModelPickerOpen(false)}
				/>
			)}
			{agentPickerOpen && (
				<AgentPicker
					catalog={catalog}
					current={pendingAgent}
					onChoose={(value) => {
						setPendingAgent(value);
						persistChoice("agent", value);
						setAgentPickerOpen(false);
					}}
					onClose={() => setAgentPickerOpen(false)}
				/>
			)}
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					const text = prompt.trim();
					if (text.startsWith("/")) {
						handleSlash(text);
						return;
					}
					const [providerID, ...rest] = (pendingModel ?? "").split("/");
					void send({
						kind: "prompt",
						prompt: text,
						...(pendingModel && rest.length
							? { model: { providerID, modelID: rest.join("/") } }
							: {}),
						...(pendingAgent ? { agent: pendingAgent } : {}),
					});
				}}
			>
				<div className="flex-1">
					{(pendingModel || pendingAgent) && (
						<div className="mb-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
							{pendingModel && (
								<button
									type="button"
									className="rounded bg-muted px-1.5 py-0.5"
									onClick={() => setModelPickerOpen(true)}
								>
									{t("opencodeCmd.modelBadge")} {pendingModel}
								</button>
							)}
							{pendingAgent && (
								<button
									type="button"
									className="rounded bg-muted px-1.5 py-0.5"
									onClick={() => setAgentPickerOpen(true)}
								>
									{t("opencodeCmd.agentBadge")} {pendingAgent}
								</button>
							)}
						</div>
					)}
					<textarea
						aria-label="OpenCode 消息"
						disabled={sendBlocked}
						className="min-h-20 w-full rounded border bg-background p-2 text-sm"
						maxLength={12000}
						value={prompt}
						onChange={(e) => {
							setPrompt(e.target.value);
							usePromptDraftStore.getState().setDraft(session.sessionId, e.target.value);
							setCommandMenuOpen(e.target.value.startsWith("/") && !e.target.value.includes(" "));
						}}
						onKeyDown={(e) => {
							// Enter sends (and routes /commands); Shift+Enter is a newline.
							if (sendBlocked) return;
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								e.currentTarget.form?.requestSubmit();
							}
						}}
					/>
					{prompt.startsWith("/") && !prompt.includes(" ") && (
						<p className="mt-1 text-[11px] text-amber-400">{t("opencodeCmd.slashHint")}</p>
					)}
				</div>
				<button
					type="submit"
					disabled={busy || sendBlocked || !prompt.trim()}
					className="rounded border px-3"
				>
					{t("opencodeCmd.send")}
				</button>
			</form>
			<p className="text-xs text-muted-foreground">{t("opencodeCmd.footerNote")}</p>
		</section>
	);
}

function CommandMenu({
	catalog,
	pendingModel,
	pendingAgent,
	onPickSession,
	onPickModel,
	onPickAgent,
	onRunCommand,
	onClose,
}: {
	catalog: {
		commands: { name: string; description?: string; source?: string }[];
		agents: { name: string; description?: string }[];
		providers: { id: string; name?: string; models: string[] }[] | null;
	} | null;
	pendingModel: string | null;
	pendingAgent: string | null;
	onPickSession: () => void;
	onPickModel: () => void;
	onPickAgent: () => void;
	onRunCommand: (name: string) => void;
	onClose: () => void;
}) {
	const t = useT();
	// Only native custom commands are executable this round; global skills stay
	// listed-but-not-runnable until an explicit source policy lands (spec §7).
	const commands = (catalog?.commands ?? []).filter((c) => c.source === "command").slice(0, 40);
	return (
		<div
			className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-20"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div className="w-full max-w-md rounded-lg border border-border bg-card p-3 shadow-xl">
				<div className="mb-2 flex items-center justify-between">
					<strong className="text-sm">{t("opencodeCmd.title")}</strong>
					<button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
						{t("opencodeCmd.close")}
					</button>
				</div>
				<div className="max-h-72 space-y-1 overflow-y-auto text-sm">
					<button
						type="button"
						onClick={onPickSession}
						className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
					>
						/session <span className="text-muted-foreground">{t("opencodeCmd.sessionDesc")}</span>
					</button>
					<button
						type="button"
						onClick={onPickModel}
						className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
					>
						/model{" "}
						<span className="text-muted-foreground">
							{t("opencodeCmd.modelDesc").replace("{current}", pendingModel ?? "")}
						</span>
					</button>
					<button
						type="button"
						onClick={onPickAgent}
						className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
					>
						/agent{" "}
						<span className="text-muted-foreground">
							{t("opencodeCmd.agentDesc").replace("{current}", pendingAgent ?? "")}
						</span>
					</button>
					<div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
						{t("opencodeCmd.nativeSection")}
					</div>
					{commands.length === 0 && (
						<div className="px-2 py-1 text-xs text-muted-foreground">
							{t("opencodeCmd.noCommands")}
						</div>
					)}
					{commands.map((c) => (
						<button
							key={c.name}
							type="button"
							onClick={() => onRunCommand(c.name)}
							className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
						>
							/{c.name} <span className="text-muted-foreground">{c.description ?? ""}</span>
						</button>
					))}
					<div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
						{t("opencodeCmd.notesSection")}
					</div>
					<div className="px-2 pb-1 text-xs text-muted-foreground">
						{t("opencodeCmd.helpMatrix")}
					</div>
				</div>
			</div>
		</div>
	);
}

function ModelPicker({
	catalog,
	current,
	onChoose,
	onClose,
}: {
	catalog: {
		commands: { name: string }[];
		agents: { name: string }[];
		providers: { id: string; name?: string; models: string[] }[] | null;
	} | null;
	current: string | null;
	onChoose: (value: string | null) => void;
	onClose: () => void;
}) {
	const t = useT();
	const entries: { id: string; label: string }[] = [];
	for (const provider of catalog?.providers ?? [])
		for (const modelID of provider.models ?? [])
			entries.push({ id: `${provider.id}/${modelID}`, label: provider.name ?? provider.id });
	return (
		<div
			className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-20"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div className="w-full max-w-md rounded-lg border border-border bg-card p-3 shadow-xl">
				<div className="mb-2 flex items-center justify-between">
					<strong className="text-sm">{t("opencodeCmd.modelTitle")}</strong>
					<button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
						{t("opencodeCmd.close")}
					</button>
				</div>
				<div className="max-h-72 space-y-1 overflow-y-auto text-sm">
					{entries.length === 0 && (
						<div className="px-2 py-1 text-xs text-muted-foreground">
							{t("opencodeCmd.noModels")}
						</div>
					)}
					{entries.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => onChoose(entry.id)}
							className={cnPicker(entry.id === current)}
						>
							<span className="font-mono text-xs">{entry.id}</span>{" "}
							<span className="text-muted-foreground">{entry.label}</span>
						</button>
					))}
					{current && (
						<button
							type="button"
							onClick={() => onChoose(null)}
							className="mt-2 block w-full rounded border border-border px-2 py-1.5 text-left text-xs text-muted-foreground"
						>
							{t("opencodeCmd.clearModel")}
						</button>
					)}
				</div>
				<p className="mt-2 text-[11px] text-muted-foreground">{t("opencodeCmd.modelNote")}</p>
			</div>
		</div>
	);
}

function AgentPicker({
	catalog,
	current,
	onChoose,
	onClose,
}: {
	catalog: {
		commands: { name: string }[];
		agents: { name: string; description?: string }[];
		providers: unknown;
	} | null;
	current: string | null;
	onChoose: (value: string | null) => void;
	onClose: () => void;
}) {
	const t = useT();
	const agents = catalog?.agents ?? [];
	return (
		<div
			className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-20"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div className="w-full max-w-md rounded-lg border border-border bg-card p-3 shadow-xl">
				<div className="mb-2 flex items-center justify-between">
					<strong className="text-sm">{t("opencodeCmd.agentTitle")}</strong>
					<button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
						{t("opencodeCmd.close")}
					</button>
				</div>
				<div className="max-h-72 space-y-1 overflow-y-auto text-sm">
					{agents.length === 0 && (
						<div className="px-2 py-1 text-xs text-muted-foreground">
							{t("opencodeCmd.noAgents")}
						</div>
					)}
					{agents.map((agent) => (
						<button
							key={agent.name}
							type="button"
							onClick={() => onChoose(agent.name)}
							className={cnPicker(agent.name === current)}
						>
							<span className="font-mono text-xs">{agent.name}</span>{" "}
							<span className="text-muted-foreground">{agent.description ?? ""}</span>
						</button>
					))}
					{current && (
						<button
							type="button"
							onClick={() => onChoose(null)}
							className="mt-2 block w-full rounded border border-border px-2 py-1.5 text-left text-xs text-muted-foreground"
						>
							{t("opencodeCmd.clearAgent")}
						</button>
					)}
				</div>
				<p className="mt-2 text-[11px] text-muted-foreground">{t("opencodeCmd.agentNote")}</p>
			</div>
		</div>
	);
}

function cnPicker(active: boolean): string {
	return `block w-full rounded px-2 py-1.5 text-left hover:bg-muted ${active ? "bg-primary/10 text-primary" : ""}`;
}

function SessionPicker({
	currentSessionId,
	onClose,
}: {
	currentSessionId: string;
	onClose: () => void;
}) {
	const t = useT();
	const [rows, setRows] = useState<
		{
			sessionId: string;
			displayName: string | null;
			status: string;
			controllable: boolean | null;
		}[]
	>([]);
	const [loading, setLoading] = useState(true);
	const navigate = useNavigate();
	useEffect(() => {
		let active = true;
		void api
			.getSessions(
				scopedQuery({ owner: "all", excludeScratch: false }, { agent_type: "opencode", limit: 30 }),
			)
			.then(async (r) => {
				const sessions = r.sessions;
				const detailed = await Promise.all(
					sessions.map(async (item) => {
						let controllable: boolean | null = null;
						try {
							const caps = await api.getOpenCodeCapabilities(item.sessionId);
							controllable = Boolean(caps.send);
						} catch {
							controllable = null;
						}
						return {
							sessionId: item.sessionId,
							displayName: item.displayName,
							status: item.status ?? "",
							controllable,
						};
					}),
				);
				if (active) setRows(detailed);
			})
			.catch(() => {})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);
	return (
		<div
			className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-16"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div className="w-full max-w-lg rounded-lg border border-border bg-card p-3 shadow-xl">
				<div className="mb-2 flex items-center justify-between">
					<strong className="text-sm">{t("opencodeCmd.sessionTitle")}</strong>
					<button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
						{t("opencodeCmd.close")}
					</button>
				</div>
				<div className="max-h-80 space-y-1 overflow-y-auto text-sm">
					{loading && (
						<div className="px-2 py-1 text-xs text-muted-foreground">
							{t("opencodeCmd.loading")}
						</div>
					)}
					{!loading && rows.length === 0 && (
						<div className="px-2 py-1 text-xs text-muted-foreground">
							{t("opencodeCmd.noSessions")}
						</div>
					)}
					{rows.map((row) => (
						<button
							key={row.sessionId}
							type="button"
							onClick={() => {
								onClose();
								navigate(`/sessions/${row.sessionId}`);
							}}
							className={`block w-full rounded px-2 py-1.5 text-left hover:bg-muted ${
								row.sessionId === currentSessionId ? "bg-primary/10" : ""
							}`}
						>
							<span className="mr-2">{row.displayName || row.sessionId.slice(0, 8)}</span>
							<span
								className={`ml-1 rounded px-1 text-[10px] ${
									row.controllable
										? "bg-emerald-500/15 text-emerald-400"
										: "bg-muted text-muted-foreground"
								}`}
							>
								{row.controllable === null
									? t("opencodeCmd.capUnknown")
									: row.controllable
										? t("opencodeCmd.controllable")
										: t("opencodeCmd.observeOnly")}
							</span>
							{row.sessionId === currentSessionId && (
								<span className="ml-1 text-[10px] text-muted-foreground">
									{t("opencodeCmd.current")}
								</span>
							)}
						</button>
					))}
				</div>
				<p className="mt-2 text-[11px] text-muted-foreground">{t("opencodeCmd.sessionNote")}</p>
			</div>
		</div>
	);
}
