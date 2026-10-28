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
	extra?: Partial<Pick<ChunkEvent, "eventType" | "toolResponse" | "verifiedPass">>,
): ChunkEvent {
	return { id, category, content, createdAt, ...extra };
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
		copyOf: overrides.copyOf ?? null,
		...overrides,
	} as WorklogFact;
}

describe("conservative copy dedup", () => {
	test("facts without a proven copy mapping are always kept", () => {
		const a = fact({
			sessionId: "s-parent",
			category: "verified_result",
			text: "同样的工作",
			evidenceEventId: 11,
		});
		const child = fact({
			sessionId: "s-parent:opencode-child:ses_x",
			category: "verified_result",
			text: "同样的工作",
			evidenceEventId: 52,
		});
		const other = fact({
			sessionId: "hostB-proj",
			category: "verified_result",
			text: "同样的工作",
			evidenceEventId: 61,
		});
		// Same text, shared lineage, different sessions — no PROOF of copying.
		expect(dedupeFacts([a, child, other])).toHaveLength(3);
	});

	test("several distinct facts from ONE event are all kept", () => {
		const fromSameEvent = [
			fact({ sessionId: "s", category: "tool_action", text: "执行了回归", evidenceEventId: 7 }),
			fact({
				sessionId: "s",
				category: "verified_result",
				text: "回归 20/20 通过",
				evidenceEventId: 7,
			}),
			fact({ sessionId: "s", category: "open_item", text: "覆盖率未达标", evidenceEventId: 7 }),
		];
		expect(dedupeFacts(fromSameEvent)).toHaveLength(3);
	});

	test("re-running the identical command keeps every execution", () => {
		const first = fact({
			sessionId: "s",
			category: "tool_action",
			text: "执行 make test",
			evidenceEventId: 3,
		});
		const second = fact({
			sessionId: "s",
			category: "tool_action",
			text: "执行 make test",
			evidenceEventId: 9,
		});
		expect(dedupeFacts([first, second])).toHaveLength(2);
	});

	test("sibling branches independently producing the same text are not merged", () => {
		const branchA = fact({
			sessionId: "root:opencode-child:ses_a",
			category: "user_goal",
			text: "各自完成了同样措辞的目标",
			evidenceEventId: 4,
		});
		const branchB = fact({
			sessionId: "root:opencode-child:ses_b",
			category: "user_goal",
			text: "各自完成了同样措辞的目标",
			evidenceEventId: 8,
		});
		expect(dedupeFacts([branchA, branchB])).toHaveLength(2);
	});

	test("a PROVEN copy mapping drops copy facts when the original event's facts are present", () => {
		// The original event yielded TWO facts; both must survive, and every
		// fact copied from it is dropped (dedup is event-scoped, not one-per-source).
		const originalFacts = [
			fact({
				sessionId: "s-parent",
				category: "tool_action",
				text: "执行了构建",
				evidenceEventId: 5,
				copyOf: null,
			}),
			fact({
				sessionId: "s-parent",
				category: "verified_result",
				text: "构建成功",
				evidenceEventId: 5,
				copyOf: null,
			}),
		];
		const copyFacts = [
			fact({
				sessionId: "s-parent:opencode-child:ses_x",
				category: "tool_action",
				text: "执行了构建",
				evidenceEventId: 15,
				copyOf: "s-parent:5",
			}),
			fact({
				sessionId: "s-parent:opencode-child:ses_y",
				category: "tool_action",
				text: "执行了构建",
				evidenceEventId: 22,
				copyOf: "s-parent:5",
			}),
		];
		const kept = dedupeFacts([...originalFacts, ...copyFacts]);
		expect(kept).toHaveLength(2);
		expect(kept.every((f) => f.sessionId === "s-parent")).toBe(true);
	});

	test("copy facts keep single-event multi-fact when the anchor is outside the set", () => {
		// Two copy EVENTS of the same original: the first copy event is kept
		// WHOLE (both its facts), later copy events are dropped.
		const firstCopy = [
			fact({
				sessionId: "c1",
				category: "tool_action",
				text: "执行了构建",
				evidenceEventId: 15,
				copyOf: "s-parent:5",
			}),
			fact({
				sessionId: "c1",
				category: "verified_result",
				text: "构建成功",
				evidenceEventId: 15,
				copyOf: "s-parent:5",
			}),
		];
		const secondCopy = [
			fact({
				sessionId: "c2",
				category: "tool_action",
				text: "执行了构建",
				evidenceEventId: 22,
				copyOf: "s-parent:5",
			}),
			fact({
				sessionId: "c2",
				category: "verified_result",
				text: "构建成功",
				evidenceEventId: 22,
				copyOf: "s-parent:5",
			}),
		];
		const kept = dedupeFacts([...firstCopy, ...secondCopy]);
		expect(kept).toHaveLength(2);
		expect(kept.every((f) => f.sessionId === "c1")).toBe(true);
	});

	test("lineageRootOf strips nested child segments", () => {
		expect(lineageRootOf("root:opencode-child:ses_a")).toBe("root");
		expect(lineageRootOf("root:opencode-child:ses_a:opencode-child:ses_b")).toBe("root");
		expect(lineageRootOf("plain-session")).toBe("plain-session");
	});
});

