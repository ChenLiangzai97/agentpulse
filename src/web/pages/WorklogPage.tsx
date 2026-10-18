import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	DEFAULT_WORKLOG_CONFIG,
	type WorklogConfig,
	type WorklogRun,
} from "../../shared/worklog.js";
import { MarkdownContent } from "../components/MarkdownContent.js";
import { api } from "../lib/api.js";
import { createStaleLoadGuard } from "../lib/latest-only.js";

export function WorklogPage() {
	const [config, setConfig] = useState<WorklogConfig>(DEFAULT_WORKLOG_CONFIG);
	const [runs, setRuns] = useState<WorklogRun[]>([]);
	const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
	const [date, setDate] = useState(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
	const [busy, setBusy] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [viewVersionId, setViewVersionId] = useState<string | null>(null);
	const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.getWorklogPreview>> | null>(
		null,
	);
	// Stale-response guard with DATE IDENTITY: a slow or late-completing
	// request issued for an earlier date must never overwrite the current
	// one — neither by resolving last, nor by an action started on the old
	// date finishing after the switch.
	const previewGuard = useMemo(() => createStaleLoadGuard(setPreview), []);
	const dateRef = useRef(date);
	dateRef.current = date;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const refresh = useCallback(() => api.getWorklogs().then((r) => setRuns(r.runs)), []);
	useEffect(() => {
		void api
			.getWorklogConfig()
			.then((r) => {
				setConfig(r.config);
				setLoaded(true);
			})
			.catch((e) => setError(e.message));
		void api
			.getAiProviders()
			.then((r) => setProviders(r.providers))
			.catch(() => {});
		void refresh().catch((e) => setError(e.message));
		const timer = setInterval(() => void refresh().catch(() => {}), 5000);
		return () => clearInterval(timer);
	}, [refresh]);
	const runAction = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		try {
			await fn();
			await refresh();
			// Identity-checked: if the user switched dates while this action
			// was running, the refresh targets the CURRENT date, and a
			// stale-date value can never land.
			void previewGuard.load(dateRef.current, () => api.getWorklogPreview(dateRef.current));
		} catch (e) {
			setError(e instanceof Error ? e.message : "操作失败");
		} finally {
			setBusy(false);
		}
	};
	const field = (key: keyof WorklogConfig, value: string | boolean) =>
		setConfig((s) => ({ ...s, [key]: value }));
	const current = runs.find((r) => `${r.timezone}/${r.date}` === selected) ?? runs[0];
	useEffect(() => {
		setPreview(null);
		previewGuard.setIdentity(date);
		void previewGuard.load(date, () => api.getWorklogPreview(date));
	}, [date, previewGuard]);
	return (
		<div className="mx-auto max-w-5xl space-y-6 p-6">
			<div>
				<h1 className="text-2xl font-semibold">每日工作日志</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					按会话中的实际对话整理完成事项、结论、问题与下一步。可在每个会话详情页调整纳入范围。
				</p>
			</div>
			{error && (
				<p role="alert" className="rounded border border-red-500 p-3 text-red-400">
					{error}
				</p>
			)}
			<fieldset
				disabled={!loaded || busy}
				className="grid gap-4 rounded-lg border border-border bg-card p-5 md:grid-cols-2"
			>
				<legend className="px-2 font-medium">定时汇总与文档接口</legend>
				<label className="flex items-center gap-2 md:col-span-2">
					<input
						type="checkbox"
						checked={config.enabled}
						onChange={(e) => field("enabled", e.target.checked)}
					/>
					开启自动总结并写入文档
				</label>
				<label>
					时区
					<input
						className="mt-1 w-full rounded border bg-background p-2"
						value={config.timezone}
						onChange={(e) => field("timezone", e.target.value)}
					/>
				</label>
				<label>
					每日执行时间
					<input
						type="time"
						className="mt-1 w-full rounded border bg-background p-2"
						value={config.time}
						onChange={(e) => field("time", e.target.value)}
					/>
					<span className="text-xs text-muted-foreground">
						汇总前一个完整自然日，默认次日 00:05。
					</span>
				</label>
				<label>
					模型服务
					<select
						className="mt-1 w-full rounded border bg-background p-2"
						value={config.providerId}
						onChange={(e) => field("providerId", e.target.value)}
					>
						<option value="">选择 Settings → AI 中配置的服务</option>
						{providers.map((p) => (
							<option value={p.id} key={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</label>
				<label>
					模型名称
					<input
						className="mt-1 w-full rounded border bg-background p-2"
						value={config.model}
						onChange={(e) => field("model", e.target.value)}
					/>
				</label>
				<label className="md:col-span-2">
					在线文档 HTTP 接口
					<input
						type="url"
						className="mt-1 w-full rounded border bg-background p-2"
						placeholder="https://example.com/worklog"
						value={config.documentUrl}
						onChange={(e) => field("documentUrl", e.target.value)}
					/>
				</label>
				<label>
					文档 ID
					<input
						className="mt-1 w-full rounded border bg-background p-2"
						value={config.documentId}
						onChange={(e) => field("documentId", e.target.value)}
					/>
				</label>
				<p className="text-xs text-muted-foreground">
					接口接收 Markdown、日期、会话列表与去重键。Bearer 密钥由服务端环境变量
					AGENTPULSE_WORKLOG_DOCUMENT_TOKEN 提供。接口应按去重键更新，避免重试生成重复段落。
				</p>
				<button
					type="button"
					className="rounded bg-primary px-4 py-2 text-primary-foreground md:col-span-2"
					onClick={() =>
						runAction(async () => {
							await api.saveWorklogConfig(config);
							toast.success("设置已保存");
						})
					}
				>
					保存设置
				</button>
			</fieldset>
			{preview && (
				<section className="rounded-lg border border-border bg-card p-4" aria-label="范围预览">
					<h2 className="font-medium">
						范围预览 · {preview.date}（{preview.timezone}）
					</h2>
					{preview.sessions.length ? (
						<table className="mt-2 w-full text-sm">
							<thead>
								<tr className="text-left text-muted-foreground">
									<th className="py-1">会话</th>
									<th>主机</th>
									<th>用户消息</th>
									<th>助手消息</th>
									<th>工具事件</th>
									<th>纳入</th>
								</tr>
							</thead>
							<tbody>
								{preview.sessions.map((row) => (
									<tr key={row.sessionId} className="border-t border-border">
										<td className="py-1">{row.name || row.sessionId}</td>
										<td>{row.host ?? "—"}</td>
										<td>{row.counts.prompt}</td>
										<td>{row.counts.assistant_message}</td>
										<td>{row.counts.tool_event}</td>
										<td>{row.included ? "是" : "否（已排除）"}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<p className="mt-2 text-sm text-muted-foreground">该日在时间窗内没有可纳入的会话。</p>
					)}
					<p className="mt-2 text-xs text-muted-foreground">
						排除在会话详情页"纳入每日工作日志"处调整；时间窗为该时区的完整自然日。
					</p>
				</section>
			)}
			<div className="flex flex-wrap gap-3">
				<input
					aria-label="日志日期"
					type="date"
					className="rounded border bg-background p-2"
					value={date}
					onChange={(e) => setDate(e.target.value)}
				/>
				<button
					type="button"
					disabled={busy || !loaded}
					className="rounded border px-3 py-2"
					onClick={() =>
						runAction(async () => {
							await api.runWorklog(date, false);
							toast.success("已排队生成，请在下方查看状态");
						})
					}
				>
					生成预览
				</button>
				<button
					type="button"
					disabled={busy || !loaded}
					className="rounded border px-3 py-2"
					onClick={() =>
						runAction(async () => {
							await api.runWorklog(date, true);
							toast.success("已排队写入文档");
						})
					}
				>
					生成并写入 / 重试
				</button>
			</div>
			<div className="grid gap-4 md:grid-cols-[200px_1fr]">
				<aside className="space-y-2">
					{runs.map((run) => (
						<button
							type="button"
							className="block w-full rounded border p-3 text-left text-sm"
							key={`${run.timezone}/${run.date}`}
							onClick={() => setSelected(`${run.timezone}/${run.date}`)}
						>
							{run.date}
							<br />
							{run.status} · {run.sessionIds.length} 个会话
						</button>
					))}
					{!runs.length && <p className="text-muted-foreground">尚无工作日志</p>}
				</aside>
				{current && (
					<article className="min-w-0 rounded border p-5">
						{current.error && (
							<p role="alert" className="mb-3 text-red-400">
								{current.error}
							</p>
						)}
						{current.status === "generating" && <p>正在总结会话，稍后自动刷新…</p>}
						{current.factMeta && (
							<p className="mb-3 text-xs text-muted-foreground">
								事实 {current.facts?.length ?? 0} 条 · 去重 {current.factMeta.deduped} ·
								无效引用丢弃 {current.factMeta.rejected} · 抽取模型 {current.factMeta.model}
							</p>
						)}
						{(current.versions?.length ?? 0) > 1 && (
							<div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="视图版本">
								{current.versions?.map((version) => (
									<button
										type="button"
										role="tab"
										aria-selected={
											(viewVersionId ?? current.adoptedVersionId) === version.versionId
										}
										key={version.versionId}
										className={`rounded border px-2 py-1 text-xs ${
											(viewVersionId ?? current.adoptedVersionId) === version.versionId
												? "border-primary bg-primary/10"
												: ""
										}`}
										onClick={() => setViewVersionId(version.versionId)}
									>
										{version.kind === "personal" ? "个人回顾" : "团队日报"}
										{version.generator.source === "manual" ? "（人工编辑）" : ""} ·{" "}
										{new Date(version.createdAt).toLocaleTimeString()}
										{current.adoptedVersionId === version.versionId ? " · 已采用" : ""}
									</button>
								))}
							</div>
						)}
						{editing ? (
							<div className="space-y-2">
								<textarea
									aria-label="编辑版本内容"
									className="min-h-72 w-full rounded border bg-background p-3 font-mono text-sm"
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
								/>
								<div className="flex gap-2">
									<button
										type="button"
										className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
										disabled={busy || !draft.trim()}
										onClick={() =>
											runAction(async () => {
												const baseId = viewVersionId ?? current.adoptedVersionId;
												if (!baseId) throw new Error("缺少基准版本");
												await api.editWorklogVersion(current.date, baseId, draft);
												setEditing(false);
												toast.success("已保存为人工编辑版本并采用");
											})
										}
									>
										保存为人工版本并采用
									</button>
									<button
										type="button"
										className="rounded border px-3 py-1 text-sm"
										onClick={() => setEditing(false)}
									>
										取消
									</button>
								</div>
							</div>
						) : (
							<>
								<MarkdownContent
									content={
										current.versions?.find(
											(v) => v.versionId === (viewVersionId ?? current.adoptedVersionId),
										)?.markdown ?? current.markdown
									}
								/>
								{viewVersionId && viewVersionId !== current.adoptedVersionId && (
									<VersionDiff
										from={
											current.versions?.find((v) => v.versionId === current.adoptedVersionId)
												?.markdown ?? ""
										}
										to={
											current.versions?.find((v) => v.versionId === viewVersionId)?.markdown ?? ""
										}
									/>
								)}
								{current.status !== "delivered" && current.status !== "generating" && (
									<button
										type="button"
										className="mt-4 rounded border px-3 py-1 text-sm"
										disabled={busy}
										onClick={() => {
											setDraft(
												current.versions?.find(
													(v) => v.versionId === (viewVersionId ?? current.adoptedVersionId),
												)?.markdown ?? current.markdown,
											);
											setEditing(true);
										}}
									>
										编辑此版本（保存为人工版本）
									</button>
								)}
							</>
						)}
						{current.status !== "delivered" &&
							current.status !== "generating" &&
							viewVersionId &&
							viewVersionId !== current.adoptedVersionId && (
								<button
									type="button"
									className="mt-4 rounded border px-3 py-1 text-sm"
									disabled={busy}
									onClick={() =>
										runAction(async () => {
											await api.adoptWorklogVersion(current.date, viewVersionId);
											toast.success("已采用该版本用于导出");
										})
									}
								>
									采用此版本用于导出
								</button>
							)}
						{current.status !== "delivered" && current.status !== "generating" && (
							<button
								type="button"
								className="mt-4 rounded border px-3 py-1 text-sm"
								disabled={busy}
								onClick={() => runAction(() => api.discardWorklog(current.date))}
							>
								删除草稿以重新生成
							</button>
						)}
					</article>
				)}
			</div>
		</div>
	);
}

/** Simple line diff between the adopted version and the one being previewed. */
function VersionDiff({ from, to }: { from: string; to: string }) {
	const fromLines = from.split("\n");
	const toLines = to.split("\n");
	if (fromLines.length > 400 || toLines.length > 400)
		return (
			<p className="mt-4 text-xs text-muted-foreground">
				版本差异过大（超过 400 行），请直接对比内容后再采用。
			</p>
		);
	// LCS table (bounded by the 400-line cap above).
	const table: number[][] = Array.from({ length: fromLines.length + 1 }, () =>
		new Array<number>(toLines.length + 1).fill(0),
	);
	for (let i = fromLines.length - 1; i >= 0; i--)
		for (let j = toLines.length - 1; j >= 0; j--)
			table[i][j] =
				fromLines[i] === toLines[j]
					? table[i + 1][j + 1] + 1
					: Math.max(table[i + 1][j], table[i][j + 1]);
	const rows: Array<{ sign: "-" | "+"; text: string }> = [];
	let i = 0;
	let j = 0;
	while (i < fromLines.length && j < toLines.length) {
		if (fromLines[i] === toLines[j]) {
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			rows.push({ sign: "-", text: fromLines[i] });
			i++;
		} else {
			rows.push({ sign: "+", text: toLines[j] });
			j++;
		}
	}
	while (i < fromLines.length) rows.push({ sign: "-", text: fromLines[i++] });
	while (j < toLines.length) rows.push({ sign: "+", text: toLines[j++] });
	if (!rows.length) return null;
	return (
		<div className="mt-4" aria-label="与采用版本的差异">
			<h3 className="text-sm font-medium">与当前采用版本的差异</h3>
			<pre className="mt-1 max-h-72 overflow-auto rounded border bg-background p-2 text-xs leading-5">
				{rows.map((row, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static diff rows
					<div key={index} className={row.sign === "-" ? "text-red-400" : "text-green-500"}>
						{row.sign} {row.text}
					</div>
				))}
			</pre>
		</div>
	);
}
