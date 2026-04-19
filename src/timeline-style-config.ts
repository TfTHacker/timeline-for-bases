export const CUSTOM_STRING_KEYS = ['colorMap', 'borderColorMap', 'propColWidths', 'collapsedGroups'] as const;
export const CUSTOM_NUMERIC_KEYS = ['labelColWidth', 'borderWidth'] as const;
export const CUSTOM_STRING_SCALAR_KEYS = ['timeScale', 'showColors', 'colorBy', 'borderBy'] as const;
export const ALL_CUSTOM_KEYS = [
	...CUSTOM_STRING_KEYS,
	...CUSTOM_NUMERIC_KEYS,
	...CUSTOM_STRING_SCALAR_KEYS,
] as const;

export function encodeStyleMap(map: Record<string, string>): string {
	return Object.entries(map).map(([k, v]) => {
		const safeKey = k.startsWith('"') && k.endsWith('"') ? k.slice(1, -1) : k;
		return `${safeKey}=${v}`;
	}).join(';');
}

export function decodeStyleMap(encoded: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!encoded) return result;
	const useLegacy = encoded.includes('|') && !encoded.includes(';');
	const pairSep = useLegacy ? '|' : ';';
	const kvSep = useLegacy ? ':' : '=';
	for (const pair of encoded.split(pairSep)) {
		const idx = pair.indexOf(kvSep);
		if (idx > 0) {
			const key = pair.slice(0, idx);
			const val = pair.slice(idx + 1);
			result[key] = val;
		}
	}
	return result;
}

export function getClampedBorderWidth(value: unknown, defaultValue = 2): number {
	if (value == null || value === '') return defaultValue;
	const numValue = typeof value === 'number' ? value : Number(value);
	if (Number.isNaN(numValue)) return defaultValue;
	return Math.max(1, Math.min(4, numValue));
}

export function getCompleteStyleMap(
	styleMap: Record<string, string>,
	values: string[],
	palette: string[],
): { styleMap: Record<string, string>; changed: boolean } {
	let changed = false;
	const next = { ...styleMap };
	values.forEach((value, index) => {
		if (!next[value]) {
			next[value] = palette[index % palette.length];
			changed = true;
		}
	});
	return { styleMap: next, changed };
}
