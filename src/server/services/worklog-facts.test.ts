/**
 * Worklog fact core tests — fixed fact sets, deterministic renders, fork-copy
 * dedup and untrusted-output validation (taskbook P4: acceptance must not
 * depend on model wording).
 */
import { describe, expect, test } from "bun:test";
import {
	FACT_CATEGORY_LABELS_ZH,
	type WorklogFact,
	appendVersion,
	dedupeFacts,
	hashContent,
	parseFacts,
	renderPersonalReview,
	renderTeamDraftInput,
} from "./worklog-facts.js";

function fact(
	overrides: Partial<WorklogFact> & Pick<WorklogFact, "sessionId" | "text" | "category">,
): WorklogFact {
	const text = overrides.text;
	return {
		id: overrides.id ?? `f_${overrides.sessionId}-${overrides.evidenceEventId ?? 1}`,
		host: null,
		occurredAt: overrides.occurredAt ?? "2026-10-18T02:00:00.000Z",
		evidenceEventId: overrides.evidenceEventId ?? 1,
		projectHint: null,
		confidence: overrides.confidence ?? "stated",
		contentKey: overrides.contentKey ?? hashContent(`${overrides.category}:${text}`),
		...overrides,
	} as WorklogFact;
}

describe("fork-copy dedup", () => {
	test("identical normalized content from two sessions counts once", () => {
		const parent = fact({
			sessionId: "s-parent",
			category: "verified_result",
			text: "修复了登录 403，回归测试通过",
			evidenceEventId: 11,
		});
		const child = fact({
			sessionId: "s-parent:fork",
			category: "verified_result",
			text: "修复了登录\t403，回归测试通过",
			evidenceEventId: 52,
		});
		const kept = dedupeFacts([parent, child]);
		expect(kept).toHaveLength(1);
		expect(kept[0].sessionId).toBe("s-parent");
	});

	test("different content or category is not merged", () => {
		const a = fact({ sessionId: "s-a", category: "user_goal", text: "目标：完成迁移" });
		const b = fact({ sessionId: "s-b", category: "user_goal", text: "目标：完成部署" });
		const c = fact({ sessionId: "s-b", category: "open_item", text: "目标：完成迁移" });
		expect(dedupeFacts([a, b, c])).toHaveLength(3);
	});
});

describe("untrusted extraction output", () => {
	const ctx = {
		sessionId: "s-1",
		host: "h1",
		sessionName: "n",
		validEventIds: new Set([101, 102]),
	};

	test("valid facts parse with server-derived identities; evidence ids outside the chunk are dropped", () => {
		const raw = JSON.stringify({
			facts: [
				{
					category: "tool_action",
					text: "运行了迁移脚本",
					evidenceEventId: 101,
					occurredAt: "2026-10-18T01:00:00.000Z",
					confidence: "verified",
				},
				{
					category: "agent_claim",
					text: "自称全部完成",
					evidenceEventId: 999,
					occurredAt: "2026-10-18T01:05:00.000Z",
				},
			],
		});
		const { facts, rejected } = parseFacts(raw, ctx);
		expect(facts).toHaveLength(1);
		expect(rejected).toBe(1);
		expect(facts[0].evidenceEventId).toBe(101);
		expect(facts[0].confidence).toBe("verified");
		expect(facts[0].id).not.toContain("999");
	});

	test("model JSON wrapped in prose still parses; garbage returns empty", () => {
		const wrapped =
			'好的，结果是 {"facts":[{"category":"open_item","text":"部署未完成","evidenceEventId":102,"occurredAt":"t"}]} 请查收';
		expect(parseFacts(wrapped, ctx).facts).toHaveLength(1);
		expect(parseFacts("not json at all", ctx)).toEqual({ facts: [], rejected: 0 });
	});

	test("oversized text is clipped, not trusted; empty text rejected", () => {
		const raw = JSON.stringify({
			facts: [
				{ category: "tool_action", text: "长".repeat(1000), evidenceEventId: 101, occurredAt: "t" },
				{ category: "tool_action", text: "   ", evidenceEventId: 102, occurredAt: "t" },
			],
		});
		const { facts, rejected } = parseFacts(raw, ctx);
		expect(facts).toHaveLength(1);
		expect(rejected).toBe(1);
		expect(facts[0].text.length).toBeLessThanOrEqual(400);
	});
});

describe("deterministic renders (fixed fact set)", () => {
	const facts = [
		fact({
			sessionId: "s-1",
			category: "user_goal",
			text: "目标：上线多主机视图",
			evidenceEventId: 11,
		}),
		fact({
			sessionId: "s-1",
			category: "agent_claim",
			text: "自称已修复全部问题",
			evidenceEventId: 12,
		}),
		fact({ sessionId: "s-1", category: "tool_action", text: "执行迁移 0014", evidenceEventId: 13 }),
		fact({
			sessionId: "s-1",
			category: "verified_result",
			text: "回归 20/20 通过",
			evidenceEventId: 14,
			confidence: "verified",
		}),
		fact({ sessionId: "s-2", category: "open_item", text: "浏览器断言待补", evidenceEventId: 21 }),
	];

	test("personal review separates claims from verified results and links evidence", () => {
		const md = renderPersonalReview({ date: "2026-10-17", timezone: "Asia/Shanghai", facts });
		expect(md).toContain("# 个人回顾 · 2026-10-17");
		expect(md).toContain(FACT_CATEGORY_LABELS_ZH.agent_claim);
		expect(md).toContain(FACT_CATEGORY_LABELS_ZH.verified_result);
		expect(md).toContain("（事件 #14，已验证）");
		expect(md.indexOf(FACT_CATEGORY_LABELS_ZH.user_goal)).toBeLessThan(
			md.indexOf(FACT_CATEGORY_LABELS_ZH.verified_result),
		);
		expect(md).toContain("待办 1");
		// Session names replace raw ids when provided.
		const named = renderPersonalReview({
			date: "2026-10-17",
			timezone: "Asia/Shanghai",
			facts,
			sessionNames: new Map([["s-1", "会话一"]]),
		});
		expect(named).toContain("## 会话一");
	});

	test("empty fact set renders an explicit empty state, not an error", () => {
		const md = renderPersonalReview({ date: "2026-10-17", timezone: "Asia/Shanghai", facts: [] });
		expect(md).toContain("当天没有纳入范围的工作事实。");
	});

	test("team draft input labels categories, strips evidence noise", () => {
		const digest = renderTeamDraftInput(facts);
		expect(digest).toContain(`[${FACT_CATEGORY_LABELS_ZH.verified_result}]`);
		expect(digest).toContain("（已验证）");
		expect(digest).not.toContain("事件 #");
		expect(digest).not.toContain("s-1");
	});
});

describe("version append", () => {
	test("regeneration appends and never overwrites previous versions", () => {
		const v1 = appendVersion([], {
			kind: "personal",
			markdown: "# v1",
			generator: { model: "m", source: "facts" },
		});
		const v2 = appendVersion(v1, {
			kind: "personal",
			markdown: "# v2 edited",
			generator: { model: null, source: "manual" },
		});
		expect(v2).toHaveLength(2);
		expect(v2[0].markdown).toBe("# v1");
		expect(v2[1].generator.source).toBe("manual");
		expect(v2[1].versionId).not.toBe(v2[0].versionId);
	});
});
