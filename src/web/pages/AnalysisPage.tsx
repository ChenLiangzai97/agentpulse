import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type {
	AnalysisPreview,
	AnalysisRunView,
	AnalysisSessionScope,
} from "../../shared/analysis-report.js";
import type { Session } from "../../shared/types.js";
import { LabsBadge } from "../components/LabsBadge.js";
import { SkeletonCard } from "../components/SkeletonCard.js";
import { useT } from "../i18n/i18n.js";
import { plainErrorMessage } from "../lib/api-errors.js";
import { api } from "../lib/api.js";
import { formatTimeAgo } from "../lib/utils.js";

const POLL_INTERVAL_MS = 2000;

function Chip({
	children,
	tone = "default",
	title,
}: {
	children: React.ReactNode;
	tone?: "default" | "warn" | "danger" | "ok" | "info";
	title?: string;
}) {
	const tones: Record<string, string> = {
		default: "border-border text-muted-foreground bg-background/40",
		warn: "border-amber-500/40 text-amber-300 bg-amber-500/10",
		danger: "border-red-500/40 text-red-300 bg-red-500/10",
		ok: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
		info: "border-cyan-500/40 text-cyan-300 bg-cyan-500/10",
	};
	return (
		<span
			title={title}
			className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] ${tones[tone]}`}
		>
			{children}
		</span>
	);
}

function statusTone(status: string): "default" | "warn" | "ok" | "danger" | "info" {
	if (status === "succeeded") return "ok";
	if (status === "failed") return "danger";
	if (status === "running") return "info";
	if (status === "queued") return "warn";
	return "default";
}

const VERIFICATION_LABEL: Record<string, { label: string; tone: "ok" | "warn" | "info" }> = {
	record_verified: { label: "verified in records", tone: "ok" },
	agent_claimed: { label: "agent claimed", tone: "warn" },
	awaiting_acceptance: { label: "awaiting acceptance", tone: "info" },
};

/** S<index> resolves through the run's frozen scope: the included sessions, in frozen order, are S1..Sn. */
function evidenceSessionId(run: AnalysisRunView, id: string): string | null {
	const match = /^S(\d+)E\d+$/.exec(id);
	if (!match) return null;
	const index = Number(match[1]);
	const included = (run.coverage?.sessions ?? []).filter((s) => s.included);
	return included[index - 1]?.sessionId ?? null;
}

function EvidenceChips({ run, evidence }: { run: AnalysisRunView; evidence: string[] }) {
	if (evidence.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1 mt-1">
			{evidence.map((id) => {
				const sessionId = evidenceSessionId(run, id);
				return sessionId ? (
					<Link
						key={id}
						to={`/sessions/${sessionId}?tab=activity`}
						className="font-mono text-[10px] text-primary hover:underline"
						title={`Open the cited evidence in ${sessionId}`}
					>
						{id}
					</Link>
				) : (
					<span key={id} className="font-mono text-[10px] text-muted-foreground">
						{id}
					</span>
				);
			})}
		</div>
	);
}

function ReportBody({ run }: { run: AnalysisRunView }) {
	const report = run.report;
	if (!report) return null;
	const section = (title: string, count: number, children: React.ReactNode) =>
		count > 0 ? (
			<section className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					{title} ({count})
				</h3>
				{children}
			</section>
		) : null;
	return (
		<div className="space-y-4">
			<p className="text-sm text-foreground/90 whitespace-pre-wrap">{report.overview}</p>
			{section(
				"Accomplishments",
				report.accomplishments.length,
				<div className="space-y-2">
					{report.accomplishments.map((item, i) => {
						const v = VERIFICATION_LABEL[item.verification] ?? VERIFICATION_LABEL.agent_claimed;
						return (
							<div key={i} className="rounded border border-border bg-background/40 p-2 text-xs">
								<div className="flex items-start justify-between gap-2">
									<span>{item.summary}</span>
									<Chip tone={v.tone}>{v.label}</Chip>
								</div>
								{item.detail && (
									<p className="mt-1 text-muted-foreground whitespace-pre-wrap">{item.detail}</p>
								)}
								<EvidenceChips run={run} evidence={item.evidence} />
							</div>
						);
					})}
				</div>,
			)}
			{section(
				"Validations",
				report.validations.length,
				<div className="space-y-2">
					{report.validations.map((item, i) => (
						<div key={i} className="rounded border border-border bg-background/40 p-2 text-xs">
							<div className="flex items-start justify-between gap-2">
								<span>{item.summary}</span>
								<Chip
									tone={
										item.outcome === "passed"
											? "ok"
											: item.outcome === "failed"
												? "danger"
												: "default"
									}
								>
									{item.outcome}
								</Chip>
							</div>
							{item.detail && (
								<p className="mt-1 text-muted-foreground whitespace-pre-wrap">{item.detail}</p>
							)}
							<EvidenceChips run={run} evidence={item.evidence} />
						</div>
					))}
				</div>,
			)}
			{section(
				"Unfinished",
				report.unfinished.length,
				<div className="space-y-2">
					{report.unfinished.map((item, i) => (
						<div key={i} className="rounded border border-border bg-background/40 p-2 text-xs">
							<span>{item.summary}</span>
							{item.detail && (
								<p className="mt-1 text-muted-foreground whitespace-pre-wrap">{item.detail}</p>
							)}
							<EvidenceChips run={run} evidence={item.evidence} />
						</div>
					))}
				</div>,
			)}
			{section(
				"Decisions",
				report.decisions.length,
				<div className="space-y-2">
					{report.decisions.map((item, i) => (
						<div key={i} className="rounded border border-border bg-background/40 p-2 text-xs">
							<span>{item.summary}</span>
							{item.detail && (
								<p className="mt-1 text-muted-foreground whitespace-pre-wrap">{item.detail}</p>
							)}
							<EvidenceChips run={run} evidence={item.evidence} />
						</div>
					))}
				</div>,
			)}
		</div>
	);
}

function CoverageBlock({ run }: { run: AnalysisRunView }) {
	const t = useT();
	const coverage = run.coverage;
	if (!coverage) return null;
	const excluded = coverage.sessions.filter((s) => !s.included);
	return (
		<details className="group rounded-lg border border-border bg-card">
			<summary className="cursor-pointer select-none list-none px-4 py-2 text-xs text-muted-foreground flex items-center justify-between">
				<span>
					Input coverage — {coverage.sessions.filter((s) => s.included).length} of{" "}
					{coverage.sessions.length} sessions, {coverage.hosts.length} machine(s)
					{coverage.coveredFrom
						? `, ${coverage.coveredFrom.slice(0, 10)} .. ${coverage.coveredTo?.slice(0, 10)}`
						: ""}
				</span>
				<span className="transition-transform group-open:rotate-90 text-[10px]">›</span>
			</summary>
			<div className="px-4 pb-3 space-y-2 text-xs">
				<div className="flex flex-wrap gap-2">
					{coverage.hosts.map((h) => (
						<Chip
							key={h.host}
							tone="info"
							title={`Last covered activity: ${h.lastActivityAt ?? "n/a"}`}
						>
							{h.host}: {h.sessions}
						</Chip>
					))}
				</div>
				{excluded.length > 0 && (
					<p className="text-amber-300">
						Excluded at run time: {excluded.map((s) => `${s.label} (${s.exclusion})`).join(", ")}.
						Coverage below reflects only what was actually analyzed.
					</p>
				)}
				<table className="w-full text-left">
					<thead className="text-muted-foreground">
						<tr>
							<th className="pr-2 font-normal">{t("analysis.session")}</th>
							<th className="pr-2 font-normal">{t("analysis.machine")}</th>
							<th className="pr-2 font-normal">{t("analysis.eventsRead")}</th>
							<th className="pr-2 font-normal">{t("analysis.covered")}</th>
							<th className="font-normal">{t("analysis.state")}</th>
						</tr>
					</thead>
					<tbody className="font-mono text-[10px]">
						{coverage.sessions.map((s) => (
							<tr key={s.sessionId} className="border-t border-border/50">
								<td className="pr-2 py-0.5">
									<Link to={`/sessions/${s.sessionId}`} className="text-primary hover:underline">
										{s.label}
									</Link>
								</td>
								<td className="pr-2 py-0.5">{s.host ?? "unknown"}</td>
								<td className="pr-2 py-0.5">
									{s.included ? `${s.eventsRead} (as ${s.eventsRepresented} lines)` : "—"}
								</td>
								<td className="pr-2 py-0.5">
									{s.firstEventAt
										? `${s.firstEventAt.slice(0, 10)} .. ${s.lastEventAt?.slice(0, 10)}`
										: "—"}
								</td>
								<td className="py-0.5">
									{s.included ? (
										<Chip tone="ok">{t("analysis.included")}</Chip>
									) : (
										<Chip tone="warn">{s.exclusion}</Chip>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</details>
	);
}

function RunRow({
	run,
	detail,
	onSelect,
	onCancel,
}: {
	run: AnalysisRunView;
	detail: AnalysisRunView | null;
	onSelect: (id: string) => void;
	onCancel: (id: string) => void;
}) {
	return (
		<li className="rounded-lg border border-border bg-card">
			<button
				type="button"
				onClick={() => onSelect(run.id)}
				className="w-full text-left px-4 py-3 flex items-center gap-3"
			>
				<Chip tone={statusTone(run.status)}>{run.status}</Chip>
				<span className="text-xs">
					{run.scope.length} session{run.scope.length === 1 ? "" : "s"} ·{" "}
					{new Set(run.scope.map((s: AnalysisSessionScope) => s.host ?? "unknown")).size} machine(s)
				</span>
				{run.timeFrom && (
					<span className="text-[10px] text-muted-foreground font-mono">
						{run.timeFrom.slice(0, 10)} → {run.timeTo?.slice(0, 10) ?? "now"}
					</span>
				)}
				{run.errorCode && <Chip tone="danger">{run.errorCode}</Chip>}
				<span className="ml-auto text-[10px] text-muted-foreground">
					{formatTimeAgo(run.createdAt)}
				</span>
			</button>
			{run.status === "queued" && (
				<div className="px-4 pb-2">
					<button
						type="button"
						onClick={() => onCancel(run.id)}
						className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-red-300 hover:border-red-500/40 transition-colors"
					>
						Cancel
					</button>
				</div>
			)}
			{detail && (
				<div className="px-4 pb-4 pt-1 space-y-3 border-t border-border/60">
					<CoverageBlock run={detail} />
					<ReportBody run={detail} />
					{detail.provenance && (
						<p className="text-[10px] text-muted-foreground font-mono">
							{detail.provenance.provider.kind}/{detail.provenance.provider.model} ·{" "}
							{detail.provenance.calls} call(s) · {detail.provenance.inputTokens}→
							{detail.provenance.outputTokens} tok · {detail.provenance.costCents}¢
							{detail.provenance.suspectReasons.length > 0 &&
								` · suspect: ${detail.provenance.suspectReasons.join(", ")}`}
						</p>
					)}
				</div>
			)}
		</li>
	);
}

/**
 * AGEN-70: cross-session, cross-machine work reports over the sessions the
 * user marked "Include in analysis". Only selected sessions reach the model;
 * every report carries its input coverage.
 */
export function AnalysisPage() {
	const t = useT();
	const [candidates, setCandidates] = useState<Session[]>([]);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [preview, setPreview] = useState<AnalysisPreview | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [runs, setRuns] = useState<AnalysisRunView[]>([]);
	const [detailById, setDetailById] = useState<Map<string, AnalysisRunView>>(new Map());
	const [openRunId, setOpenRunId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const loadRuns = useCallback(async () => {
		try {
			const data = await api.getAnalysisRuns();
			setRuns(data.runs);
		} catch (err) {
			setError(plainErrorMessage(err));
		}
	}, []);

	const loadCandidates = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await api.getAnalysisCandidateSessions();
			setCandidates(data.sessions);
		} catch (err) {
			setError(plainErrorMessage(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadCandidates();
		void loadRuns();
	}, [loadCandidates, loadRuns]);

	const active = useMemo(
		() => runs.some((r) => r.status === "queued" || r.status === "running"),
		[runs],
	);

	useEffect(() => {
		if (!active) {
			if (pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
			return;
		}
		if (pollRef.current) return;
		pollRef.current = setInterval(() => {
			void loadRuns();
		}, POLL_INTERVAL_MS);
		return () => {
			if (pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
		};
	}, [active, loadRuns]);

	const toggleSession = (sessionId: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(sessionId)) next.delete(sessionId);
			else next.add(sessionId);
			return next;
		});
		setPreview(null);
	};

	const timeBody = () => ({
		sessionIds: [...selectedIds],
		...(from ? { from: new Date(from).toISOString() } : {}),
		...(to ? { to: new Date(to).toISOString() } : {}),
	});

	const runPreview = async () => {
		setPreviewing(true);
		try {
			const result = await api.previewAnalysis(timeBody());
			if ("error" in result) {
				toast.error(`Preview failed: ${result.error}`);
				return;
			}
			setPreview(result);
		} catch (err) {
			toast.error(plainErrorMessage(err));
		} finally {
			setPreviewing(false);
		}
	};

	const createRun = async () => {
		setCreating(true);
		try {
			const result = await api.createAnalysisRun(timeBody());
			if ("error" in result) {
				if (result.error === "not_selected" && result.sessionIds?.length) {
					toast.error(
						`${result.sessionIds.length} session(s) are no longer marked for analysis. Re-select them on a session card first.`,
					);
				} else {
					toast.error(`Report refused: ${result.error}`);
				}
				return;
			}
			toast.success(t("analysis.queuedToast"));
			setSelectedIds(new Set());
			setPreview(null);
			await loadRuns();
		} catch (err) {
			toast.error(plainErrorMessage(err));
		} finally {
			setCreating(false);
		}
	};

	const cancelRun = async (id: string) => {
		try {
			await api.cancelAnalysisRun(id);
			await loadRuns();
		} catch (err) {
			toast.error(plainErrorMessage(err));
		}
	};

	const selectRun = async (id: string) => {
		if (openRunId === id) {
			setOpenRunId(null);
			return;
		}
		setOpenRunId(id);
		if (!detailById.has(id)) {
			try {
				const detail = await api.getAnalysisRun(id);
				setDetailById((prev) => new Map(prev).set(id, detail));
			} catch (err) {
				toast.error(plainErrorMessage(err));
			}
		}
	};

	const selectedCount = selectedIds.size;

	return (
		<div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
			<header className="flex items-center justify-between gap-2">
				<div>
					<div className="flex items-center gap-2">
						<h1 className="text-xl font-semibold">{t("analysis.title")}</h1>
						<LabsBadge />
					</div>
					<p className="text-xs text-muted-foreground">{t("analysis.subtitle")}</p>
				</div>
				<button
					type="button"
					onClick={() => {
						void loadCandidates();
						void loadRuns();
					}}
					className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-muted transition-colors"
				>
					Refresh
				</button>
			</header>

			{error && (
				<div className="rounded border border-red-500/30 bg-red-500/10 text-red-300 p-3 text-xs">
					{error}
				</div>
			)}

			<section className="rounded-lg border border-border bg-card p-4 space-y-3">
				<h2 className="text-sm font-semibold">{t("analysis.newReport")}</h2>
				{loading ? (
					<SkeletonCard />
				) : candidates.length === 0 ? (
					<p className="text-xs text-muted-foreground">{t("analysis.noCandidates")}</p>
				) : (
					<>
						<div className="max-h-56 overflow-y-auto rounded border border-border divide-y divide-border/50">
							{candidates.map((s) => (
								<label
									key={s.sessionId}
									className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-muted/40"
								>
									<input
										type="checkbox"
										checked={selectedIds.has(s.sessionId)}
										onChange={() => toggleSession(s.sessionId)}
										className="h-3.5 w-3.5 rounded border-input bg-background text-primary focus:ring-1 focus:ring-ring"
									/>
									<span className="truncate">{s.displayName || s.sessionId}</span>
									<Chip>{s.agentType}</Chip>
									{s.machine && <Chip title="Machine">{s.machine}</Chip>}
									<span className="ml-auto text-[10px] text-muted-foreground">
										{formatTimeAgo(s.lastActivityAt)}
									</span>
								</label>
							))}
						</div>
						<div className="flex flex-wrap items-center gap-2 text-xs">
							<label className="flex items-center gap-1">
								<span className="text-muted-foreground">{t("analysis.from")}</span>
								<input
									type="datetime-local"
									value={from}
									onChange={(e) => {
										setFrom(e.target.value);
										setPreview(null);
									}}
									className="rounded border border-border bg-background px-2 py-1 text-xs"
								/>
							</label>
							<label className="flex items-center gap-1">
								<span className="text-muted-foreground">{t("analysis.to")}</span>
								<input
									type="datetime-local"
									value={to}
									onChange={(e) => {
										setTo(e.target.value);
										setPreview(null);
									}}
									className="rounded border border-border bg-background px-2 py-1 text-xs"
								/>
							</label>
							<button
								type="button"
								disabled={selectedCount === 0 || previewing}
								onClick={() => void runPreview()}
								className="px-3 py-1 rounded border border-border bg-background hover:bg-muted disabled:opacity-50 transition-colors"
							>
								{previewing ? "Checking…" : "Preview coverage"}
							</button>
							<button
								type="button"
								disabled={selectedCount === 0 || creating}
								onClick={() => void createRun()}
								className="px-3 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-colors"
							>
								{creating ? "Queueing…" : `Generate report (${selectedCount})`}
							</button>
						</div>
						{preview && (
							<div className="rounded border border-border bg-background/40 p-3 text-xs space-y-1">
								<p>
									<strong>{preview.sessions.length}</strong> session(s) across{" "}
									<strong>{preview.hosts.length}</strong> machine(s)
									{preview.coveredFrom && (
										<>
											, covered <span className="font-mono">{preview.coveredFrom}</span> →{" "}
											<span className="font-mono">{preview.coveredTo}</span>
										</>
									)}
									.
								</p>
								<div className="flex flex-wrap gap-1">
									{preview.sessions.map((s) => (
										<Chip
											key={s.sessionId}
											tone={s.eventsInRange > 0 ? "default" : "warn"}
											title={`${s.eventsInRange} event(s) in range${s.host ? ` on ${s.host}` : ""}`}
										>
											{s.label}: {s.eventsInRange}
										</Chip>
									))}
								</div>
								{preview.unselectedSessionIds.length > 0 && (
									<p className="text-amber-300">
										{preview.unselectedSessionIds.length} picked session(s) are not marked “Include
										in analysis” and will be refused at generation.
									</p>
								)}
								{preview.sessions.some((s) => s.eventsInRange === 0) && (
									<p className="text-amber-300">{t("analysis.noEventsWarn")}</p>
								)}
							</div>
						)}
					</>
				)}
			</section>

			<section className="space-y-2">
				<h2 className="text-sm font-semibold">{t("analysis.recentReports")}</h2>
				{runs.length === 0 ? (
					<p className="text-xs text-muted-foreground">{t("analysis.noReports")}</p>
				) : (
					<ul className="space-y-2">
						{runs.map((run) => (
							<RunRow
								key={run.id}
								run={run}
								detail={openRunId === run.id ? (detailById.get(run.id) ?? null) : null}
								onSelect={(id) => void selectRun(id)}
								onCancel={(id) => void cancelRun(id)}
							/>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
