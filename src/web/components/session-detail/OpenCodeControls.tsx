import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Session } from "../../../shared/types.js";
import { api } from "../../lib/api.js";

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
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void send({ kind: "prompt", prompt });
				}}
			>
				<textarea
					aria-label="OpenCode 消息"
					className="min-h-20 flex-1 rounded border bg-background p-2 text-sm"
					maxLength={12000}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
				/>
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
