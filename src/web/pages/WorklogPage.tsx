import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	DEFAULT_WORKLOG_CONFIG,
	type WorklogConfig,
	type WorklogRun,
} from "../../shared/worklog.js";
import { MarkdownContent } from "../components/MarkdownContent.js";
import { api } from "../lib/api.js";

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
		} catch (e) {
			setError(e instanceof Error ? e.message : "操作失败");
		} finally {
			setBusy(false);
		}
	};
	const field = (key: keyof WorklogConfig, value: string | boolean) =>
		setConfig((s) => ({ ...s, [key]: value }));
	const current = runs.find((r) => `${r.timezone}/${r.date}` === selected) ?? runs[0];
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
						<MarkdownContent
							content={
								current.versions?.find(
									(v) => v.versionId === (viewVersionId ?? current.adoptedVersionId),
								)?.markdown ?? current.markdown
							}
						/>
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
