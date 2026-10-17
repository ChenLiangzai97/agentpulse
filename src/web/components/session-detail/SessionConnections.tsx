import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Session, SessionEvent, SupervisorRecord } from "../../../shared/types.js";
import { api } from "../../lib/api.js";

export function SessionConnections({
	session,
	onChanged,
}: { session: Session; onChanged: () => Promise<void> }) {
	const [hosts, setHosts] = useState<SupervisorRecord[]>([]);
	const [hostId, setHostId] = useState("");
	const [included, setIncluded] = useState<boolean | null>(null);
	const [approvals, setApprovals] = useState<SessionEvent[]>([]);
	const [busy, setBusy] = useState(false);
	const [submitted, setSubmitted] = useState<Set<string>>(new Set());
	useEffect(() => {
		let active = true;
		setIncluded(null);
		setSubmitted(new Set());
		setHostId("");
		void api
			.getWorklogIncluded(session.sessionId)
			.then((r) => {
				if (active) setIncluded(r.included);
			})
			.catch(() => {});
		void api
			.getSupervisors()
			.then((r) => {
				if (active) setHosts(r.supervisors);
			})
			.catch(() => {});
		const poll = () =>
			api
				.getNativeApprovals(session.sessionId)
				.then((r) => {
					if (active) setApprovals(r.approvals);
				})
				.catch(() => {});
		void poll();
		const timer = setInterval(() => void poll(), 3000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [session.sessionId]);
	async function action(run: () => Promise<unknown>) {
		setBusy(true);
		try {
			await run();
			await onChanged();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Action failed");
		} finally {
			setBusy(false);
		}
	}
	const launchable = session.agentType === "codex_cli" || session.agentType === "claude_code";
	return (
		<section className="space-y-3 border-b border-border px-3 py-3 md:px-6">
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<span className="font-medium">会话连接</span>
				{session.managedSession ? (
					<>
						<span className="text-muted-foreground">
							{session.machine} · {session.managedSession.managedState}
						</span>
						{launchable && (
							<button
								type="button"
								className="rounded border px-3 py-1"
								disabled={busy}
								onClick={() => action(() => api.recoverSession(session.sessionId))}
							>
								恢复原会话
							</button>
						)}
					</>
				) : launchable ? (
					<>
						<select
							aria-label="选择会话所在主机"
							className="rounded border bg-background p-1"
							value={hostId}
							onChange={(e) => setHostId(e.target.value)}
						>
							<option value="">选择会话所在主机</option>
							{hosts
								.filter((h) => !session.machine || h.hostName === session.machine)
								.map((h) => (
									<option key={h.id} value={h.id}>
										{h.hostName} · {h.status}
									</option>
								))}
						</select>
						<button
							type="button"
							disabled={busy || !hostId}
							className="rounded border px-3 py-1"
							onClick={() =>
								action(async () => {
									await api.bindSession(session.sessionId, hostId);
									await api.recoverSession(session.sessionId);
								})
							}
						>
							绑定并恢复
						</button>
					</>
				) : (
					<span>该 Agent 暂时仅支持观察</span>
				)}
				<label className="ml-auto flex items-center gap-2">
					<input
						type="checkbox"
						checked={included === true}
						disabled={busy || included === null}
						onChange={(e) => {
							const value = e.target.checked;
							void action(async () => {
								await api.setWorklogIncluded(session.sessionId, value);
								setIncluded(value);
							});
						}}
					/>
					纳入每日工作日志
				</label>
			</div>
			{!session.managedSession && launchable && (
				<p className="text-xs text-muted-foreground">
					绑定前请先停止原终端中的任务，避免两个控制端同时操作同一会话。主机需运行
					Supervisor，工作目录需位于 trustedRoots 内。
				</p>
			)}
			{(launchable ? approvals : []).map((event) => {
				const id = String(event.rawPayload.approvalId);
				const expired = Date.parse(String(event.rawPayload.expiresAt)) < Date.now();
				return (
					<div key={id} className="rounded border border-amber-600 bg-amber-950/20 p-3 text-sm">
						<div className="font-semibold">Agent 审批请求 · {session.machine}</div>
						<p className="my-2 whitespace-pre-wrap">{event.content}</p>
						<pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
							{JSON.stringify(event.rawPayload.params, null, 2)}
						</pre>
						<div className="mt-3 flex gap-2">
							{(
								[
									["accept", "批准本次"],
									["decline", "拒绝"],
									["cancel", "取消"],
								] as const
							).map(([decision, label]) => (
								<button
									type="button"
									key={decision}
									className="rounded border px-3 py-1 disabled:opacity-50"
									disabled={busy || expired || submitted.has(id)}
									onClick={() =>
										action(async () => {
											await api.respondNativeApproval(session.sessionId, id, decision);
											setSubmitted((s) => new Set([...s, id]));
										})
									}
								>
									{label}
								</button>
							))}
						</div>
						{expired ? (
							<p>请求已过期</p>
						) : submitted.has(id) ? (
							<p>决定已提交，等待主机确认；执行结果见控制记录。</p>
						) : null}
					</div>
				);
			})}
		</section>
	);
}
