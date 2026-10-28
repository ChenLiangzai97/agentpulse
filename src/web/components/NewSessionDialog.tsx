import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { defaultLaunchModeForAgent } from "./templates/utils.js";
import { api } from "../lib/api.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useT } from "../i18n/i18n.js";
import type { LaunchableAgentType } from "../../shared/types.js";
import type { Project } from "../../shared/types.js";
import type { SupervisorRecord } from "../../shared/types.js";

/** Capability a host must advertise before an agent type may be quick-started on it. */
function hostSupportsAgent(supervisor: SupervisorRecord, agentType: LaunchableAgentType): boolean {
	const caps = supervisor.capabilities;
	if (!caps?.agentTypes?.includes(agentType)) return false;
	const mode = defaultLaunchModeForAgent(agentType);
	return Boolean(caps.launchModes?.includes(mode));
}

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
	const t = useT();
	const navigate = useNavigate();
	const [projects, setProjects] = useState<Project[]>([]);
	const [supervisors, setSupervisors] = useState<SupervisorRecord[]>([]);
	const [agentType, setAgentType] = useState<LaunchableAgentType>("opencode");
	const [cwd, setCwd] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [firstPrompt, setFirstPrompt] = useState("");
	const [supervisorId, setSupervisorId] = useState<string>("");
	const [advanced, setAdvanced] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	// One correlation id per dialog lifetime: a retry after a timeout reuses it
	// instead of minting a second launch for the same intent.
	const correlationIdRef = useRef(`sess-${crypto.randomUUID()}`);

	useEffect(() => {
		void api
			.listProjects()
			.then((r) => setProjects(r.projects))
			.catch(() => {});
		void api
			.getSupervisors()
			.then((r) => setSupervisors(r.supervisors.filter((s) => s.status === "connected")))
			.catch(() => {});
	}, []);

	const capableHosts = useMemo(
		() => supervisors.filter((s) => hostSupportsAgent(s, agentType)),
		[supervisors, agentType],
	);
	const agentOptions = useMemo(() => {
		const options: LaunchableAgentType[] = [];
		for (const agent of ["opencode", "claude_code", "codex_cli"] as LaunchableAgentType[])
			if (supervisors.some((s) => hostSupportsAgent(s, agent))) options.push(agent);
		return options;
	}, [supervisors]);

	useEffect(() => {
		if (agentOptions.length && !agentOptions.includes(agentType)) setAgentType(agentOptions[0]);
	}, [agentOptions, agentType]);

	useEffect(() => {
		if (!cwd && projects.length) setCwd(projects[0].cwd);
	}, [projects, cwd]);

	useEffect(() => {
		if (capableHosts.length === 1) setSupervisorId(capableHosts[0].id);
	}, [capableHosts]);

	const reasons = useMemo(() => {
		const list: string[] = [];
		if (!cwd.trim()) list.push(t("newSession.needDirectory"));
		if (!capableHosts.length) list.push(t("newSession.noCapableHost"));
		else if (capableHosts.length > 1 && !supervisorId) list.push(t("newSession.pickHost"));
		return list;
	}, [cwd, capableHosts, supervisorId, t]);

	const submit = async () => {
		if (reasons.length || submitting) return;
		setSubmitting(true);
		try {
			const launchMode = defaultLaunchModeForAgent(agentType);
			const result = (await api.createLaunch({
				requestedSupervisorId: supervisorId || null,
				desiredDisplayName: displayName.trim() || null,
				template: { name: displayName.trim() || cwd.trim(), agentType, cwd: cwd.trim(), launchMode },
				launchSpec: {
					version: 1,
					launchCorrelationId: correlationIdRef.current,
					managedMode: "unmanaged_preview",
					agentType,
					launchMode,
					cwd: cwd.trim(),
					model: null,
					approvalPolicy: null,
					sandboxMode: null,
					baseInstructions: "",
					taskPrompt: firstPrompt.trim(),
					env: {},
			},
			})) as {
				launchRequest?: {
					id: string;
					status: string;
					error?: string | null;
					launchCorrelationId?: string;
				};
			};
			const launch = result?.launchRequest;
			if (!launch?.id) throw new Error(t("newSession.launchFailed"));
			if (launch.status === "rejected") throw new Error(launch.error || t("newSession.launchRejected"));
			toast.success(t("newSession.launched"));
			onClose();
			navigate(`/launches/${launch.id}`);
			// Bounded wait for the session to appear, then straight into it —
			// the launch page stays as the fallback if binding is slow.
			// The server mints the authoritative correlation id — poll by that.
			const correlation = launch.launchCorrelationId ?? correlationIdRef.current;
			void (async () => {
				const deadline = Date.now() + 45000;
				while (Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 1500));
					try {
						const list = await api.getSessions(scopedQuery({ owner: "all", excludeScratch: false }, { limit: 50 }));
						const match = list.sessions.find((item) => item.sessionId === correlation);
						if (match) {
							navigate(`/sessions/${encodeURIComponent(match.sessionId)}`);
							return;
						}
					} catch {
						/* keep waiting until the deadline */
					}
				}
			})();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("newSession.launchFailed"));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
				<h2 className="text-lg font-semibold">{t("newSession.title")}</h2>
				<p className="mt-1 text-xs text-muted-foreground">{t("newSession.subtitle")}</p>
				<div className="mt-4 space-y-4">
					<label className="block">
						<span className="text-xs font-medium text-muted-foreground">{t("newSession.agent")}</span>
						<select
							value={agentType}
							onChange={(e) => setAgentType(e.target.value as LaunchableAgentType)}
							className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
						>
							{agentOptions.map((agent) => (
								<option key={agent} value={agent}>
									{t(`newSession.agent_${agent}`)}
								</option>
							))}
						</select>
					</label>
					<label className="block">
						<span className="text-xs font-medium text-muted-foreground">{t("newSession.directory")}</span>
						<input
							list="new-session-dirs"
							value={cwd}
							onChange={(e) => setCwd(e.target.value)}
							placeholder="/home/you/project"
							className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm font-mono"
						/>
						<datalist id="new-session-dirs">
							{projects.map((p) => (
								<option key={p.id} value={p.cwd} />
							))}
						</datalist>
					</label>
					<label className="block">
						<span className="text-xs font-medium text-muted-foreground">
							{t("newSession.firstPromptOptional")}
						</span>
						<input
							value={firstPrompt}
							onChange={(e) => setFirstPrompt(e.target.value)}
							placeholder={t("newSession.firstPromptPlaceholder")}
							className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
						/>
					</label>
					<div>
						<button
							type="button"
							onClick={() => setAdvanced((v) => !v)}
							className="text-xs text-muted-foreground underline-offset-2 hover:underline"
						>
							{advanced ? t("newSession.hideAdvanced") : t("newSession.showAdvanced")}
						</button>
						{advanced && (
							<div className="mt-3 space-y-3 border-t border-border pt-3">
								<label className="block">
									<span className="text-xs font-medium text-muted-foreground">{t("newSession.displayName")}</span>
									<input
										value={displayName}
										onChange={(e) => setDisplayName(e.target.value)}
										className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
									/>
								</label>
								{capableHosts.length > 1 && (
									<label className="block">
										<span className="text-xs font-medium text-muted-foreground">{t("newSession.host")}</span>
										<select
											value={supervisorId}
											onChange={(e) => setSupervisorId(e.target.value)}
											className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm"
										>
											<option value="">{t("newSession.pickHost")}</option>
											{capableHosts.map((s) => (
												<option key={s.id} value={s.id}>
													{s.hostName || s.id.slice(0, 8)}
												</option>
											))}
										</select>
									</label>
								)}
								{agentType === "opencode" && (
									<p className="text-[11px] text-muted-foreground">{t("newSession.opencodeProfileNote")}</p>
								)}
							</div>
						)}
					</div>
					{reasons.length > 0 && (
						<ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
							{reasons.map((reason) => (
								<li key={reason}>{reason}</li>
							))}
						</ul>
					)}
				</div>
				<div className="mt-5 flex justify-end gap-2">
					<button
						type="button"
						onClick={onClose}
						className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
					>
						{t("newSession.cancel")}
					</button>
					<button
						type="button"
						onClick={() => void submit()}
						disabled={Boolean(reasons.length) || submitting}
						className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
					>
						{submitting ? t("newSession.starting") : t("newSession.start")}
					</button>
				</div>
			</div>
		</div>
	);
}
