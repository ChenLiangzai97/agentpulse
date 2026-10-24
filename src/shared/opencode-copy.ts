/**
 * copyOf part identity shared by the supervisor (native fork window) and the
 * server (event ingestion). A part fingerprint covers the fields that make a
 * part THE SAME part — type, text, tool name, call id, tool state (status,
 * input, output, error) and timestamps — never ids (they are remapped by the
 * native fork).
 */
export interface CopyPart {
	type?: string;
	text?: string;
	tool?: string;
	callID?: string;
	state?: { status?: string; input?: unknown; output?: unknown; error?: unknown };
	time?: { start?: number; end?: number };
}

const canonical = (value: unknown): string => {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
};

/** Accepts either a native part or a rawPayload.source_data object. */
export function partFingerprint(part: unknown): string {
	const source = (part ?? {}) as CopyPart;
	const material = {
		type: source.type ?? null,
		text: source.text ?? null,
		tool: source.tool ?? null,
		callID: source.callID ?? null,
		status: source.state?.status ?? null,
		input: source.state?.input ?? null,
		output: source.state?.output ?? null,
		error: source.state?.error ?? null,
		start: source.time?.start ?? null,
		end: source.time?.end ?? null,
	};
	// FNV-1a over the canonical form: synchronous, dependency-free, stable.
	let hash = 0x811c9dc5;
	const text = canonical(material);
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${hash.toString(16).padStart(8, "0")}:${text.length}`;
}
