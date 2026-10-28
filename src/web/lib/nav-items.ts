import type { OwnershipUi } from "./ownership-ui.js";

/** Labels are i18n keys resolved by the rendering components (AGEN-72 follow-up: nav i18n). */

export interface NavLinkItem {
	to: string;
	label: string;
}

const SETTINGS: NavLinkItem = { to: "/settings", label: "nav.settings" };
const USERS: NavLinkItem = { to: "/settings?panel=team", label: "nav.users" };
const CHANGE_PASSWORD: NavLinkItem = { to: "/settings?panel=account", label: "nav.changePassword" };

/** Setup and Hosts: where a person wires up their own machines. */
export function machinesMenuItems(ui: OwnershipUi): NavLinkItem[] {
	return [
		{ to: "/setup", label: ui.showTeamCopy ? "nav.setupHooks" : "nav.setup" },
		{ to: "/hosts", label: "nav.hosts" },
	];
}

export function userMenuItems(ui: OwnershipUi, account: { isLocal: boolean }): NavLinkItem[] {
	return [
		SETTINGS,
		...(ui.showUsersLink ? [USERS] : []),
		...(account.isLocal ? [CHANGE_PASSWORD] : []),
	];
}

/** The mobile drawer's second group. Solo keeps today's three links; in team mode a local account also gets Change password, since a phone has no user menu to find it in. */
export function drawerItems(
	ui: OwnershipUi,
	account: { isLocal: boolean },
): { heading: string; links: NavLinkItem[] } {
	return {
		heading: ui.machinesMenuLabel,
		links: [
			...machinesMenuItems(ui),
			SETTINGS,
			...(ui.showUsersLink ? [USERS] : []),
			...(ui.showTeamCopy && account.isLocal ? [CHANGE_PASSWORD] : []),
		],
	};
}
