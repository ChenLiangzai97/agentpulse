import { describe, expect, test } from "bun:test";
import { drawerItems, machinesMenuItems, userMenuItems } from "./nav-items.js";
import { ownershipUi } from "./ownership-ui.js";

const solo = ownershipUi("solo", { effectiveRole: "admin" });
const member = ownershipUi("team", { effectiveRole: "member" });
const admin = ownershipUi("team", { effectiveRole: "admin" });

describe("machinesMenuItems", () => {
	test("solo: Setup and Hosts, as they have always been", () => {
		expect(machinesMenuItems(solo)).toEqual([
			{ to: "/setup", label: "nav.setup" },
			{ to: "/hosts", label: "nav.hosts" },
		]);
	});

	test("team: the same destinations under the words people use for their own machines", () => {
		expect(machinesMenuItems(member)).toEqual([
			{ to: "/setup", label: "nav.setupHooks" },
			{ to: "/hosts", label: "nav.hosts" },
		]);
	});
});

describe("userMenuItems", () => {
	test("solo: Settings, and Change password for a local account, exactly as before", () => {
		expect(userMenuItems(solo, { isLocal: true })).toEqual([
			{ to: "/settings", label: "nav.settings" },
			{ to: "/settings?panel=account", label: "nav.changePassword" },
		]);
		expect(userMenuItems(solo, { isLocal: false })).toEqual([
			{ to: "/settings", label: "nav.settings" },
		]);
	});

	test("team admin: a Users item that opens the team section", () => {
		expect(userMenuItems(admin, { isLocal: true })).toEqual([
			{ to: "/settings", label: "nav.settings" },
			{ to: "/settings?panel=team", label: "nav.users" },
			{ to: "/settings?panel=account", label: "nav.changePassword" },
		]);
	});

	test("team member: no Users item", () => {
		expect(userMenuItems(member, { isLocal: false })).toEqual([
			{ to: "/settings", label: "nav.settings" },
		]);
	});
});

describe("drawerItems", () => {
	test("solo: the 'Admin' heading with Setup, Hosts, Settings", () => {
		expect(drawerItems(solo, { isLocal: true })).toEqual({
			heading: "Admin",
			links: [
				{ to: "/setup", label: "nav.setup" },
				{ to: "/hosts", label: "nav.hosts" },
				{ to: "/settings", label: "nav.settings" },
			],
		});
	});

	test("team member with a local account: 'Machines', no Users, and Change password", () => {
		expect(drawerItems(member, { isLocal: true })).toEqual({
			heading: "Machines",
			links: [
				{ to: "/setup", label: "nav.setupHooks" },
				{ to: "/hosts", label: "nav.hosts" },
				{ to: "/settings", label: "nav.settings" },
				{ to: "/settings?panel=account", label: "nav.changePassword" },
			],
		});
	});

	test("team member signed in through SSO: no password to change", () => {
		expect(drawerItems(member, { isLocal: false }).links.map((link) => link.label)).toEqual([
			"nav.setupHooks",
			"nav.hosts",
			"nav.settings",
		]);
	});

	test("team admin: Users after Settings, then Change password for a local account", () => {
		const labels = drawerItems(admin, { isLocal: false }).links.map((link) => link.label);
		expect(labels).toEqual(["nav.setupHooks", "nav.hosts", "nav.settings", "nav.users"]);
		const local = drawerItems(admin, { isLocal: true }).links.map((link) => link.label);
		expect(local).toEqual(["nav.setupHooks", "nav.hosts", "nav.settings", "nav.users", "nav.changePassword"]);
	});

	test("solo drawer stays exactly today's three links even for a local account", () => {
		expect(drawerItems(solo, { isLocal: true }).links.map((link) => link.label)).toEqual([
			"nav.setup",
			"nav.hosts",
			"nav.settings",
		]);
	});
});
