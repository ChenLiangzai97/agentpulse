/**
 * Worklog fact core tests — fixed fact sets, deterministic renders, lineage-
 * scoped fork dedup, evidence-type classification constraints and server-
 * derived occurrence times (taskbook P4; review round 3 blockers).
 */
import { describe, expect, test } from "bun:test";
import {
	type ChunkEvent,
	FACT_CATEGORY_LABELS_ZH,
	type WorklogFact,
	appendVersion,
	dedupeFacts,
	hashContent,
	lineageRootOf,
	parseFacts,
	renderPersonalReview,
	renderTeamDraftInput,
} from "./worklog-facts.js";

function event(
	id: number,
	category: string,
	content: string,
	createdAt = "2026-10-18 02:00:00",
): ChunkEvent {
	return { id, category, content, createdAt };
}

function ctx(sessionId: string, events: ChunkEvent[]) {
	return {
		sessionId,
		host: "h1",
		sessionName: "n",
		events: new Map(events.map((e) => [e.id, e])),
	};
}

function fact(
	overrides: Partial<WorklogFact> & Pick<WorklogFact, "sessionId" | "text" | "category">,
): WorklogFact {
	return {
		id: overrides.id ?? `f_${overrides.sessionId}-${overrides.evidenceEventId ?? 1}`,
		host: null,
		occurredAt: overrides.occurredAt ?? "2026-10-18T02:00:00.000Z",
		evidenceEventId: overrides.evidenceEventId ?? 1,
		projectHint: null,
		confidence: overrides.confidence ?? "stated",
		contentKey: overrides.contentKey ?? hashContent(`${overrides.category}:${overrides.text}`),
		lineageRoot: overrides.lineageRoot ?? lineageRootOf(overrides.sessionId),
		eventContentKey: overrides.eventContentKey ?? hashContent(overrides.text),
		...overrides,
	} as WorklogFact;
}

describe("fork-copy dedup is lineage-scoped", () => {
	test("copies inside one lineage root count once; first occurrence wins", () => {
		const parent = fact({
			sessionId: "s-parent",
			lineageRoot: "s-parent",
			category: "verified_result",
			text: "修复了登录 403，回归测试通过",
			evidenceEventId: 11,
			eventContentKey: "copy-abc",
		});
		const child = fact({
			sessionId: "s-parent:opencode-child:ses_x",
			lineageRoot: "s-parent",
			category: "verified_result",
			text: "修复了登录 403，回归测试通过",
			evidenceEventId: 52,
			eventContentKey: "copy-abc",
		});
		const kept = dedupeFacts([parent, child]);
		expect(kept).toHaveLength(1);
		expect(kept[0].sessionId).toBe("s-parent");
	});

	test("unrelated sessions doing the same work are NOT merged", () => {
		const a = fact({
			sessionId: "hostA-project",
			lineageRoot: "hostA-project",
			category: "verified_result",
			text: "完成了同样的迁移",
			eventContentKey: "same",
		});
		const b = fact({
			sessionId: "hostB-project",
			lineageRoot: "hostB-project",
			category: "verified_result",
			text: "完成了同样的迁移",
			eventContentKey: "same",
		});
		expect(dedupeFacts([a, b])).toHaveLength(2);
	});

	test("same lineage but different source content stays separate", () => {
		const a = fact({
			sessionId: "s:opencode-child:x",
			lineageRoot: "s",
			category: "user_goal",
			text: "目标 A",
			eventContentKey: "ea",
		});
		const b = fact({
			sessionId: "s",
			lineageRoot: "s",
			category: "user_goal",
			text: "目标 B",
			eventContentKey: "eb",
		});
		expect(dedupeFacts([a, b])).toHaveLength(2);
	});

	test("lineageRootOf strips nested child segments", () => {
		expect(lineageRootOf("root:opencode-child:ses_a")).toBe("root");
		expect(lineageRootOf("root:opencode-child:ses_a:opencode-child:ses_b")).toBe("root");
		expect(lineageRootOf("plain-session")).toBe("plain-session");
	});
});

