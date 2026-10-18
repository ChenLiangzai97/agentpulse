import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { Session } from "../../../shared/types.js";
import { api } from "../../lib/api.js";
import { scopedQuery } from "../../lib/scoped-query.js";

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
							aria-label={`自由回答 ${index + 1}`}
							value={custom[index]}
							placeholder="自由回答"
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
				提交回答
			</button>
		</div>
	);
}
export function OpenCodeControls({
	session,
	onChanged,
}: { session: Session; onChanged: () => Promise<void> }) {
	const [cap, setCap] = useState<Session["controlCapabilities"]>();
	const [items, setItems] = useState<Interaction[]>([]);
	const [prompt, setPrompt] = useState("");
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
					setError("控制状态暂不可用");
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
	async function send(body: Record<string, unknown>) {
		setBusy(true);
		try {
			await api.openCodeAction(session.sessionId, body);
			if (body.kind === "prompt") setPrompt("");
			if (body.interactionId)
				setItems((old) => old.filter((item) => item.id !== body.interactionId));
			await onChanged();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "控制失败");
		} finally {
			setBusy(false);
		}
	}
	if (!cap?.send) {
		if (!error && (!cap || cap.origin !== "agentpulse_launch")) return null;
		return (
			<section className="border-b border-border px-3 py-3 text-sm text-muted-foreground">
				{error ??
					(cap?.reason === "not_owner"
						? "你没有控制此会话的权限。"
						: "受管实例已停止或中断；旧审批已失效，消息不会自动重投。")}
			</section>
		);
	}

	return (
		<section className="space-y-3 border-b border-border px-3 py-3 md:px-6">
			<div className="flex gap-3 items-center text-sm">
				<strong>OpenCode · AgentPulse 受管实例</strong>
				<button
					type="button"
					disabled={busy}
					className="rounded border px-3 py-1"
					onClick={() => void send({ kind: "interrupt" })}
				>
					中止当前轮
				</button>
				<button
					type="button"
					disabled={busy}
					className="rounded border px-3 py-1"
					onClick={() => void send({ kind: "stop" })}
				>
					停止实例
				</button>
			</div>
			{items.map((item) => (
				<div
					key={`${item.id}-${item.revision}`}
					className="space-y-3 rounded border border-amber-500/40 p-3 text-sm"
				>
					<strong>{item.kind === "permission" ? "权限请求（仅本次）" : "Agent 提问"}</strong>
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
								允许本次
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
						拒绝
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
				<SessionPicker currentSessionId={session.sessionId} onClose={() => setSessionPickerOpen(false)} />
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
					const [providerID, ...rest] = (pendingModel ?? "").split("/");
				void send({
					kind: "prompt",
					prompt,
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
									/model → {pendingModel}
								</button>
							)}
							{pendingAgent && (
								<button
									type="button"
									className="rounded bg-muted px-1.5 py-0.5"
									onClick={() => setAgentPickerOpen(true)}
								>
									/agent → {pendingAgent}
								</button>
							)}
						</div>
					)}
					<textarea
						aria-label="OpenCode 消息"
						className="min-h-20 w-full rounded border bg-background p-2 text-sm"
						maxLength={12000}
						value={prompt}
						onChange={(e) => {
							setPrompt(e.target.value);
							setCommandMenuOpen(e.target.value.startsWith("/") && !e.target.value.includes(" "));
						}}
					/>
					{prompt.startsWith("/") && !prompt.includes(" ") && (
						<p className="mt-1 text-[11px] text-amber-400">
							输入 / 打开命令菜单；直接发送未知命令不会被发出。
						</p>
					)}
				</div>
				<button type="submit" disabled={busy || !prompt.trim()} className="rounded border px-3">
					发送
				</button>
			</form>
			<p className="text-xs text-muted-foreground">
				空闲不代表任务完成。发送结果不确定时不会自动重试；请先核对时间线。
			</p>
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
					<strong className="text-sm">/ 命令</strong>
					<button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
						关闭
					</button>
				</div>
				<div className="max-h-72 space-y-1 overflow-y-auto text-sm">
					<button
						type="button"
						onClick={onPickSession}
						className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
					>
						/session <span className="text-muted-foreground">切换到其他会话（仅导航）</span>
					</button>
					<button
						type="button"
						onClick={onPickModel}
						className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
					>
						/model{" "}
						<span className="text-muted-foreground">
							切换模型{pendingModel ? `（当前待生效：${pendingModel}）` : ""}
						</span>
					</button>
					<button
						type="button"
						onClick={onPickAgent}
						className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
					>
						/agent{" "}
						<span className="text-muted-foreground">
							切换 Agent{pendingAgent ? `（当前待生效：${pendingAgent}）` : ""}
						</span>
					</button>
					<div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
						原生命令（在实例内执行）
					</div>
					{commands.length === 0 && (
						<div className="px-2 py-1 text-xs text-muted-foreground">实例未返回自定义命令</div>
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
						说明
					</div>
					<div className="px-2 pb-1 text-xs text-muted-foreground">
						网页端支持：/session、/model、/agent、上方列出的实例原生命令。/new 请用页顶"新建会话"；/share
						未开放；skills 与其余 TUI 命令暂不开放网页执行。
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
					<strong className="text-sm">/model — 选择模型</strong>
					<button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
						关闭
					</button>
				</div>
				<div className="max-h-72 space-y-1 overflow-y-auto text-sm">
					{entries.length === 0 && (
						<div className="px-2 py-1 text-xs text-muted-foreground">
							主机 profile 未返回模型列表；将沿用会话当前模型。
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
							恢复会话默认模型（清除待生效选择）
						</button>
					)}
				</div>
				<p className="mt-2 text-[11px] text-muted-foreground">
					选择本身不调用模型；仅随你的下一条真实消息显式发送并生效（发送即产生正常推理）。选择已本地保存，刷新后仍保留。
				</p>
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
	const agents = catalog?.agents ?? [];
	return (
		<div
			className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-4 pt-20"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div className="w-full max-w-md rounded-lg border border-border bg-card p-3 shadow-xl">
				<div className="mb-2 flex items-center justify-between">
					<strong className="text-sm">/agent — 选择 Agent</strong>
					<button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
						关闭
					</button>
				</div>
				<div className="max-h-72 space-y-1 overflow-y-auto text-sm">
					{agents.length === 0 && (
						<div className="px-2 py-1 text-xs text-muted-foreground">实例未返回 Agent 列表。</div>
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
							恢复默认 Agent（清除待生效选择）
						</button>
					)}
				</div>
				<p className="mt-2 text-[11px] text-muted-foreground">
					选择本身不调用模型；随你的后续消息显式携带生效，已本地保存。
				</p>
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
	const [rows, setRows] = useState<
		{ sessionId: string; displayName: string | null; status: string; controllable: boolean | null }[]
	>([]);
	const [loading, setLoading] = useState(true);
	const navigate = useNavigate();
	useEffect(() => {
		let active = true;
		void api
			.getSessions(scopedQuery({ owner: "all", excludeScratch: false }, { agent_type: "opencode", limit: 30 }))
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
					<strong className="text-sm">/session — 切换会话</strong>
					<button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
						关闭
					</button>
				</div>
				<div className="max-h-80 space-y-1 overflow-y-auto text-sm">
					{loading && <div className="px-2 py-1 text-xs text-muted-foreground">加载中…</div>}
					{!loading && rows.length === 0 && (
						<div className="px-2 py-1 text-xs text-muted-foreground">暂无 OpenCode 会话</div>
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
								{row.controllable === null ? "状态未知" : row.controllable ? "可控" : "仅观察"}
							</span>
							{row.sessionId === currentSessionId && (
								<span className="ml-1 text-[10px] text-muted-foreground">当前</span>
							)}
						</button>
					))}
				</div>
				<p className="mt-2 text-[11px] text-muted-foreground">
					仅切换页面视图；不执行任何模型命令，也不改变会话来源与控制权。
				</p>
			</div>
		</div>
	);
}
