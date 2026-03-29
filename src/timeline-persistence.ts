export function makeScopedViewKey(baseFile: string | null, viewName: string | null): string | null {
	if (!baseFile || !viewName) return null;
	return `${baseFile}::${viewName}`;
}

export function findScopedViewName<T>(records: Record<string, T>, baseFile: string | null): string | null {
	if (!baseFile) return null;
	const prefix = `${baseFile}::`;
	const match = Object.keys(records).find(key => key.startsWith(prefix));
	return match ? match.slice(prefix.length) : null;
}

export function getScopedRecord<T>(records: Record<string, T>, baseFile: string | null, viewName: string | null): T | null {
	const key = makeScopedViewKey(baseFile, viewName);
	if (!key) return null;
	return records[key] ?? null;
}