describe("evidence-type classification constraints", () => {
	test("the generic pipeline never grants verified_result — ordinary output is not proof of success", () => {
		const raw = JSON.stringify({
			facts: [
				{ category: "verified_result", text: "自称测试全过", evidenceEventId: 5 },
				{ category: "verified_result", text: "读取了文件并声称验证", evidenceEventId: 7 },
			],
		});
		const parsed = parseFacts(
			raw,
			ctx("s", [
				event(5, "assistant_message", "我认为完成了"),
				// Completed bash tool whose output is a plain file listing — it does
				// not match any failure pattern, but it is NOT verification either.
				event(7, "tool_event", "bash", "2026-10-18 02:00:00", {
					eventType: "PostToolUse",
					toolResponse: "README.md  package.json  src/  tests/",
				}),
			]),
		);
		expect(parsed.parseFailed).toBe(false);
		expect(parsed.downgraded).toBe(2);
		// Assistant citation → claim; tool citation → plain execution.
		expect(parsed.facts.map((f) => f.category).sort()).toEqual(["agent_claim", "tool_action"]);
		expect(parsed.facts.every((f) => f.confidence === "stated")).toBe(true);
	});

	test("only a trusted verifier marker on a completed tool can yield verified_result", () => {
		const raw = JSON.stringify({
			facts: [{ category: "verified_result", text: "回归 20/20 通过", evidenceEventId: 7 }],
		});
		const ok = parseFacts(
			raw,
			ctx("s", [
				event(7, "tool_event", "bash", "2026-10-18 02:00:00", {
					eventType: "PostToolUse",
					toolResponse: "20 passed, 0 failed",
					verifiedPass: true,
				}),
			]),
		);
		expect(ok.facts[0].category).toBe("verified_result");
		expect(ok.facts[0].confidence).toBe("verified");
		// The marker alone is not enough: a failing or non-completed tool with
		// the marker still cannot verify.
		const failing = parseFacts(
			raw,
			ctx("s", [
				event(7, "tool_event", "bash", "2026-10-18 02:00:00", {
					eventType: "PostToolUse",
					toolResponse: "3 failed, 47 passed",
					verifiedPass: true,
				}),
			]),
		);
		expect(failing.facts[0].category).toBe("tool_action");
	});

	test("RUNNING tools falsely labeled verified become tool_action", () => {
		const raw = JSON.stringify({
			facts: [
				{ category: "verified_result", text: "测试通过了（其实在运行中）", evidenceEventId: 7 },
			],
		});
		const parsed = parseFacts(
			raw,
			ctx("s", [
				event(7, "tool_event", "bash", "2026-10-18 02:00:00", { eventType: "PreToolUse" }),
			]),
		);
		expect(parsed.facts[0].category).toBe("tool_action");
		expect(parsed.facts[0].confidence).toBe("stated");
		expect(parsed.downgraded).toBe(1);
	});

	test("FAILED tools falsely labeled verified become tool_action", () => {
		const raw = JSON.stringify({
			facts: [{ category: "verified_result", text: "构建成功（实际失败）", evidenceEventId: 8 }],
		});
		const parsed = parseFacts(
			raw,
			ctx("s", [
				event(8, "tool_event", "bash", "2026-10-18 02:00:00", {
					eventType: "PostToolUseFailure",
					toolResponse: "exit 1: 3 tests failed",
				}),
			]),
		);
		expect(parsed.facts[0].category).toBe("tool_action");
		expect(parsed.facts[0].confidence).toBe("stated");
	});

	test("completed tools WITHOUT output cannot be verified either", () => {
		const raw = JSON.stringify({
			facts: [{ category: "verified_result", text: "悄悄完成了", evidenceEventId: 9 }],
		});
		const parsed = parseFacts(
			raw,
			ctx("s", [
				event(9, "tool_event", "edit", "2026-10-18 02:00:00", {
					eventType: "PostToolUse",
					toolResponse: "",
				}),
			]),
		);
		expect(parsed.facts[0].category).toBe("tool_action");
	});

	test("UNKNOWN lifecycle states with output stay unverified (explicit whitelist)", () => {
		const raw = JSON.stringify({
			facts: [{ category: "verified_result", text: "未知状态却声称验证", evidenceEventId: 6 }],
		});
		for (const unknown of [undefined, "SomeFutureToolEvent", null]) {
			const parsed = parseFacts(
				raw,
				ctx("s", [
					event(6, "tool_event", "bash", "2026-10-18 02:00:00", {
						eventType: unknown as string | null | undefined,
						toolResponse: "looks fine",
					}),
				]),
			);
			expect(parsed.facts[0].category).toBe("tool_action");
			expect(parsed.facts[0].confidence).toBe("stated");
		}
	});

	test("COMPLETED tools whose output looks like FAILURE stay unverified", () => {
		const raw = JSON.stringify({
			facts: [{ category: "verified_result", text: "声称成功", evidenceEventId: 6 }],
		});
		for (const output of ["3 failed, 47 passed", "exit code 1", "BUILD FAILURE", "2 failing"]) {
			const parsed = parseFacts(
				raw,
				ctx("s", [
					event(6, "tool_event", "bash", "2026-10-18 02:00:00", {
						eventType: "PostToolUse",
						toolResponse: output,
					}),
				]),
			);
			expect(parsed.facts[0].category).toBe("tool_action");
		}
		// Passing-shaped output STILL does not verify on its own (round 6:
		// not-matching-the-deny-list is not proof of success).
		const pass = parseFacts(
			JSON.stringify({
				facts: [{ category: "verified_result", text: "全部通过", evidenceEventId: 7 }],
			}),
			ctx("s", [
				event(7, "tool_event", "bash", "2026-10-18 02:00:00", {
					eventType: "PostToolUse",
					toolResponse: "0 failed, 51 passed",
				}),
			]),
		);
		expect(pass.facts[0].category).toBe("tool_action");
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
			ctx("s", [
				event(5, "assistant_message", "…"),
				event(7, "tool_event", "bash", "2026-10-18 02:00:00", {
					eventType: "PostToolUse",
					toolResponse: "build ok",
				}),
			]),
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
		expect(parsed.facts[0].copyOf).toBeNull();
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
		expect(md).toContain("[事件 #14](/sessions/s-1?tab=activity#event-14)，已验证");
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
