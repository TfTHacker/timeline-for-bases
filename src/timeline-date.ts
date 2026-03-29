export function localMidnight(date: Date): Date {
	const result = new Date(date);
	result.setHours(0, 0, 0, 0);
	return result;
}

export function addCalendarDays(date: Date, days: number): Date {
	const result = new Date(date);
	result.setDate(result.getDate() + days);
	result.setHours(0, 0, 0, 0);
	return result;
}

export function diffCalendarDays(start: Date, end: Date): number {
	const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
	const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
	return Math.round((endUtc - startUtc) / 86400000);
}

export function formatCalendarDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

export function parseCalendarDateString(text: string): Date | null {
	const trimmed = text.trim();

	const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
	if (isoMatch) {
		return buildValidatedLocalDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
	}

	const slashYmdMatch = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[T\s].*)?$/);
	if (slashYmdMatch) {
		return buildValidatedLocalDate(Number(slashYmdMatch[1]), Number(slashYmdMatch[2]), Number(slashYmdMatch[3]));
	}

	const slashMdyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s].*)?$/);
	if (slashMdyMatch) {
		return buildValidatedLocalDate(Number(slashMdyMatch[3]), Number(slashMdyMatch[1]), Number(slashMdyMatch[2]));
	}

	return null;
}

export function parseRawFrontmatterDate(raw: unknown): Date | null {
	if (raw == null || raw === '' || raw === false) return null;
	if (raw instanceof Date) return localMidnight(raw);
	if (typeof raw === 'number') {
		if (!Number.isFinite(raw)) return null;
		return localMidnight(new Date(raw));
	}
	if (typeof raw === 'string') return parseCalendarDateString(raw);
	return null;
}

function buildValidatedLocalDate(year: number, month: number, day: number): Date | null {
	const result = new Date(year, month - 1, day);
	if (
		result.getFullYear() !== year ||
		result.getMonth() !== month - 1 ||
		result.getDate() !== day
	) {
		return null;
	}
	result.setHours(0, 0, 0, 0);
	return result;
}
