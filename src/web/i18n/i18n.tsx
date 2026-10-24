/**
 * The zero-dependency i18n core (AGEN-72).
 *
 * Locale state lives in ui-prefs-store (localStorage-persisted, default
 * zh-CN on this fork); `useT()` subscribes to it so a language switch
 * re-renders everything that renders text. A module-level `t` reads the
 * current locale on each call for non-React utilities (formatTimeAgo,
 * clipboard builders) and pure modules that tests drive with the English
 * dictionary.
 *
 * Missing-key behaviour: an unknown key in a non-English locale falls back
 * to English, then to the key itself — never a blank string. The typed key
 * union makes "unknown" a compile error for call sites, so the fallback only
 * guards hand-built dynamic keys.
 */
import { useUiPrefsStore } from "../stores/ui-prefs-store.js";
import { en } from "./en.js";
import { zhCN } from "./zh-CN.js";

export type Locale = "zh-CN" | "en";

const DICTS: Record<Locale, typeof en> = { "zh-CN": zhCN, en };

/** Every dot-path the English dictionary exposes — the call-site key union. */
type Leaves<T, P extends string = ""> = T extends object
	? {
			[K in keyof T & string]: Leaves<T[K], P extends "" ? K : `${P}.${K}`>;
		}[keyof T & string]
	: P;

export type DictKey = Leaves<typeof en>;

export function currentLocale(): Locale {
	return useUiPrefsStore.getState().locale ?? "zh-CN";
}

function lookup(dict: unknown, path: string): string | undefined {
	let node: unknown = dict;
	for (const part of path.split(".")) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[part];
	}
	return typeof node === "string" ? node : undefined;
}

function interpolate(text: string, params?: Record<string, string | number>): string {
	if (!params) return text;
	return text.replace(/\{(\w+)\}/g, (match, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : match,
	);
}

export function translate(
	locale: Locale,
	key: DictKey | string,
	params?: Record<string, string | number>,
): string {
	const primary = lookup(DICTS[locale], key);
	const text = primary ?? lookup(en, key) ?? key;
	return interpolate(text, params);
}

/** Module-level translation for non-React call sites; reads the live locale each call. */
export const t = (key: DictKey | string, params?: Record<string, string | number>): string =>
	translate(currentLocale(), key, params);

/**
 * The React hook: re-renders on locale change. Returns the same `t`
 * signature; components should capture it once per render.
 */
export function useT(): (
	key: DictKey | string,
	params?: Record<string, string | number>,
) => string {
	const locale = useUiPrefsStore((s) => s.locale);
	return (key, params) => translate(locale ?? "zh-CN", key, params);
}
