/**
 * AGEN-70: the analysis report model answer, parsed, normalised and validated.
 *
 * Mirrors session-summary/output-schema.ts: the only other runtime zod import
 * on the server; shared stays zod-free. A failed parse yields only a schema
 * path built from this file's own key names — never model text.
 */
import { z } from "zod";
import {
	ANALYSIS_VALIDATION_OUTCOMES,
	ANALYSIS_VERIFICATION_STATUSES,
	type AnalysisDraft,
} from "../../../../shared/analysis-report.js";
import type { LlmStopReason } from "../llm/types.js";
import { stripThinkTag } from "../parser.js";

const MAX_ANSWER_CHARS = 200_000;
const OVERVIEW_MAX_CHARS = 1200;
const ITEM_MAX_CHARS = 300;
const DETAIL_MAX_CHARS = 400;
const MAX_SECTION_ITEMS = 15;
const MAX_EVIDENCE_PER_ITEM = 6;
const TRUNCATION_TRAILER =
	"RESPONSE TRUNCATED. Respond again with the same JSON object, shorter: overview <= 1200 chars, every item <= 300 chars, detail <= 400 chars, at most 15 items per section.";

// ── the schema ───────────────────────────────────────────────────────────────

/** `S<sessionIndex>E<eventRowId>`: the composite citation the prompt offers. */
const evidenceSchema = z.array(z.string().regex(/^S[1-9]\d*E\d+$/)).max(MAX_EVIDENCE_PER_ITEM);
const itemSchema = z.object({
	summary: z.string().min(1).max(ITEM_MAX_CHARS),
	detail: z.string().max(DETAIL_MAX_CHARS).optional(),
	evidence: evidenceSchema,
});

const analysisDraftSchema = z.object({
	overview: z.string().min(1).max(OVERVIEW_MAX_CHARS),
	accomplishments: z
		.array(itemSchema.extend({ verification: z.enum(ANALYSIS_VERIFICATION_STATUSES) }))
		.max(MAX_SECTION_ITEMS),
	validations: z
		.array(itemSchema.extend({ outcome: z.enum(ANALYSIS_VALIDATION_OUTCOMES) }))
		.max(MAX_SECTION_ITEMS),
	unfinished: z.array(itemSchema).max(MAX_SECTION_ITEMS),
	decisions: z.array(itemSchema).max(MAX_SECTION_ITEMS),
});

export type { AnalysisDraft };

const PATH_KEYS = new Set<string>([
	"overview",
	"accomplishments",
	"validations",
	"unfinished",
	"decisions",
	"summary",
	"detail",
	"evidence",
	"verification",
	"outcome",
]);
const TOP_LEVEL = "top level";

// ── nonce ────────────────────────────────────────────────────────────────────

/** Removes every occurrence of the fence nonce (any case), repeatedly, so pieces cannot rebuild one. */
export function removeNonce(text: string, nonce: string): string {
	if (!nonce) return text;
	const needle = nonce.toLowerCase();
	const re = new RegExp(nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
	let out = text;
	while (out.toLowerCase().includes(needle)) out = out.replace(re, "");
	return out;
}

// ── finding the object ───────────────────────────────────────────────────────

const MARKER_KEYS = ["overview", "accomplishments", "unfinished", "decisions"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripFence(text: string): string {
	const match = text.match(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/);
	return match ? (match[1] as string) : text;
}

/** End index of the balanced object starting at `start`, string-aware; -1 when unterminated. */
function balancedEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
		} else if (ch === "\\") {
			escaped = inString;
		} else if (ch === '"') {
			inString = !inString;
		} else if (!inString) {
			if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) return i;
		}
	}
	return -1;
}

/** Least-claiming fallbacks, so a missing key does not fail an otherwise usable answer. */
function normalise(root: Record<string, unknown>): Record<string, unknown> {
	const arrays: Array<[string, unknown]> = [
		["accomplishments", root.accomplishments],
		["validations", root.validations],
		["unfinished", root.unfinished],
		["decisions", root.decisions],
	];
	const out: Record<string, unknown> = { ...root };
	for (const [key, value] of arrays) {
		if (value === undefined) out[key] = [];
		if (value !== undefined && !Array.isArray(value)) out[key] = [];
	}
	for (const item of [
		...(out.accomplishments as unknown[]),
		...(out.validations as unknown[]),
		...(out.unfinished as unknown[]),
		...(out.decisions as unknown[]),
	]) {
		if (!isRecord(item)) continue;
		if (item.evidence === undefined) item.evidence = [];
		if (item.detail === undefined) item.detail = undefined;
	}
	return out;
}

/** The first balanced JSON object that carries one of the marker keys. */
function findAnswerObject(text: string): Record<string, unknown> | null {
	let count = 0;
	for (let i = 0; i < text.length && count < 50; i++) {
		if (text[i] !== "{") continue;
		count++;
		const end = balancedEnd(text, i);
		if (end < 0) break;
		try {
			const parsed = JSON.parse(text.slice(i, end + 1)) as unknown;
			if (isRecord(parsed) && MARKER_KEYS.some((key) => Object.hasOwn(parsed, key))) {
				return parsed;
			}
		} catch {
			// not JSON; keep scanning
		}
		i = end;
	}
	return null;
}

export type ParseResult = { ok: true; draft: AnalysisDraft } | { ok: false; path: string };

function schemaPath(path: ReadonlyArray<string | number>): string {
	return path.length === 0 ? TOP_LEVEL : path.join(".");
}

export function parseAnalysisAnswer(raw: string, nonce: string): ParseResult {
	try {
		if (typeof raw !== "string") return { ok: false, path: TOP_LEVEL };
		const text = stripFence(
			stripThinkTag(removeNonce(raw.slice(0, MAX_ANSWER_CHARS), nonce)).trim(),
		);
		const root = findAnswerObject(text);
		if (!root) return { ok: false, path: TOP_LEVEL };
		const checked = analysisDraftSchema.safeParse(normalise(root));
		if (!checked.success) {
			return { ok: false, path: schemaPath(checked.error.issues[0]?.path ?? []) };
		}
		return { ok: true, draft: checked.data };
	} catch {
		return { ok: false, path: TOP_LEVEL };
	}
}

// ── repair ───────────────────────────────────────────────────────────────────

export type RepairKind = { kind: "parse"; path: string } | { kind: "truncated" };

function safePath(path: string): string {
	if (path === TOP_LEVEL) return path;
	const segments = path.split(".");
	return segments.every((s) => /^\d{1,3}$/.test(s) || PATH_KEYS.has(s)) ? path : TOP_LEVEL;
}

export function repairTrailer(repair: RepairKind): string {
	if (repair.kind === "truncated") return TRUNCATION_TRAILER;
	return `RESPONSE PARSE ERROR at ${safePath(repair.path)}. Respond with exactly one JSON object per the schema. No prose.`;
}

export function classifyStopReason(
	stop: LlmStopReason | undefined,
): "refusal" | "length" | "parse" {
	if (stop === "refusal") return "refusal";
	if (stop === "length") return "length";
	return "parse";
}