describe("evidence-type classification constraints", () => {
	test("verified_result backed only by an assistant message is downgraded to agent_claim", () => {
		const raw = JSON.stringify({
			facts: [
				{ category: "verified_result", text: "自称测试全过", evidenceEventId: 5 },
				{ category: "verified_result", text: "测试输出 20/20 通过", evidenceEventId: 7 },
			],
		});
		const parsed = parseFacts(
			raw,
			ctx("s", [
				event(5, "assistant_message", "我认为完成了"),
				event(7, "tool_event", "20 passed, 0 failed"),
			]),
		);
		expect(parsed.parseFailed).toBe(false);
		expect(parsed.downgraded).toBe(1);
		const categories = parsed.facts.map((f) => f.category).sort();
		expect(categories).toEqual(["agent_claim", "verified_result"]);
	});

	test("user_goal cited on an assistant message becomes agent_claim; tool_action needs tool_event", () => {
		const raw = JSON.stringify({
			facts: [
				{ category: "user_goal", text: "助手复述的目标", evidenceEventId: 5 },
				{ category: "tool_action", text: "执行了构建（仅口头）", evidenceEventId: 5 },
				{ category: "tool_action", text: "执行了构建", evidenceEventId: 7 },
			],
		});
		const parsed = parseFacts(
			raw,
			ctx("s", [event(5, "assistant_message", "…"), event(7, "tool_event", "build ok")]),
		);
		expect(parsed.facts.map((f) => f.category)).toEqual([
			"agent_claim",
			"agent_claim",
			"tool_action",
		]);
		expect(parsed.downgraded).toBe(2);
	});

	test("evidence ids outside the chunk are rejected, not trusted", () => {
		const raw = JSON.stringify({
			facts: [{ category: "user_goal", text: "越界引用", evidenceEventId: 999 }],
		});
		const parsed = parseFacts(raw, ctx("s", [event(5, "prompt", "真实事件")]));
		expect(parsed.facts).toHaveLength(0);
		expect(parsed.rejected).toBe(1);
	});
});

describe("server-derived occurrence time and identity", () => {
	test("occurredAt comes from the source event, never from the model", () => {
		// The model output carries no time at all — and even a hostile
		// "occurredAt" field would be ignored (not in the schema).
		const raw = JSON.stringify({
			facts: [
				{
					category: "user_goal",
					text: "目标",
					evidenceEventId: 9,
					occurredAt: "1970-01-01T00:00:00Z",
				},
			],
		});
		const parsed = parseFacts(
			raw,
			ctx("s", [event(9, "prompt", "目标内容", "2026-10-17 09:30:00")]),
		);
		expect(parsed.facts[0].occurredAt).toBe("2026-10-17 09:30:00");
		expect(parsed.facts[0].eventContentKey).toBe(hashContent("目标内容"));
		expect(parsed.facts[0].lineageRoot).toBe("s");
	});

	test("garbage extraction output is a loud failure, not an empty success", () => {
		const parsed = parseFacts("completely not json", ctx("s", [event(5, "prompt", "x")]));
		expect(parsed.parseFailed).toBe(true);
		expect(parsed.facts).toHaveLength(0);
		expect(parsed.rejected).toBe(0);
	});

	test("oversized text is clipped, not trusted; empty text rejected", () => {
		const raw = JSON.stringify({
			facts: [
				{ category: "tool_action", text: "长".repeat(1000), evidenceEventId: 7 },
				{ category: "tool_action", text: "   ", evidenceEventId: 7 },
			],
		});
		const parsed = parseFacts(raw, ctx("s", [event(7, "tool_event", "out")]));
		expect(parsed.facts).toHaveLength(1);
		expect(parsed.rejected).toBe(1);
		expect(parsed.facts[0].text.length).toBeLessThanOrEqual(400);
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
