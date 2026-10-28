import { t } from "../../i18n/i18n.js";
import { type WorkspaceTabId, tabBadgeAccessibleName } from "../../lib/session-summary-core.js";
import { WorkspaceTabButton } from "./SharedControls.js";

export interface WorkspaceTabBarProps {
	/** The tab showing now; null while a `?tab=` link waits for availability. */
	active: WorkspaceTabId | null;
	onSelect: (tab: WorkspaceTabId) => void;
	instructionsLabel: string;
	isWorking: boolean;
	hasLaunch: boolean;
	aiTabEnabled: boolean;
	summaryAvailable: boolean;
	/** The word on the Summary tab while a summary is being made. */
	summaryBadge: string | null;
}

export function workspaceTabButtonId(tab: WorkspaceTabId): string {
	return `workspace-tab-${tab}`;
}

/** Overview · Summary · Activity · Notes · instructions · Launch · AI; Summary only when the feature is available. */
export function WorkspaceTabBar(props: WorkspaceTabBarProps) {
	const { active, onSelect } = props;
	const tab = (
		id: WorkspaceTabId,
		label: string,
		badge: string | null = null,
		badgeName: string | null = null,
	) => (
		<WorkspaceTabButton
			id={workspaceTabButtonId(id)}
			active={active === id}
			label={label}
			badge={badge}
			badgeName={badgeName}
			onClick={() => onSelect(id)}
		/>
	);
	return (
		<nav
			aria-label={t("tabs.sections")}
			className="flex flex-nowrap items-center gap-1.5 overflow-x-auto md:flex-wrap md:gap-2"
		>
			{tab("overview", t("tabs.overview"))}
			{props.summaryAvailable &&
				tab(
					"summary",
					t("summary.tab"),
					props.summaryBadge
						? props.summaryBadge === "Summarizing"
							? t("badge.summarizing")
							: t("badge.new")
						: null,
					tabBadgeAccessibleName(props.summaryBadge as "Summarizing" | "New" | null),
				)}
			{tab("activity", t("tabs.activity"), props.isWorking ? t("status.working") : null)}
			{tab("notes", t("panels.notes"))}
			{tab("instructions", props.instructionsLabel)}
			{props.hasLaunch && tab("launch", t("tabs.launch"))}
			{props.aiTabEnabled && tab("ai", t("tabs.ai"))}
		</nav>
	);
}
